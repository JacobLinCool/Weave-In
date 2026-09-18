import { emptyAgentRoom, LEASE_MS, type AgentRoomState } from '../src/agents/contracts';
import { applyAgentCommand, reconcileAgents, type AgentMember } from '../src/agents/room';
import { initializeLive } from './live';
import { reviewGroup } from './group-review';
import { privateAnalysis } from './private-analysis';
import { issueIceServers } from './ice-servers';
import { DurableObject } from 'cloudflare:workers';
import { GEMINI_MODEL, OPENAI_MODEL, type TranscriptionProvider } from '@weave-in/transcribe';
import {
  MAX_PARTICIPANTS,
  MAX_SIGNAL_FRAME_BYTES,
  PEER_ID_PATTERN,
  ROOM_CODE_PATTERN,
  normalizeDisplayName,
  parseClientMessage,
  type PeerIdentity,
  type ServerMessage,
} from '../src/protocol';

export interface Env {
  ROOMS: DurableObjectNamespace<MeetingRoom>;
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
  /** Optional: force `gemini` or `openai` when both keys are configured. */
  TRANSCRIPTION_PROVIDER?: string;
  TOKEN_RATE_LIMITER: RateLimit;
  ANALYSIS_RATE_LIMITER: RateLimit;
  TURN_KEY_ID?: string;
  TURN_KEY_SECRET?: string;
  ICE_RATE_LIMITER: RateLimit;
}

interface SocketAttachment extends PeerIdentity, AgentMember { startedAt: number; sessionToken: string; liveRequests: number[] }

const GEMINI_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const OPENAI_TOKEN_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';
const TOKEN_LIFETIME_MS = 12 * 60 * 1_000;
const NEW_SESSION_LIFETIME_MS = 60 * 1_000;
// Clients already send agent-heartbeat while in a meeting, even with no agents.
// Allow background timer throttling before retiring an unresponsive connection.
const ROOM_CONNECTION_IDLE_MS = 90_000;

interface SelectedProvider {
  provider: TranscriptionProvider;
  apiKey: string;
}

type UpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/ice-servers') return issueIceServers(request, env);
    if (url.pathname === '/api/private-analysis') return privateAnalysis(request, env);
    if (url.pathname === '/api/transcription-token') {
      return issueTranscriptionToken(request, env);
    }
    const match = /^\/api\/rooms\/([A-Z0-9]{6})\/(connect|agents\/[\w-]{1,64}\/(?:live|review))$/u.exec(url.pathname);
    if (match) {
      const code = match[1];
      if (!code || !ROOM_CODE_PATTERN.test(code)) return jsonError('INVALID_ROOM', 400);
      if (match[2] === 'connect' && request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonError('WEBSOCKET_REQUIRED', 426);
      }
      if (request.headers.get('Origin') !== url.origin) return jsonError('INVALID_ORIGIN', 403);
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      const response = await room.fetch(request);
      if (match[2] === 'connect' && (response.status === 400 || response.status === 409)) {
        return roomAdmissionError(response);
      }
      return response;
    }
    if (url.pathname.startsWith('/api/rooms/')) return jsonError('INVALID_ROOM', 400);

    const assetResponse = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetResponse, url);
  },
} satisfies ExportedHandler<Env>;

/** Picks the transcription provider from the configured secrets: an explicit
 * `TRANSCRIPTION_PROVIDER` wins, otherwise Gemini is preferred over OpenAI. */
export function resolveTranscriptionProvider(env: Env): SelectedProvider | null {
  const gemini = env.GEMINI_API_KEY?.trim();
  const openai = env.OPENAI_API_KEY?.trim();
  const preferred = env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase();
  if (preferred === 'openai') return openai ? { provider: 'openai', apiKey: openai } : null;
  if (preferred === 'gemini') return gemini ? { provider: 'gemini', apiKey: gemini } : null;
  if (gemini) return { provider: 'gemini', apiKey: gemini };
  if (openai) return { provider: 'openai', apiKey: openai };
  return null;
}

