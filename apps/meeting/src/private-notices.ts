import type { MeetingLog } from './meeting-log';

export interface PrivateNotice {
  id: string;
  text: string;
  at: number;
  expiresAt: number;
  status: 'active' | 'dismissed' | 'expired' | 'replaced';
  read?: boolean;
  collapsed?: boolean;
  evidence: Array<{ seq: number; name: string; text: string }>;
}
export interface PrivateNoticeState { notices: readonly PrivateNotice[] }

/** Per-tab state, checkpointed by App for room recovery. Never sent to shared room transports. */
export class PrivateNotices {
  #state: PrivateNoticeState = { notices: [] };
  #listeners = new Set<() => void>();
  getSnapshot = (): PrivateNoticeState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  #publish(state: PrivateNoticeState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  show(input: unknown, log: MeetingLog, now = Date.now()): PrivateNotice {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a notice object.');
    const args = input as Record<string, unknown>;
    if (Object.keys(args).some((key) => !['id', 'text', 'evidenceSeqs', 'ttlSeconds'].includes(key))) throw new Error('Unknown notice field.');
    const { id, text, evidenceSeqs } = args;
    const ttl = args['ttlSeconds'] ?? 120;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error('id must contain 1–80 letters, digits, underscores or hyphens.');
    if (typeof text !== 'string' || !text.trim() || text.length > 240) throw new Error('text must contain 1–240 characters.');
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 15 || ttl > 300) throw new Error('ttlSeconds must be an integer from 15 to 300.');
    if (!Array.isArray(evidenceSeqs) || evidenceSeqs.length < 1 || evidenceSeqs.length > 5) throw new Error('Provide 1–5 evidenceSeqs from read_meeting.');
    const evidence = evidenceSeqs.map((seq: unknown) => {
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > log.head) throw new Error('Unknown evidence sequence.');
      const entry = log.read(seq - 1, 1).entries[0];
      if (!entry || entry.seq !== seq || (entry.kind !== 'transcript' && entry.kind !== 'chat')) throw new Error('Evidence must reference speech or chat.');
      return { seq, name: entry.kind === 'transcript' ? entry.speaker.name : entry.sender.name, text: entry.text };
    });
    this.expire(now);
    // Retrying a tool must not resurrect dismissed reminders or extend their lifetime.
    const existing = this.#state.notices.find((notice) => notice.id === id);
    if (existing) return existing;
    const notice: PrivateNotice = { id, text: text.replace(/\s+/gu, ' ').trim(), at: now, expiresAt: now + ttl * 1000, status: 'active', evidence };
    const previous = this.#state.notices.map((item): PrivateNotice => item.status === 'active' ? { ...item, status: 'replaced' } : item);
    this.#publish({ ...this.#state, notices: [notice, ...previous].slice(0, 50) });
    return notice;
  }
  collapse(id: string): void {
    if (!this.#state.notices.some(n => n.id === id && !n.collapsed)) return;
    this.#publish({...this.#state, notices:this.#state.notices.map(n => n.id === id ? {...n, collapsed:true} : n)});
  }
  markRead(ids: string[]): void {
    if (!this.#state.notices.some(n => ids.includes(n.id) && !n.read)) return;
    this.#publish({...this.#state, notices:this.#state.notices.map(n => ids.includes(n.id) ? {...n, read:true, collapsed:true} : n)});
  }
  dismiss(id: string): void {
    this.#publish({ ...this.#state, notices: this.#state.notices.map((item) => item.id === id && item.status === 'active' ? { ...item, status: 'dismissed' } : item) });
  }
  expire(now = Date.now()): void {
    if (!this.#state.notices.some((item) => item.status === 'active' && item.expiresAt <= now)) return;
    this.#publish({ ...this.#state, notices: this.#state.notices.map((item) => item.status === 'active' && item.expiresAt <= now ? { ...item, status: 'expired' } : item) });
  }
  restore(state: PrivateNoticeState): void {
    this.#publish({ notices: structuredClone(state.notices) });
    this.expire();
  }
  clear(): void { this.#publish({ notices: [] }); }
}
