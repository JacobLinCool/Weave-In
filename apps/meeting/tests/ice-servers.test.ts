import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../worker';
import { issueIceServers, parseIceServers } from '../worker/ice-servers';

const TURN_KEY_SECRET = 'private-server-turn-key';
const credentials = { username: 'temporary-username', credential: 'temporary-password' };
const cloudflareResponse = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:53?transport=tcp',
      ],
      ...credentials,
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TURN credential endpoint', () => {
  it('provisions temporary credentials and preserves UDP, TCP, and TLS URLs except port 53', async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({
      ...cloudflareResponse,
      secret: TURN_KEY_SECRET,
    }));
    const before = Date.now();
    const response = await issueIceServers(iceRequest(), iceEnv(), upstream);
    expect(response.status).toBe(200);
    expectPrivateHeaders(response);
    const body = await response.json() as { iceServers: RTCIceServer[]; expiresAt: number };
    expect(body).toEqual({
      ok: true,
      iceServers: [
        cloudflareResponse.iceServers[0],
        { urls: cloudflareResponse.iceServers[1]!.urls.slice(0, 5), ...credentials },
      ],
      expiresAt: expect.any(Number),
    });
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 86_400_000);
    expect(JSON.stringify(body)).not.toContain(TURN_KEY_SECRET);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0]!;
    expect(String(url)).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/test-key-id/credentials/generate-ice-servers');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TURN_KEY_SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ ttl: 86_400 });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('routes the API path to provisioning instead of serving the SPA', async () => {
    const assets = vi.fn(async () => new Response('SPA'));
    const environment = iceEnv({ ASSETS: { fetch: assets } as unknown as Fetcher });
    delete environment.TURN_KEY_SECRET;
    const response = await worker.fetch(iceRequest(), environment);
    await expectError(response, 503, 'ICE_SERVICE_UNAVAILABLE');
    expect(assets).not.toHaveBeenCalled();
  });

  it.each(['TURN_KEY_ID', 'TURN_KEY_SECRET'] as const)('requires the server-side %s', async (key) => {
    const upstream = vi.fn<typeof fetch>();
    for (const value of [undefined, '', '  ']) {
      const environment = iceEnv();
      if (value === undefined) delete environment[key];
      else environment[key] = value;
      await expectError(await issueIceServers(iceRequest(), environment, upstream), 503, 'ICE_SERVICE_UNAVAILABLE');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 405, 'METHOD_NOT_ALLOWED'],
    ['OPTIONS', 405, 'METHOD_NOT_ALLOWED'],
  ] as const)('rejects %s before provisioning', async (method, status, code) => {
    const upstream = vi.fn<typeof fetch>();
    const response = await issueIceServers(iceRequest({ method }), iceEnv(), upstream);
    await expectError(response, status, code);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [{ Origin: 'https://attacker.example' }, 403, 'INVALID_ORIGIN'],
    [{ Origin: '' }, 403, 'INVALID_ORIGIN'],
    [{ 'Content-Type': 'text/plain' }, 415, 'INVALID_CONTENT_TYPE'],
  ] as const)('rejects invalid request headers %j', async (headers, status, code) => {
    const upstream = vi.fn<typeof fetch>();
    await expectError(await issueIceServers(iceRequest({ headers }), iceEnv(), upstream), status, code);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['[]', 'null', 'true', '{', '{"ttl":999999}'])('rejects invalid request body %s', async (body) => {
    const upstream = vi.fn<typeof fetch>();
    await expectError(await issueIceServers(iceRequest({ body }), iceEnv(), upstream), 400, 'INVALID_INPUT');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bounds the request body before calling Cloudflare', async () => {
    const upstream = vi.fn<typeof fetch>();
    await expectError(
      await issueIceServers(iceRequest({ body: ' '.repeat(1_025) }), iceEnv(), upstream),
      413,
      'BODY_TOO_LARGE',
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('uses an independent per-IP rate limiter and reports unavailable and exhausted limits', async () => {
    const upstream = vi.fn<typeof fetch>();
    const limit = vi.fn(async () => ({ success: false }));
    const response = await issueIceServers(iceRequest(), iceEnv({ ICE_RATE_LIMITER: { limit } as RateLimit }), upstream);
    await expectError(response, 429, 'RATE_LIMITED');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(limit).toHaveBeenCalledExactlyOnceWith({ key: '203.0.113.10' });
    limit.mockRejectedValueOnce(new Error(TURN_KEY_SECRET));
    await expectError(
      await issueIceServers(iceRequest(), iceEnv({ ICE_RATE_LIMITER: { limit } as RateLimit }), upstream),
      503,
      'RATE_LIMIT_UNAVAILABLE',
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('uses the development identity only on localhost', async () => {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const limit = vi.fn(async () => ({ success: true }));
      const response = await issueIceServers(
        new Request(`http://${hostname}:5174/api/ice-servers`, {
          method: 'POST',
          headers: { Origin: `http://${hostname}:5174`, 'Content-Type': 'application/json; charset=utf-8' },
          body: '{}',
        }),
        iceEnv({ ICE_RATE_LIMITER: { limit } as RateLimit }),
        async () => Response.json(cloudflareResponse),
      );
      expect(response.status).toBe(200);
      expect(limit).toHaveBeenCalledExactlyOnceWith({ key: 'local-development' });
    }
    const request = iceRequest();
    request.headers.delete('CF-Connecting-IP');
    await expectError(await issueIceServers(request, iceEnv()), 400, 'CLIENT_ID_UNAVAILABLE');
    request.headers.set('CF-Connecting-IP', '');
    await expectError(await issueIceServers(request, iceEnv()), 400, 'CLIENT_ID_UNAVAILABLE');
  });

  it('does not share credentials across requests from the same IP', async () => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json(cloudflareResponse));
    await issueIceServers(iceRequest(), iceEnv(), upstream);
    await issueIceServers(iceRequest(), iceEnv(), upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429, 500])('does not reflect Cloudflare %i error details', async (status) => {
    await expectError(await issueIceServers(iceRequest(), iceEnv(), async () =>
      Response.json({ error: TURN_KEY_SECRET }, { status })), 502, 'ICE_PROVISIONING_FAILED');
  });

  it('does not expose network failure details', async () => {
    await expectError(await issueIceServers(iceRequest(), iceEnv(), async () => {
      throw new Error(TURN_KEY_SECRET);
    }), 502, 'ICE_PROVISIONING_FAILED');
  });

  it('bounds the total upstream deadline even if fetch does not settle on abort', async () => {
    vi.useFakeTimers();
    const upstream = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = issueIceServers(iceRequest(), iceEnv(), upstream);
    await vi.waitUntil(() => upstream.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(8_000);
    await expectError(await pending, 502, 'ICE_PROVISIONING_FAILED');
    expect(upstream.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes a stalled response body in the upstream deadline', async () => {
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
    })));
    const pending = issueIceServers(iceRequest(), iceEnv(), upstream);
    await vi.waitUntil(() => bodyController !== undefined);
    await vi.advanceTimersByTimeAsync(8_000);
    await expectError(await pending, 502, 'ICE_PROVISIONING_FAILED');
    bodyController?.close();
    expect(upstream.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not JSON', '{}', 'x'.repeat(32 * 1_024 + 1)])('rejects malformed or oversized upstream JSON', async (body) => {
    await expectError(await issueIceServers(iceRequest(), iceEnv(), async () => new Response(body)), 502, 'INVALID_ICE_RESPONSE');
  });
});

describe('Cloudflare ICE response validation', () => {
  it('removes only actual port 53, including standalone entries, and strips non-ICE fields', () => {
    expect(parseIceServers({ iceServers: [
      { urls: 'stun:stun.cloudflare.com:53' },
      { urls: 'turn:turn.cloudflare.com:53?transport=udp', ...credentials },
      { urls: ['turns:turn.cloudflare.com:5349?transport=tcp', 'turn:node53.example:3478'], ...credentials, secret: TURN_KEY_SECRET },
      { urls: 'stun:stun.cloudflare.com:3478', ...credentials },
    ], secret: TURN_KEY_SECRET })).toEqual([
      { urls: ['turns:turn.cloudflare.com:5349?transport=tcp', 'turn:node53.example:3478'], ...credentials },
      { urls: ['stun:stun.cloudflare.com:3478'] },
    ]);
  });

  it.each([
    null,
    [],
    { iceServers: [] },
    { iceServers: [null] },
    { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:53', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478' }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username: '', credential: 'temporary' }] },
    { iceServers: [{ urls: ['turn:turn.cloudflare.com:3478', 42], ...credentials }] },
    { iceServers: [{ urls: 'https://turn.cloudflare.com:3478', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:99999', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:0', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478?transport=invalid', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478/path', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478\n', ...credentials }] },
    { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478', username: 'a\nb', credential: 'temporary' }] },
    { iceServers: [{ urls: [], ...credentials }] },
  ])('rejects unusable response %#', (payload) => {
    expect(parseIceServers(payload)).toBeNull();
  });
});

function iceRequest(options: { method?: string; headers?: HeadersInit; body?: string } = {}): Request {
  const method = options.method ?? 'POST';
  const headers = new Headers({
    Origin: 'https://demo.example',
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '203.0.113.10',
  });
  for (const [name, value] of new Headers(options.headers)) headers.set(name, value);
  return new Request('https://demo.example/api/ice-servers', {
    method,
    headers,
    ...(method === 'POST' ? { body: options.body ?? '{}' } : {}),
  });
}

function iceEnv(overrides: Partial<Env> = {}): Env {
  const allow = { limit: async () => ({ success: true }) } as RateLimit;
  return {
    ROOMS: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response('SPA') } as unknown as Fetcher,
    TURN_KEY_ID: 'test-key-id',
    TURN_KEY_SECRET,
    TOKEN_RATE_LIMITER: allow,
    ANALYSIS_RATE_LIMITER: allow,
    ICE_RATE_LIMITER: allow,
    ...overrides,
  } as Env;
}

function expectPrivateHeaders(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expectPrivateHeaders(response);
  await expect(response.json()).resolves.toEqual({ ok: false, code });
}
