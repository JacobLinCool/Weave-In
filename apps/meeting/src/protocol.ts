export const MAX_PARTICIPANTS = 8;
export const MAX_SIGNAL_FRAME_BYTES = 65_536;
export const MAX_PEER_MESSAGE_BYTES = 16_384;
export const MAX_CHAT_CHARACTERS = 2_000;
export const MAX_TRANSCRIPT_CHARACTERS = 4_000;
export const MAX_AGENT_LABEL_CHARACTERS = 40;
/** Files shared in chat travel peer-to-peer; this caps what a participant may offer. */
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const MAX_FILE_NAME_CHARACTERS = 200;
/** Label prefix of the dedicated data channel that carries one file transfer. */
export const FILE_CHANNEL_PREFIX = 'file:';
/** Most entries one `history` batch may carry; batches are also kept under `MAX_PEER_MESSAGE_BYTES`. */
export const MAX_HISTORY_BATCH_ENTRIES = 200;
/** Most of its own entries a participant replays to a late joiner. */
export const MAX_HISTORY_ENTRIES = 400;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/u;
export const PEER_ID_PATTERN = /^[a-zA-Z0-9_-]{12,64}$/u;
const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;
const STREAM_ID_PATTERN = /^[a-zA-Z0-9_{}-]{1,128}$/u;
const MIME_PATTERN = /^[a-zA-Z0-9!#$&^_.+-]{1,64}\/[a-zA-Z0-9!#$&^_.+-]{1,64}$/u;
export const DEFAULT_FILE_MIME = 'application/octet-stream';

export interface PeerIdentity {
  peerId: string;
  name: string;
  isHost: boolean;
}

export type SignalKind = 'offer' | 'answer' | 'ice';

export interface ClientSignalMessage {
  type: 'signal';
  target: string;
  kind: SignalKind;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
}

export type ClientMessage = ClientSignalMessage;

export type ServerMessage =
  | { type: 'welcome'; self: PeerIdentity; peers: PeerIdentity[] }
  | { type: 'peer-joined'; peer: PeerIdentity }
  | { type: 'peer-left'; peerId: string }
  | {
      type: 'signal';
      from: string;
      kind: SignalKind;
      payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
    }
  | { type: 'error'; code: string; message: string };

/** Media state a participant announces to every peer over the data channel. */
export interface PeerMediaState {
  cameraStreamId: string | null;
  screenStreamId: string | null;
  micOn: boolean;
  cameraOn: boolean;
}

/** What a participant announces about a file they are willing to send on request. */
export interface SharedFileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  at: string;
}

/** One of a participant's own past chat messages or finalized captions, replayed to a late joiner. */
export type HistoryEntry =
  | { kind: 'chat'; id: string; text: string; at: string; agent: string | null }
  | { kind: 'transcript'; id: string; text: string; at: string };

/**
 * Messages exchanged directly between participants over WebRTC data channels.
 * A chat message carries `agent` when it was posted through a WebMCP tool on the
 * sender's behalf, so every screen can label it as the participant's agent.
 * Files are announced by metadata only; the bytes flow over a separate channel
 * (`FILE_CHANNEL_PREFIX` + transfer id) that the owner opens after a `file-request`.
 * `history` replays the sender's own earlier entries to a participant who joined
 * later; `more: false` marks the last batch.
 */
export type PeerMessage =
  | ({ type: 'state' } & PeerMediaState)
  | { type: 'chat'; id: string; text: string; at: string; agent: string | null }
  | { type: 'transcript'; id: string; text: string; at: string; final: boolean }
  | ({ type: 'file' } & SharedFileMeta)
  | { type: 'file-request'; id: string; transfer: string }
  | { type: 'file-unavailable'; id: string; transfer: string }
  | { type: 'history'; entries: HistoryEntry[]; more: boolean };

