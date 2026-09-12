import type { ChatMessage, TranscriptLine } from './components';
import type { MeetingLogEntry } from './meeting-log';
import type { PrivateNoticeState } from './private-notices';
import { PEER_ID_PATTERN, ROOM_CODE_PATTERN } from './protocol';

const KEY = 'weave-in:meeting-session:v1';
const MAX_BYTES = 1_500_000;
export const SESSION_TTL = 12 * 60 * 60 * 1000;
export interface MeetingSession {
  version: 1;
  monitoringEnabled: boolean;
  savedAt: number;
  roomCode: string;
  peerId: string;
  name: string;
  startedAt: number;
  joinedAt: string;
  log: MeetingLogEntry[];
  messages: ChatMessage[];
  transcript: TranscriptLine[];
  notices: PrivateNoticeState;
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function storage(): StorageLike | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function text(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 65536;
}
function participant(v: unknown): boolean {
  return record(v) && text(v.peerId) && text(v.name);
}
function row(v: unknown): boolean {
  return (
    record(v) &&
    text(v.id) &&
    text(v.from) &&
    text(v.name) &&
    text(v.color) &&
    text(v.at) &&
    text(v.text) &&
    typeof v.own === 'boolean'
  );
}
function logEntry(v: unknown): boolean {
  if (!record(v) || !Number.isSafeInteger(v.seq) || Number(v.seq) < 1 || !text(v.at)) return false;
  if (v.kind === 'transcript') return participant(v.speaker) && text(v.text);
  if (v.kind === 'chat') return participant(v.sender) && text(v.text) && (v.agent === null || text(v.agent));
  if (v.kind === 'presence')
    return participant(v.participant) && ['joined', 'present', 'left'].includes(String(v.event));
  return (
    v.kind === 'file' &&
    participant(v.sender) &&
    record(v.file) &&
    text(v.file.id) &&
    text(v.file.name) &&
    text(v.file.mime) &&
    typeof v.file.size === 'number'
  );
}
export function loadMeetingSession(roomCode: string, source = storage(), now = Date.now()): MeetingSession | null {
  try {
    const raw = source?.getItem(KEY);
    if (!raw || raw.length > MAX_BYTES) return null;
    const v: unknown = JSON.parse(raw);
    if (
      !record(v) ||
      v.version !== 1 ||
      typeof v.monitoringEnabled !== 'boolean' ||
      v.roomCode !== roomCode ||
      !ROOM_CODE_PATTERN.test(roomCode) ||
      !text(v.peerId) ||
      !PEER_ID_PATTERN.test(v.peerId) ||
      !text(v.name) ||
      typeof v.savedAt !== 'number' ||
      now - v.savedAt > SESSION_TTL ||
      v.savedAt > now + 60000 ||
      typeof v.startedAt !== 'number' ||
      !Number.isFinite(v.startedAt) ||
      !text(v.joinedAt) ||
      !Array.isArray(v.log) ||
      v.log.length > 2000 ||
      !v.log.every(logEntry) ||
      !Array.isArray(v.messages) ||
      v.messages.length > 1000 ||
      !v.messages.every((m) => row(m) && m.kind === 'text' && (m.agent === null || text(m.agent))) ||
      !Array.isArray(v.transcript) ||
      v.transcript.length > 1000 ||
      !v.transcript.every(row) ||
      !record(v.notices) ||
      typeof v.notices.hidden !== 'boolean' ||
      !Array.isArray(v.notices.notices) ||
      v.notices.notices.length > 50
    )
      return null;
    const entries = v.log;
    if (entries.some((e, i) => i > 0 && e.seq !== entries[i - 1].seq + 1)) return null;
    if (
      !v.notices.notices.every(
        (n) =>
          record(n) &&
          text(n.id) &&
          text(n.text) &&
          typeof n.at === 'number' &&
          typeof n.expiresAt === 'number' &&
          ['active', 'dismissed', 'expired', 'replaced'].includes(String(n.status)) &&
          Array.isArray(n.evidence) &&
          n.evidence.length <= 5 &&
          n.evidence.every((e) => record(e) && Number.isSafeInteger(e.seq) && text(e.name) && text(e.text)),
      )
    )
      return null;
    return v as unknown as MeetingSession;
  } catch {
    return null;
  }
}
export function saveMeetingSession(value: MeetingSession, target = storage()): boolean {
  if (!target) return false;
  const snapshot = {
    ...value,
    log: value.log.slice(-2000),
    messages: value.messages.filter((m) => m.kind === 'text').slice(-1000),
    transcript: value.transcript.slice(-1000),
  };
  try {
    let encoded = JSON.stringify(snapshot);
    while (
      encoded.length > MAX_BYTES &&
      (snapshot.log.length > 100 || snapshot.messages.length > 100 || snapshot.transcript.length > 100)
    ) {
      snapshot.log = snapshot.log.slice(-Math.max(100, Math.floor(snapshot.log.length / 2)));
      snapshot.messages = snapshot.messages.slice(-Math.max(100, Math.floor(snapshot.messages.length / 2)));
      snapshot.transcript = snapshot.transcript.slice(-Math.max(100, Math.floor(snapshot.transcript.length / 2)));
      encoded = JSON.stringify(snapshot);
    }
    if (encoded.length > MAX_BYTES) return false;
    target.setItem(KEY, encoded);
    return true;
  } catch {
    return false;
  }
}
