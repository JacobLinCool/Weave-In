import { record } from './contracts';
import { GROUP_ACTIONS, GROUP_CONFIDENCE, discussionPeer, type DiscussionRecord, type GroupKind } from './group';
import type { MeetingLogEntry } from '../meeting-log';

export const GROUP_DETECTION_MODEL = 'jev-latest';
export interface GroupDetection { kind: GroupKind; confidence: number }
export interface GroupReviewRecord { seq: number; kind: 'chat' | 'transcript'; peerId: string; at: string; text: string; truncated: boolean }
export interface GroupReviewContext {
  records: GroupReviewRecord[];
  previousInterventions: Array<{ text: string; at: string }>;
}

export function groupReviewContext(records: DiscussionRecord[], history: MeetingLogEntry[]): GroupReviewContext {
  return {
    records: records.map(entry => ({ seq: entry.seq, kind: entry.kind, peerId: discussionPeer(entry), at: entry.at, text: entry.text.slice(0, 1000), truncated: entry.text.length > 1000 })),
    previousInterventions: history.flatMap(entry => (entry.kind === 'chat' && entry.agent === 'Omni') ||
      (entry.kind === 'transcript' && entry.agent?.name === 'Omni' && entry.agent.role === 'assistant')
      ? [{ text: entry.text.slice(0, 1000), at: entry.at }] : []).slice(-5),
  };
}

export function parseGroupDetection(value: unknown): GroupDetection | null {
  if (!record(value) || typeof value.kind !== 'string' || !Object.hasOwn(GROUP_ACTIONS, value.kind) ||
    typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence > 1 ||
    value.confidence < GROUP_CONFIDENCE[value.kind as GroupKind]) return null;
  return { kind: value.kind as GroupKind, confidence: value.confidence };
}

/** Only bounded public records are sent to the authenticated, server-side detector. */
export async function detectGroup(args: { room: string; token: string; id: string; epoch: number; request: number; context: GroupReviewContext; signal: AbortSignal }): Promise<GroupDetection | null> {
  const response = await fetch(`/api/rooms/${args.room}/agents/${args.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Token': args.token },
    body: JSON.stringify({ epoch: args.epoch, request: args.request, ...args.context }), signal: AbortSignal.any([args.signal, AbortSignal.timeout(15_000)]),
  });
  const body: unknown = await response.json();
  if (!response.ok || !record(body)) throw new Error(record(body) && typeof body.error === 'string' ? body.error : `Omni detection unavailable (${response.status}).`);
  if (body.detection === null) return null;
  const detection = parseGroupDetection(body.detection);
  if (!detection) throw new Error('Omni received an invalid Jev detection.');
  return detection;
}