export function normalizeDisplayName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 1 || normalized.length > 40) return null;
  if (/\p{Cc}/u.test(normalized)) return null;
  return normalized;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || value['type'] !== 'signal') return null;
  const target = value['target'];
  const kind = value['kind'];
  const payload = value['payload'];
  if (typeof target !== 'string' || !PEER_ID_PATTERN.test(target)) return null;
  if (kind !== 'offer' && kind !== 'answer' && kind !== 'ice') return null;
  if (!isRecord(payload)) return null;
  if (kind === 'offer' || kind === 'answer') {
    if (payload['type'] !== kind || typeof payload['sdp'] !== 'string') return null;
    if (payload['sdp'].length > MAX_SIGNAL_FRAME_BYTES - 512) return null;
  } else {
    const candidate = payload['candidate'];
    if (candidate !== undefined && typeof candidate !== 'string') return null;
  }
  return { type: 'signal', target, kind, payload } as ClientSignalMessage;
}

export function parsePeerMessage(value: unknown): PeerMessage | null {
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'state': {
      const cameraStreamId = optionalStreamId(value['cameraStreamId']);
      const screenStreamId = optionalStreamId(value['screenStreamId']);
      if (cameraStreamId === undefined || screenStreamId === undefined) return null;
      if (typeof value['micOn'] !== 'boolean' || typeof value['cameraOn'] !== 'boolean') return null;
      return {
        type: 'state',
        cameraStreamId,
        screenStreamId,
        micOn: value['micOn'],
        cameraOn: value['cameraOn'],
      };
    }
    case 'chat': {
      const text = boundedText(value['text'], MAX_CHAT_CHARACTERS);
      const id = value['id'];
      const at = value['at'];
      if (!text || typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id) || !isTimestamp(at)) return null;
      const agent = value['agent'];
      if (agent !== undefined && agent !== null && typeof agent !== 'string') return null;
      return { type: 'chat', id, text, at, agent: agent ? boundedText(agent, MAX_AGENT_LABEL_CHARACTERS) : null };
    }
    case 'transcript': {
      const text = boundedText(value['text'], MAX_TRANSCRIPT_CHARACTERS, true);
      const id = value['id'];
      const at = value['at'];
      const final = value['final'];
      if (text === null || typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id)) return null;
      if (!isTimestamp(at) || typeof final !== 'boolean') return null;
      return { type: 'transcript', id, text, at, final };
    }
    case 'file': {
      const id = value['id'];
      const name = boundedText(value['name'], MAX_FILE_NAME_CHARACTERS);
      const size = value['size'];
      const at = value['at'];
      if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id) || !name || !isTimestamp(at)) return null;
      if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) return null;
      const mime = typeof value['mime'] === 'string' && MIME_PATTERN.test(value['mime']) ? value['mime'].toLowerCase() : DEFAULT_FILE_MIME;
      return { type: 'file', id, name, size, mime, at };
    }
    case 'history': {
      const rawEntries = value['entries'];
      const more = value['more'];
      if (!Array.isArray(rawEntries) || rawEntries.length > MAX_HISTORY_BATCH_ENTRIES || typeof more !== 'boolean') return null;
      const entries: HistoryEntry[] = [];
      for (const raw of rawEntries) {
        const entry = parseHistoryEntry(raw);
        if (!entry) return null;
        entries.push(entry);
      }
      return { type: 'history', entries, more };
    }
    case 'file-request':
    case 'file-unavailable': {
      const id = value['id'];
      const transfer = value['transfer'];
      if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id)) return null;
      if (typeof transfer !== 'string' || !MESSAGE_ID_PATTERN.test(transfer)) return null;
      return { type: value['type'], id, transfer };
    }
    default:
      return null;
  }
}

function parseHistoryEntry(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const at = value['at'];
  if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id) || !isTimestamp(at)) return null;
  if (value['kind'] === 'chat') {
    const text = boundedText(value['text'], MAX_CHAT_CHARACTERS);
    const agent = value['agent'];
    if (!text || (agent !== undefined && agent !== null && typeof agent !== 'string')) return null;
    return { kind: 'chat', id, text, at, agent: agent ? boundedText(agent, MAX_AGENT_LABEL_CHARACTERS) : null };
  }
  if (value['kind'] === 'transcript') {
    const text = boundedText(value['text'], MAX_TRANSCRIPT_CHARACTERS);
    if (!text) return null;
    return { kind: 'transcript', id, text, at };
  }
  return null;
}

function optionalStreamId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && STREAM_ID_PATTERN.test(value)) return value;
  return undefined;
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!allowEmpty && normalized.length === 0) return null;
  return normalized.slice(0, maxLength);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
