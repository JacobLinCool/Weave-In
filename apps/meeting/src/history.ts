import { MAX_HISTORY_BATCH_ENTRIES, MAX_HISTORY_ENTRIES, MAX_PEER_MESSAGE_BYTES, type HistoryEntry, type PeerMessage } from './protocol';

/**
 * Late joiners receive the past from the people who were there: each participant
 * replays only what it said itself, so nobody relays anyone else's words. These
 * helpers pick, bound, and batch that replay, and merge it back in time order.
 */

/** Keeps a safety margin under the per-message limit for the JSON envelope. */
const BATCH_BUDGET_BYTES = MAX_PEER_MESSAGE_BYTES - 2_048;

export interface Timed {
  at: string;
}

/** The most recent `limit` entries in time order, oldest first. */
export function selectHistory(entries: HistoryEntry[], limit = MAX_HISTORY_ENTRIES): HistoryEntry[] {
  const sorted = [...entries].sort(byTime);
  return sorted.slice(Math.max(0, sorted.length - limit));
}

/** Splits entries into `history` messages that each fit in one data-channel frame; always yields at least one. */
export function batchHistory(entries: HistoryEntry[], budgetBytes = BATCH_BUDGET_BYTES): PeerMessage[] {
  const batches: HistoryEntry[][] = [];
  let current: HistoryEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const bytes = utf8Length(JSON.stringify(entry)) + 1;
    if (current.length > 0 && (currentBytes + bytes > budgetBytes || current.length >= MAX_HISTORY_BATCH_ENTRIES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += bytes;
  }
  batches.push(current);
  return batches.map((batch, index) => ({ type: 'history', entries: batch, more: index < batches.length - 1 }));
}

/**
 * Inserts an item after the last existing item that is not newer than it, so replayed
 * history lands where it belongs in time while live items keep their arrival order.
 */
export function insertByTime<T extends Timed>(list: T[], item: T): T[] {
  let index = list.length;
  while (index > 0 && compareTime(list[index - 1]!.at, item.at) > 0) index -= 1;
  return [...list.slice(0, index), item, ...list.slice(index)];
}

export function compareTime(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a < b ? -1 : a > b ? 1 : 0;
  return left - right;
}

function byTime(a: Timed, b: Timed): number {
  return compareTime(a.at, b.at);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
