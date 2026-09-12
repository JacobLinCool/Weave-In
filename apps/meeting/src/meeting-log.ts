/**
 * The meeting record: everything that happened in the room, in order, numbered so a
 * reader (a participant's agent through WebMCP) can pick up exactly where it left off.
 * Held in memory by each browser for the life of the room.
 */

export interface LogParticipant {
  peerId: string;
  name: string;
}

/**
 * `replayed` marks an entry that happened before this participant joined and was
 * replayed by its author afterwards; its `at` is the original time, its `seq` the
 * arrival order.
 */
export type MeetingLogEntry =
  | { seq: number; kind: 'transcript'; at: string; speaker: LogParticipant; text: string; replayed?: true }
  | { seq: number; kind: 'chat'; at: string; sender: LogParticipant; text: string; agent: string | null; replayed?: true }
  | { seq: number; kind: 'file'; at: string; sender: LogParticipant; file: { id: string; name: string; size: number; mime: string } }
  | { seq: number; kind: 'presence'; at: string; participant: LogParticipant; event: 'joined' | 'present' | 'left' };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type MeetingLogInput = DistributiveOmit<MeetingLogEntry, 'seq'>;

export interface MeetingLogPage {
  entries: MeetingLogEntry[];
  /** Pass back as `after` to continue; equals the last returned `seq`, or `after` when nothing was returned. */
  nextCursor: number;
  hasMore: boolean;
}

export const DEFAULT_LOG_PAGE = 200;
export const MAX_LOG_PAGE = 500;

export class MeetingLog {
  #entries: MeetingLogEntry[] = [];
  #next = 1;

  get length(): number {
    return this.#entries.length;
  }

  /** The highest sequence number issued so far; 0 when the record is empty. */
  get head(): number {
    return this.#next - 1;
  }

  append(input: MeetingLogInput): MeetingLogEntry {
    const entry = { seq: this.#next++, ...input } as MeetingLogEntry;
    this.#entries.push(entry);
    return entry;
  }

  /** Entries with a sequence number greater than `after`, oldest first. */
  read(after = 0, limit = DEFAULT_LOG_PAGE): MeetingLogPage {
    const start = Math.max(0, Math.min(Math.floor(after), this.head));
    const size = Math.max(1, Math.min(Math.floor(limit), MAX_LOG_PAGE));
    // Sequence numbers are dense and start at 1, so the index of the first entry after the cursor is the cursor itself.
    const offset = Math.max(0, start - (this.#entries[0]?.seq ?? 1) + 1);
    const entries = this.#entries.slice(offset, offset + size);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: last ? last.seq : Math.max(0, Math.floor(after)), hasMore: offset + size < this.#entries.length };
  }

  snapshot(limit = 2000): MeetingLogEntry[] { return this.#entries.slice(-limit); }

  restore(entries: MeetingLogEntry[]): void {
    this.#entries = structuredClone(entries);
    this.#next = (entries.at(-1)?.seq ?? 0) + 1;
  }

  clear(): void {
    this.#entries = [];
    this.#next = 1;
  }
}