export async function issueTranscriptionToken(
  request: Request,
  env: Env,
  upstreamFetch: UpstreamFetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') {
    return tokenError('METHOD_NOT_ALLOWED', 405, { Allow: 'POST' });
  }
  if (request.headers.get('Origin') !== url.origin) {
    return tokenError('INVALID_ORIGIN', 403);
  }
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    return tokenError('INVALID_CONTENT_TYPE', 415);
  }

  const clientAddress = request.headers.get('CF-Connecting-IP')
    ?? (isLocalHostname(url.hostname) ? 'local-development' : null);
  if (!clientAddress) return tokenError('CLIENT_ID_UNAVAILABLE', 400);
  let allowed: boolean;
  try {
    ({ success: allowed } = await env.TOKEN_RATE_LIMITER.limit({ key: clientAddress }));
  } catch {
    return tokenError('RATE_LIMIT_UNAVAILABLE', 503);
  }
  if (!allowed) return tokenError('RATE_LIMITED', 429, { 'Retry-After': '60' });

  const selected = resolveTranscriptionProvider(env);
  if (!selected) return tokenError('TOKEN_SERVICE_UNAVAILABLE', 503);

  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const upstreamRequest = selected.provider === 'gemini'
    ? geminiTokenRequest(selected.apiKey, now, expiresAt)
    : openAiTokenRequest(selected.apiKey);
  let upstream: Response;
  try {
    upstream = await upstreamFetch(upstreamRequest.url, upstreamRequest.init);
  } catch {
    return tokenError('TOKEN_PROVISIONING_FAILED', 502);
  }
  if (!upstream.ok) return tokenError('TOKEN_PROVISIONING_FAILED', 502);

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return tokenError('INVALID_TOKEN_RESPONSE', 502);
  }
  const token = readToken(payload, selected.provider === 'gemini' ? 'name' : 'value');
  if (!token) return tokenError('INVALID_TOKEN_RESPONSE', 502);
  return tokenJson({ ok: true, provider: selected.provider, token, expiresAt }, 200);
}

function geminiTokenRequest(apiKey: string, now: number, expiresAt: string): { url: string; init: RequestInit } {
  return {
    url: GEMINI_TOKEN_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(now + NEW_SESSION_LIFETIME_MS).toISOString(),
        fieldMask: 'model,generation_config.response_modalities',
        bidiGenerateContentSetup: {
          model: `models/${GEMINI_MODEL}`,
          generationConfig: { responseModalities: ['TEXT'] },
        },
      }),
    },
  };
}

function openAiTokenRequest(apiKey: string): { url: string; init: RequestInit } {
  return {
    url: OPENAI_TOKEN_ENDPOINT,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: Math.floor(TOKEN_LIFETIME_MS / 1_000) },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription: { model: OPENAI_MODEL, delay: 'minimal' },
              turn_detection: null,
            },
          },
        },
      }),
    },
  };
}

