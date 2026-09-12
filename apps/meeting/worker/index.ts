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
  /** Optional: force `gemini` or `openai` when both keys are configured. */
  TRANSCRIPTION_PROVIDER?: string;
  TOKEN_RATE_LIMITER: RateLimit;
}

interface SocketAttachment extends PeerIdentity {}

const GEMINI_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const OPENAI_TOKEN_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';
const TOKEN_LIFETIME_MS = 12 * 60 * 1_000;
const NEW_SESSION_LIFETIME_MS = 60 * 1_000;

interface SelectedProvider {
  provider: TranscriptionProvider;
  apiKey: string;
}

type UpstreamFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/transcription-token') {
      return issueTranscriptionToken(request, env);
    }
    const match = /^\/api\/rooms\/([A-Z0-9]{6})\/connect$/u.exec(url.pathname);
    if (match) {
      const code = match[1];
      if (!code || !ROOM_CODE_PATTERN.test(code)) return jsonError('INVALID_ROOM', 400);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonError('WEBSOCKET_REQUIRED', 426);
      }
      if (request.headers.get('Origin') !== url.origin) return jsonError('INVALID_ORIGIN', 403);
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(request);
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
              transcription: { model: OPENAI_MODEL },
            },
          },
        },
      }),
    },
  };
}

export class MeetingRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const rawName = url.searchParams.get('name') ?? '';
    const peerId = url.searchParams.get('peerId') ?? '';
    const name = normalizeDisplayName(rawName);
    if (action !== 'create' && action !== 'join') return jsonError('INVALID_ACTION', 400);
    if (!name) return jsonError('INVALID_NAME', 400);
    if (!PEER_ID_PATTERN.test(peerId)) return jsonError('INVALID_PEER', 400);

    const active = this.#activeSockets();
    if (action === 'create' && active.length !== 0) return jsonError('ROOM_EXISTS', 409);
    if (action === 'join' && (active.length === 0 || !this.#hasHost(active))) {
      return jsonError('ROOM_NOT_FOUND', 404);
    }
    if (active.length >= MAX_PARTICIPANTS) return jsonError('ROOM_FULL', 409);
    if (active.some(({ attachment }) => attachment.peerId === peerId)) {
      return jsonError('DUPLICATE_PEER', 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const identity: SocketAttachment = { peerId, name, isHost: action === 'create' };
    server.serializeAttachment(identity);
    this.ctx.acceptWebSocket(server, [`peer:${peerId}`]);

    const peers = active.map(({ attachment }) => attachment);
    this.#send(server, { type: 'welcome', self: identity, peers });
    this.#broadcast({ type: 'peer-joined', peer: identity }, peerId);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): void {
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
    socket.close(code, reason);
    if (!attachment) return;
    this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
    void wasClean;
  }

  override webSocketError(socket: WebSocket): void {
    const attachment = readAttachment(socket);
    if (attachment) this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
    socket.close(1011, 'Signaling socket error');
  }

  #activeSockets(): Array<{ socket: WebSocket; attachment: SocketAttachment }> {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = readAttachment(socket);
      return attachment ? [{ socket, attachment }] : [];
    });
  }

  #hasHost(active: Array<{ attachment: SocketAttachment }>): boolean {
    return active.some(({ attachment }) => attachment.isHost);
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
    typeof candidate.isHost !== 'boolean'
  ) return null;
  return { peerId: candidate.peerId, name: candidate.name, isHost: candidate.isHost };
}

function jsonError(code: string, status: number): Response {
  return Response.json({ ok: false, code }, { status });
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
  headers.set(
    'Content-Security-Policy',
    isLocalDevelopment
      ? "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss://generativelanguage.googleapis.com https://api.openai.com; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'"
      : "default-src 'self'; base-uri 'none'; connect-src 'self' wss://generativelanguage.googleapis.com https://api.openai.com; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  );

  headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  );
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
