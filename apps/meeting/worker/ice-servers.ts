import type { Env } from './index';

const CREDENTIAL_LIFETIME_SECONDS = 86_400;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BYTES = 1_024;
const MAX_RESPONSE_BYTES = 32 * 1_024;
const ICE_URL = /^(stun|stuns|turn|turns):(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/iu;

type UpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Issues per-request, temporary credentials; the TURN key never leaves this Worker. */
export async function issueIceServers(
  request: Request,
  env: Env,
  upstreamFetch: UpstreamFetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST') return iceError('METHOD_NOT_ALLOWED', 405, { Allow: 'POST' });
  if (request.headers.get('Origin') !== url.origin) return iceError('INVALID_ORIGIN', 403);
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim() !== 'application/json') {
    return iceError('INVALID_CONTENT_TYPE', 415);
  }

  const clientAddress = request.headers.get('CF-Connecting-IP')
    ?? (url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? 'local-development' : null);
  if (!clientAddress) return iceError('CLIENT_ID_UNAVAILABLE', 400);
  try {
    if (!(await env.ICE_RATE_LIMITER.limit({ key: clientAddress })).success) {
      return iceError('RATE_LIMITED', 429, { 'Retry-After': '60' });
    }
  } catch {
    return iceError('RATE_LIMIT_UNAVAILABLE', 503);
  }

  let input: unknown;
  try {
    input = await readJson(request.body, MAX_REQUEST_BYTES);
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? iceError('BODY_TOO_LARGE', 413)
      : iceError('INVALID_INPUT', 400);
  }
  if (!isRecord(input) || Object.keys(input).length !== 0) return iceError('INVALID_INPUT', 400);

  const keyId = env.TURN_KEY_ID?.trim();
  const keySecret = env.TURN_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return iceError('ICE_SERVICE_UNAVAILABLE', 503);

  const controller = new AbortController();
  const issuedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(iceError('ICE_PROVISIONING_FAILED', 502));
    }, UPSTREAM_TIMEOUT_MS);
  });
  const provision = async (): Promise<Response> => {
    try {
      const upstream = await upstreamFetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keySecret}` },
          body: JSON.stringify({ ttl: CREDENTIAL_LIFETIME_SECONDS }),
          signal: controller.signal,
          redirect: 'error',
        },
      );
      if (!upstream.ok) {
        void upstream.body?.cancel().catch(() => {});
        return iceError('ICE_PROVISIONING_FAILED', 502);
      }
      const payload = await readJson(upstream.body, MAX_RESPONSE_BYTES);
      const iceServers = parseIceServers(payload);
      if (!iceServers) return iceError('INVALID_ICE_RESPONSE', 502);
      return iceJson({ ok: true, iceServers, expiresAt: issuedAt + CREDENTIAL_LIFETIME_SECONDS * 1_000 });
    } catch (error) {
      return iceError(
        error instanceof InvalidJsonError || error instanceof BodyTooLargeError
          ? 'INVALID_ICE_RESPONSE'
          : 'ICE_PROVISIONING_FAILED',
        502,
      );
    }
  };
  try {
    // The deadline covers response-body reads as well as the initial fetch.
    return await Promise.race([provision(), deadline]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** Accept only usable ICE configuration and remove browser-blocked port 53. */
export function parseIceServers(payload: unknown): RTCIceServer[] | null {
  if (!isRecord(payload) || !Array.isArray(payload['iceServers'])) return null;
  if (payload['iceServers'].length === 0 || payload['iceServers'].length > 16) return null;
  const result: RTCIceServer[] = [];
  let hasTurn = false;
  for (const entry of payload['iceServers']) {
    if (!isRecord(entry)) return null;
    const values = typeof entry['urls'] === 'string' ? [entry['urls']] : entry['urls'];
    if (!Array.isArray(values) || !values.length || values.length > 16) return null;
    const urls: string[] = [];
    let needsCredentials = false;
    for (const value of values) {
      if (typeof value !== 'string' || value.length > 2_048 || value.trim() !== value) return null;
      const match = ICE_URL.exec(value);
      if (!match) return null;
      const port = match[3] === undefined ? undefined : Number(match[3]);
      if (port !== undefined && (port < 1 || port > 65_535)) return null;
      if (port === 53) continue;
      urls.push(value);
      if (match[1]?.toLowerCase().startsWith('turn')) needsCredentials = true;
    }
    if (!urls.length) continue;
    if (needsCredentials) {
      const username = entry['username'];
      const credential = entry['credential'];
      if (!isCredential(username) || !isCredential(credential)) return null;
      result.push({ urls, username, credential });
      hasTurn = true;
    } else {
      result.push({ urls });
    }
  }
  return hasTurn ? result : null;
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class InvalidJsonError extends Error {}
class BodyTooLargeError extends Error {}

async function readJson(body: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!body) throw new InvalidJsonError();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidJsonError();
  }
}

function iceError(code: string, status: number, extraHeaders: HeadersInit = {}): Response {
  return iceJson({ ok: false, code }, status, extraHeaders);
}

function iceJson(body: object, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(body, { status, headers });
}