export class MeetingRoom extends DurableObject<Env> {
  #agents = emptyAgentRoom();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.#agents = await ctx.storage.get<AgentRoomState>('agents') ?? emptyAgentRoom(); });
  }
  async #publish(): Promise<void> {
    this.#pruneStaleSockets();
    const active = this.#activeSockets();
    if (!active.length) {
      this.#agents = emptyAgentRoom();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    reconcileAgents(this.#agents, active.map(({ attachment }) => attachment), Date.now(), () => crypto.randomUUID());
    await this.ctx.storage.put('agents', this.#agents);
    await this.ctx.storage.setAlarm(Date.now() + 10_000);
    if (!this.#agents.agents.length && !active.some(({ attachment }) => attachment.ready)) return;
    for (const { socket, attachment } of active) {
      const state: AgentRoomState = { ...this.#agents, agents: this.#agents.agents.map((agent) => agent.config.kind === 'personal' && agent.owner !== attachment.peerId
        ? { ...agent, config: { ...agent.config, instructions: '', source: 'none', chat: false, system: false, screen: false, files: false } } : agent) };
      this.#send(socket, { type: 'agent-state', state, serverNow: Date.now() });
    }
  }
  override async alarm(): Promise<void> { await this.#publish(); }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/live') || url.pathname.endsWith('/review')) {
      const reviewing = url.pathname.endsWith('/review');
      if (request.method !== 'POST') return jsonError('METHOD_NOT_ALLOWED', 405);
      if (request.headers.get('Origin') !== url.origin) return jsonError('INVALID_ORIGIN', 403);
      const member = this.#activeSockets().find(({ attachment }) => attachment.sessionToken === request.headers.get('X-Room-Token'));
      if (!member) return jsonError('NOT_A_ROOM_MEMBER', 403);
      const id = url.pathname.split('/').at(-2);
      const agent = this.#agents.agents.find((entry) => entry.id === id);
      if (!agent || agent.runner !== member.attachment.peerId || (agent.config.kind === 'group' && (agent.leaseUntil <= Date.now() || !['preparing', 'speaking'].includes(agent.phase)))) return jsonError('NOT_AGENT_RUNNER', 403);
      if (reviewing && (agent.config.kind !== 'group' || agent.phase !== 'preparing')) return jsonError('NOT_AGENT_RUNNER', 403);
      const key = (reviewing ? this.env.TYPESAFE_API_KEY : this.env.OPENAI_API_KEY)?.trim();
      if (!key) return reviewing
        ? Response.json({ error: 'Jev detection is unavailable: configure TYPESAFE_API_KEY.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
        : jsonError('GPT_LIVE_UNAVAILABLE', 503);
      const now = Date.now();
      const recent = member.attachment.liveRequests.filter((at) => at > now - 60_000);
      if (recent.length >= 6) return jsonError('RATE_LIMITED', 429);
      member.attachment.liveRequests = [...recent, now];
      member.socket.serializeAttachment(member.attachment);
      if (reviewing) return reviewGroup(request, structuredClone(agent), this.#activeSockets().map(({ attachment }) => ({ peerId: attachment.peerId, name: attachment.name })), key);
      return initializeLive(request, structuredClone(agent), key);
    }
    const action = url.searchParams.get('action');
    const rawName = url.searchParams.get('name') ?? '';
    const peerId = url.searchParams.get('peerId') ?? '';
    const name = normalizeDisplayName(rawName);
    if (action !== 'create' && action !== 'join') return jsonError('INVALID_ACTION', 400);
    if (!name) return jsonError('INVALID_NAME', 400);
    if (!PEER_ID_PATTERN.test(peerId)) return jsonError('INVALID_PEER', 400);

    const expired = this.#pruneStaleSockets();
    const active = this.#activeSockets();
    if (action === 'create' && active.length !== 0) return jsonError('ROOM_EXISTS', 409);
    const host = active.find(({ attachment }) => attachment.isHost);
    // Admission is synchronous: the first arrival claims an empty/hostless room,
    // and subsequent arrivals see its accepted socket and join as guests.
    const isHost = action === 'create' || !host;
    const startedAt = host?.attachment.startedAt ?? active[0]?.attachment.startedAt
      ?? expired.find((peer) => peer.peerId === peerId)?.startedAt ?? Date.now();
    if (active.length >= MAX_PARTICIPANTS) return jsonError('ROOM_FULL', 409);
    if (active.some(({ attachment }) => attachment.peerId === peerId)) {
      return jsonError('DUPLICATE_PEER', 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const identity: SocketAttachment = { peerId, name, startedAt, isHost, sessionToken: crypto.randomUUID(), joinedAt: Date.now(), heartbeat: Date.now(), ready: false, groupReady: false, liveRequests: [] };
    server.serializeAttachment(identity);
    this.ctx.acceptWebSocket(server, [`peer:${peerId}`]);

    const peers = active.map(({ attachment }) => publicIdentity(attachment));
    this.#send(server, { type: 'welcome', self: publicIdentity(identity), peers, startedAt, serverTime: Date.now(), sessionToken: identity.sessionToken });
    this.#broadcast({ type: 'peer-joined', peer: publicIdentity(identity) }, peerId);
    await this.#publish();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      socket.close(1008, 'Missing peer attachment');
      return;
    }
    const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
    if (new TextEncoder().encode(text).byteLength > MAX_SIGNAL_FRAME_BYTES) {
      this.#send(socket, { type: 'error', code: 'FRAME_TOO_LARGE', message: 'Signaling frame exceeds 64 KiB.' });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.#send(socket, { type: 'error', code: 'INVALID_SIGNAL', message: 'Signaling frame is not valid JSON.' });
      return;
    }
    const message = parseClientMessage(raw);
    if (!message) {
      this.#send(socket, { type: 'error', code: 'INVALID_SIGNAL', message: 'Signaling message is invalid.' });
      return;
    }
    attachment.heartbeat = Date.now();
    socket.serializeAttachment(attachment);
    if (message.type !== 'signal') {
      try {
        applyAgentCommand(this.#agents, attachment, message, Date.now(), () => crypto.randomUUID());
        socket.serializeAttachment(attachment);
        await this.#publish();
      } catch (error) { this.#send(socket, { type: 'error', code: 'AGENT_REJECTED', message: error instanceof Error ? error.message : 'Agent command failed.' }); }
      return;
    }
    const target = this.#activeSockets().find(({ attachment: peer }) => peer.peerId === message.target);
    if (!target) {
      this.#send(socket, { type: 'error', code: 'PEER_NOT_FOUND', message: 'The signaling target is not in this room.' });
      return;
    }
    this.#send(target.socket, {
      type: 'signal',
      from: attachment.peerId,
      kind: message.kind,
      payload: message.payload,
    });
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    const attachment = readAttachment(socket);
    // Reserved status codes describe local failures and cannot be sent in a
    // close frame. Echoing 1006 throws before peers can be notified of departure.
    const reserved = [1004, 1005, 1006, 1015].includes(code);
    socket.close(reserved ? 1000 : code, reserved ? '' : reason);
    if (!attachment) return;
    this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
    this.ctx.waitUntil(this.#publish());
    void wasClean;
  }

  override webSocketError(socket: WebSocket): void {
    const attachment = readAttachment(socket);
    if (attachment) this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
    socket.close(1011, 'Signaling socket error');
    this.ctx.waitUntil(this.#publish());
  }

  #activeSockets(): Array<{ socket: WebSocket; attachment: SocketAttachment }> {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = readAttachment(socket);
      return attachment && socket.readyState === WebSocket.OPEN ? [{ socket, attachment }] : [];
    });
  }

  #pruneStaleSockets(): SocketAttachment[] {
    const expired = this.#activeSockets().filter(({ attachment }) =>
      Date.now() - attachment.heartbeat > ROOM_CONNECTION_IDLE_MS);
    for (const { socket } of expired) {
      // Invalidate before closing so a delayed close/message from this socket
      // cannot announce that a replacement using the same peer ID has left.
      socket.serializeAttachment(null);
      socket.close(4000, 'Connection timed out');
    }
    for (const { attachment } of expired) {
      this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
    }
    return expired.map(({ attachment }) => attachment);
  }

  #broadcast(message: ServerMessage, excludedPeerId?: string): void {
    for (const { socket, attachment } of this.#activeSockets()) {
      if (attachment.peerId !== excludedPeerId) this.#send(socket, message);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, 'Unable to deliver signaling message');
    }
  }
}

