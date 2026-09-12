import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { issueTranscriptionToken, resolveTranscriptionProvider, type Env, type MeetingRoom } from '../worker';
import type { ServerMessage } from '../src/protocol';

interface ConnectedPeer {
  socket: WebSocket;
  welcome: Extract<ServerMessage, { type: 'welcome' }>;
}

const sockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close(1000, 'Test complete');
});

describe('MeetingRoom Durable Object', () => {
  it.each([1004, 1005, 1006, 1015, 1000, 4001])('handles close status %i and still notifies peers', async (code) => {
    const stub = room(`CL${code}`);
    const host = await connect(stub, 'create', 'Host', peerId(60));
    const joined = nextMessage(host.socket);
    const guest = await connect(stub, 'join', 'Guest', peerId(61));
    await joined;
    const departed = nextMessage(guest.socket);
    const closed = new Promise<CloseEvent>((resolve) => host.socket.addEventListener('close', resolve, { once: true }));
    await runInDurableObject(stub, (instance, state) => {
      const socket = state.getWebSockets().find((candidate) => candidate.deserializeAttachment()?.peerId === peerId(60));
      if (!socket) throw new Error('Host socket missing');
      instance.webSocketClose(socket, code, 'Disconnected', false);
    });
    expect((await closed).code).toBe([1004, 1005, 1006, 1015].includes(code) ? 1000 : code);
    await expect(departed).resolves.toMatchObject({ type: 'peer-left', peerId: peerId(60) });
  });

  it('serves the app with camera, microphone, and screen-capture permission headers', async () => {
    const response = await worker.fetch(
      new Request('https://demo.example/'),
      {
        ROOMS: env.ROOMS,
        ASSETS: {
          fetch: async () => new Response('<!doctype html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
        } as unknown as Fetcher,
        GEMINI_API_KEY: 'test-server-key',
        TOKEN_RATE_LIMITER: allowingRateLimiter(),
        ANALYSIS_RATE_LIMITER: allowingRateLimiter(),
      } satisfies Env,
    );
    expect(response.headers.get('Permissions-Policy')).toContain('display-capture=(self)');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
  });

  it('rejects malformed room routes and cross-origin WebSocket upgrades', async () => {
    const malformed = await SELF.fetch('https://demo.example/api/rooms/lower/connect');
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ ok: false, code: 'INVALID_ROOM' });

    const crossOrigin = await SELF.fetch(new Request(
      `https://demo.example/api/rooms/ORIGIN/connect?action=create&name=Host&peerId=${peerId(0)}`,
      { headers: { Upgrade: 'websocket', Origin: 'https://attacker.example' } },
    ));
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({ ok: false, code: 'INVALID_ORIGIN' });
  });

  it('keeps invitation URLs out of search results without blocking social previews', async () => {
    const previewHtml = '<html><head><meta property="og:title" content="Weave In"></head></html>';
    const assetEnv = {
      ...tokenEnv(),
      ASSETS: { fetch: async () => new Response(previewHtml, { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher,
    };
    const home = await worker.fetch(new Request('https://weave.nycu.ai/'), assetEnv);
    expect(home.headers.get('X-Robots-Tag')).toBeNull();
    for (const path of ['/?room=ABC123', '/nonexistent']) {
      const page = await worker.fetch(new Request(`https://weave.nycu.ai${path}`), assetEnv);
      expect(page.headers.get('X-Robots-Tag')).toBe('noindex, follow');
      expect(await page.text()).toBe(previewHtml);
    }
  });

  it('opens an empty invitation as host through the public WebSocket route', async () => {
    const response = await SELF.fetch(new Request(
      `https://demo.example/api/rooms/GONE99/connect?action=join&name=Guest&peerId=${peerId(99)}`,
      { headers: { Upgrade: 'websocket', Origin: 'https://demo.example' } },
    ));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    sockets.push(socket);
    const message = new Promise<ServerMessage>((resolve) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as ServerMessage), { once: true });
    });
    socket.accept();
    await expect(message).resolves.toMatchObject({ type: 'welcome', self: { isHost: true }, peers: [] });
  });

  it('elects only the first invite arrival as host and rejects a second create', async () => {
    const stub = room('CREATE');
    const [first, second] = await Promise.all([
      connect(stub, 'join', 'First guest', peerId(1)),
      connect(stub, 'join', 'Second guest', peerId(2)),
    ]);
    expect([first, second].filter((peer) => peer.welcome.self.isHost)).toHaveLength(1);
    expect(first.welcome.startedAt).toBe(second.welcome.startedAt);
    expect((await connectResponse(stub, 'create', 'Other host', peerId(3))).status).toBe(409);
  });

  it('caps the room at eight participants', async () => {
    const stub = room('LIMIT5');
    await connect(stub, 'create', 'Host', peerId(10));
    for (let index = 1; index < 8; index += 1) {
      await connect(stub, 'join', `Guest ${index}`, peerId(10 + index));
    }
    const rejected = await connectResponse(stub, 'join', 'Ninth', peerId(19));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ ok: false, code: 'ROOM_FULL' });
  });

  it('shares the room start time with late joiners after hibernation', async () => {
    const stub = room('TIMING');
    const before = Date.now();
    const host = await connect(stub, 'create', 'Host', peerId(50));
    expect(host.welcome.startedAt).toBeGreaterThanOrEqual(before);
    expect(host.welcome.startedAt).toBeLessThanOrEqual(Date.now());
    expect(host.welcome.serverTime).toBeGreaterThanOrEqual(host.welcome.startedAt);
    await evictDurableObject(stub);
    const guest = await connect(stub, 'join', 'Late guest', peerId(51));
    expect(guest.welcome.startedAt).toBe(host.welcome.startedAt);
    expect(guest.welcome.serverTime).toBeGreaterThanOrEqual(host.welcome.serverTime);
  });

  it('isolates rooms and rejects signals to absent peers', async () => {
    const alpha = room('ALPHA1');
    const beta = room('BETA22');
    const sender = await connect(alpha, 'create', 'Alpha host', peerId(20));
    await connect(beta, 'create', 'Beta host', peerId(21));
    const errorPromise = nextMessage(sender.socket);
    sender.socket.send(JSON.stringify({
      type: 'signal',
      target: peerId(21),
      kind: 'ice',
      payload: { candidate: 'candidate:test' },
    }));
    await expect(errorPromise).resolves.toMatchObject({ type: 'error', code: 'PEER_NOT_FOUND' });
  });

  it('routes validated signaling and survives hibernation', async () => {
    const stub = room('HIBERN');
    const host = await connect(stub, 'create', 'Host', peerId(30));
    const hostJoined = nextMessage(host.socket);
    const guest = await connect(stub, 'join', 'Guest', peerId(31));
    await expect(hostJoined).resolves.toMatchObject({ type: 'peer-joined' });
    await evictDurableObject(stub);

    const incoming = nextMessage(guest.socket);
    host.socket.send(JSON.stringify({
      type: 'signal',
      target: peerId(31),
      kind: 'offer',
      payload: { type: 'offer', sdp: 'v=0' },
    }));
    await expect(incoming).resolves.toEqual({
      type: 'signal',
      from: peerId(30),
      kind: 'offer',
      payload: { type: 'offer', sdp: 'v=0' },
    });
  });

  it('arbitrates concurrent Group creation, preserves its epoch across hibernation and fences session initialization', async () => {
    const stub = room('AGENTS');
    const host = await connect(stub, 'create', 'Host', peerId(50));
    const guest = await connect(stub, 'join', 'Guest', peerId(51));
    expect(JSON.stringify(guest.welcome.peers)).not.toContain(host.welcome.sessionToken);
    const messages: ServerMessage[] = [];
    host.socket.addEventListener('message', (event) => { messages.push(JSON.parse(String(event.data)) as ServerMessage); });
    guest.socket.addEventListener('message', (event) => { messages.push(JSON.parse(String(event.data)) as ServerMessage); });
    host.socket.send(JSON.stringify({ type: 'agent-ready', ready: true }));
    guest.socket.send(JSON.stringify({ type: 'agent-ready', ready: true }));
    await vi.waitFor(() => expect(messages.filter((m) => m.type === 'agent-state').length).toBeGreaterThanOrEqual(2));
    const config = { kind: 'group', name: 'Group', instructions: 'Think with the room', language: 'auto', source: 'all', chat: true, system: true, screen: false, files: false, audience: 'public' };
    host.socket.send(JSON.stringify({ type: 'agent-create', config }));
    guest.socket.send(JSON.stringify({ type: 'agent-create', config }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'error')).toBe(true));
    const states = messages.filter((m) => m.type === 'agent-state');
    const group = states.at(-1)?.state.agents[0];
    expect(group).toBeDefined();
    expect(states.every((m) => m.state.agents.length <= 1)).toBe(true);
    if (!group) throw new Error('Group missing');
    const foreign = group.runner === host.welcome.self.peerId ? guest : host;
    const init = (token: string) => stub.fetch(new Request(`https://room.invalid/agents/${group.id}/live`, { method: 'POST', headers: { Origin: 'https://room.invalid', 'X-Room-Token': token, 'Content-Type': 'application/json' }, body: '{}' }));
    for (const token of ['invented-token', foreign.welcome.sessionToken]) {
      const response = await init(token);
      expect(response.status).toBe(403);
      await response.text(); // Drain the request before asking the runtime to hibernate.
    }
    await evictDurableObject(stub);
    messages.length = 0;
    host.socket.send(JSON.stringify({ type: 'agent-heartbeat' }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'agent-state')).toBe(true));
    expect(messages.find((m) => m.type === 'agent-state')?.state.agents[0]).toMatchObject({ id: group.id, epoch: group.epoch });
  });

  it('makes the next arrival host when the original host leaves but guests remain', async () => {
    const stub = room('REHOST');
    const host = await connect(stub, 'create', 'Host', peerId(60));
    const guest = await connect(stub, 'join', 'Guest', peerId(61));
    const left = nextMessage(guest.socket);
    await closeSocket(host.socket);
    await expect(left).resolves.toMatchObject({ type: 'peer-left', peerId: peerId(60) });
    const replacement = await connect(stub, 'join', 'Replacement host', peerId(62));
    expect(replacement.welcome.self.isHost).toBe(true);
    expect(replacement.welcome.startedAt).toBe(host.welcome.startedAt);
    expect(replacement.welcome.peers.map((peer) => peer.peerId)).toEqual([peerId(61)]);
    const later = await connect(stub, 'join', 'Later guest', peerId(63));
    expect(later.welcome.self.isHost).toBe(false);
  });

  it('reopens the same invite as a new meeting after the final peer disconnects', async () => {
    const stub = room('EMPTY1');
    const host = await connect(stub, 'create', 'Host', peerId(40));
    await closeSocket(host.socket);
    const reopened = await connect(stub, 'join', 'New host', peerId(41));
    expect(reopened.welcome.self.isHost).toBe(true);
    expect(reopened.welcome.peers).toEqual([]);
    expect(reopened.welcome.startedAt).toBeGreaterThanOrEqual(host.welcome.startedAt);
  });
});

