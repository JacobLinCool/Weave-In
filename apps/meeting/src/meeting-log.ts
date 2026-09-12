import type { AgentLine } from './agents/contracts';
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
  | { seq: number; kind: 'transcript'; at: string; speaker: LogParticipant; text: string; agent?: AgentLine; replayed?: true }
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
    const available = this.#entries.filter((entry) => entry.seq > start);
    const entries = available.slice(0, size);
    const last = entries[entries.length - 1];
    const hasMore = size < available.length;
    return { entries, nextCursor: hasMore && last ? last.seq : Math.max(this.head, Math.floor(after)), hasMore };
  }

  /** A permission-scoped snapshot with the same cursor space as its source. */
  filtered(visible: (entry: MeetingLogEntry) => boolean): MeetingLog {
    const log = new MeetingLog();
    log.#entries = this.#entries.filter(visible);
    log.#next = this.#next;
    return log;
  }

  upsertAgent(line: AgentLine, peerId: string, replayed?: true): void {
    const entry = this.#entries.find((item) => item.kind === 'transcript' && item.agent?.id === line.id);
    // Move the updated row to a fresh cursor without duplicating its stable transcript ID.
    if (entry) this.#entries = this.#entries.filter((item) => item !== entry);
    this.append({ kind: 'transcript', at: line.at, speaker: { peerId, name: line.name }, text: line.text, agent: line, ...(replayed ? { replayed } : {}) });
  }

  clear(): void {
    this.#entries = [];
    this.#next = 1;
  }
}