function readAttachment(socket: WebSocket): SocketAttachment | null {
  const value = socket.deserializeAttachment();
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SocketAttachment>;
  if (
    typeof candidate.peerId !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.isHost !== 'boolean' ||
    typeof candidate.startedAt !== 'number' ||
    !Number.isSafeInteger(candidate.startedAt) ||
    candidate.startedAt <= 0
  ) return null;
  return candidate as SocketAttachment;
}

function jsonError(code: string, status: number): Response {
  return Response.json({ ok: false, code }, { status });
}

/** Browsers hide HTTP error bodies from WebSocket clients. Deliver admission
 * errors over a short-lived socket, without registering a room participant. */
async function roomAdmissionError(response: Response): Promise<Response> {
  const { code } = await response.clone().json<{ code: string }>();
  const messages: Record<string, string> = {
    INVALID_ACTION: 'This room link is invalid. Reload the page and try again.',
    INVALID_NAME: 'Enter a display name before joining.',
    INVALID_PEER: 'Your meeting identity is invalid. Reload the page and try again.',
    ROOM_EXISTS: 'This room already exists. Join it or create another room.',
    ROOM_FULL: `This room is full (${MAX_PARTICIPANTS} people). Try again after someone leaves.`,
    DUPLICATE_PEER: 'You are already connected to this room. Close the other meeting tab or wait a moment and try again.',
  };
  const message = messages[code];
  if (!message) return response;
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  server.send(JSON.stringify({ type: 'error', code, message } satisfies ServerMessage));
  server.close(1008, code);
  return new Response(null, { status: 101, webSocket: client });
}

function tokenError(code: string, status: number, extraHeaders: HeadersInit = {}): Response {
  return tokenJson({ ok: false, code }, status, extraHeaders);
}

function tokenJson(body: object, status: number, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(body, { status, headers });
}

function readToken(value: unknown, field: 'name' | 'value'): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return token.length >= 16 && token.length <= 2_048 ? token : null;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function withSecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  const isLocalDevelopment = isLocalHostname(url.hostname);
  const isHtml = headers.get('Content-Type')?.includes('text/html');
  const isAboutPage = url.pathname === '/about' || url.pathname === '/about/';
  headers.set(
    'Content-Security-Policy',
    isLocalDevelopment
      ? "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss://generativelanguage.googleapis.com https://api.openai.com; font-src 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'"
      : "default-src 'self'; base-uri 'none'; connect-src 'self' wss://generativelanguage.googleapis.com https://api.openai.com; font-src 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );

  headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  );
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  if (isHtml && (url.searchParams.has('room') || (url.pathname !== '/' && !isAboutPage))) {
    headers.set('X-Robots-Tag', 'noindex, follow');
  }
  const securedResponse = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (!isHtml || !isAboutPage) return securedResponse;

  const title = 'About Weave In';
  const canonical = 'https://weave.nycu.ai/about';
  const description = 'Why we built Weave In: independent thinking, private conversations with Muse, teamwork with Omni, and shared work through Codex and WebMCP.';
  return new HTMLRewriter()
    .on('title', { element: (element) => { element.setInnerContent(title); } })
    .on('link[rel="canonical"]', { element: (element) => { element.setAttribute('href', canonical); } })
    .on('meta', {
      element(element) {
        const name = element.getAttribute('name') ?? element.getAttribute('property');
        if (name === 'og:url') element.setAttribute('content', canonical);
        if (name === 'og:title' || name === 'twitter:title') element.setAttribute('content', title);
        if (name === 'description' || name === 'og:description' || name === 'twitter:description') {
          element.setAttribute('content', description);
        }
      },
    })
    .transform(securedResponse);
}

function publicIdentity(value: PeerIdentity): PeerIdentity { return { peerId: value.peerId, name: value.name, isHost: value.isHost }; }