describe('transcription token endpoint', () => {
  it('mints one constrained, short-lived Gemini token without exposing the server key', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const response = await issueTranscriptionToken(
      tokenRequest(),
      tokenEnv(),
      async (input, init) => {
        requests.push({ input, ...(init ? { init } : {}) });
        return Response.json({ name: 'ephemeral-test-token-value' });
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({
      ok: true,
      provider: 'gemini',
      token: 'ephemeral-test-token-value',
    });
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens');
    expect(new Headers(requests[0]?.init?.headers).get('x-goog-api-key')).toBe('test-server-key');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      uses: 1,
      fieldMask: 'model,generation_config.response_modalities',
      bidiGenerateContentSetup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
      },
    });
    expect(JSON.stringify(responseBody)).not.toContain('test-server-key');
  });

  it('mints an OpenAI client secret when only an OpenAI key is configured', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const response = await issueTranscriptionToken(
      tokenRequest(),
      tokenEnv(allowingRateLimiter(), { GEMINI_API_KEY: undefined, OPENAI_API_KEY: 'openai-server-key' }),
      async (input, init) => {
        requests.push({ input, ...(init ? { init } : {}) });
        return Response.json({ value: 'ek_openai-ephemeral-secret', expires_at: 1 });
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, provider: 'openai', token: 'ek_openai-ephemeral-secret' });
    expect(String(requests[0]?.input)).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer openai-server-key');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      session: { type: 'transcription', audio: { input: { transcription: { model: 'gpt-live-transcribe', delay: 'minimal' }, turn_detection: null } } },
    });
  });

  it('prefers the configured provider and reports when none is configured', async () => {
    expect(resolveTranscriptionProvider({ ...tokenEnv(), OPENAI_API_KEY: 'o' })?.provider).toBe('gemini');
    expect(resolveTranscriptionProvider({ ...tokenEnv(), OPENAI_API_KEY: 'o', TRANSCRIPTION_PROVIDER: 'openai' })?.provider).toBe('openai');
    expect(resolveTranscriptionProvider(tokenEnv(allowingRateLimiter(), { GEMINI_API_KEY: undefined }))).toBeNull();
    const response = await issueTranscriptionToken(
      tokenRequest(),
      tokenEnv(allowingRateLimiter(), { GEMINI_API_KEY: undefined }),
      async () => { throw new Error('must not provision'); },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, code: 'TOKEN_SERVICE_UNAVAILABLE' });
  });

  it('rejects cross-origin and rate-limited requests before provisioning', async () => {
    const crossOrigin = await issueTranscriptionToken(
      tokenRequest({ Origin: 'https://attacker.example' }),
      tokenEnv(),
      async () => { throw new Error('must not provision'); },
    );
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({ ok: false, code: 'INVALID_ORIGIN' });

    const rateLimited = await issueTranscriptionToken(
      tokenRequest(),
      tokenEnv(denyingRateLimiter()),
      async () => { throw new Error('must not provision'); },
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get('Retry-After')).toBe('60');
  });

  it('returns a stable error without relaying Gemini response details', async () => {
    const response = await issueTranscriptionToken(
      tokenRequest(),
      tokenEnv(),
      async () => Response.json(
        { error: { message: 'upstream detail containing test-server-key' } },
        { status: 400 },
      ),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ ok: false, code: 'TOKEN_PROVISIONING_FAILED' });
  });
});

function room(code: string): DurableObjectStub<MeetingRoom> {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

async function connect(
  stub: DurableObjectStub<MeetingRoom>,
  action: 'create' | 'join',
  name: string,
  id: string,
): Promise<ConnectedPeer> {
  const response = await connectResponse(stub, action, name, id);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected a WebSocket upgrade response.');
  sockets.push(socket);
  const welcomePromise = nextMessage(socket);
  socket.accept();
  return { socket, welcome: await welcomePromise as ConnectedPeer['welcome'] };
}

function connectResponse(
  stub: DurableObjectStub<MeetingRoom>,
  action: 'create' | 'join',
  name: string,
  id: string,
): Promise<Response> {
  const url = new URL('https://room.invalid/connect');
  url.searchParams.set('action', action);
  url.searchParams.set('name', name);
  url.searchParams.set('peerId', id);
  return stub.fetch(new Request(url, { headers: { Upgrade: 'websocket' } }));
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket message.')), 2_000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as ServerMessage);
    }, { once: true });
  });
}

function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close(1000, 'Leaving');
  });
}

function peerId(index: number): string {
  return `peer_${index.toString().padStart(12, '0')}`;
}

function tokenRequest(headers: HeadersInit = {}): Request {
  return new Request('https://demo.example/api/transcription-token', {
    method: 'POST',
    headers: {
      Origin: 'https://demo.example',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
      ...Object.fromEntries(new Headers(headers)),
    },
    body: '{}',
  });
}

function tokenEnv(
  rateLimiter: RateLimit = allowingRateLimiter(),
  overrides: { [K in keyof Env]?: Env[K] | undefined } = {},
): Env {
  const merged: Record<string, unknown> = {
    ROOMS: env.ROOMS,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) } as unknown as Fetcher,
    GEMINI_API_KEY: 'test-server-key',
    TOKEN_RATE_LIMITER: rateLimiter,
    ANALYSIS_RATE_LIMITER: rateLimiter,
    ...overrides,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as Env;
}

function allowingRateLimiter(): RateLimit {
  return { limit: async () => ({ success: true }) } as RateLimit;
}

function denyingRateLimiter(): RateLimit {
  return { limit: async () => ({ success: false }) } as RateLimit;
}
