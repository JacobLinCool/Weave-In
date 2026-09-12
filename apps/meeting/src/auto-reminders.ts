import type { MeetingLog, MeetingLogEntry } from './meeting-log';
import type { PrivateNotices } from './private-notices';

export type MonitorStatus = 'watching' | 'checking' | 'paused' | 'unavailable';
interface MonitorState {
  enabled: boolean;
  status: MonitorStatus;
}
interface Context {
  log(): MeetingLog;
  you(): string;
}

/** Runs in ordinary browsers. No MCP, shared chat, or assistant session involved. */
export class AutoReminders {
  #state: MonitorState = { enabled: true, status: 'watching' };
  #listeners = new Set<() => void>();
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #context: Context | null = null;
  #cursor = 0;
  #nextCheck = 0;
  #generation = 0;
  constructor(
    private readonly notices: PrivateNotices,
    private readonly request: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };
  #publish(status: MonitorStatus) {
    this.#state = { ...this.#state, status };
    this.#listeners.forEach((fn) => fn());
  }
  setEnabled(enabled: boolean) {
    this.#state = { ...this.#state, enabled };
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    this.#publish(enabled ? 'watching' : 'paused');
  }
  start(context: Context) {
    this.stop();
    this.#context = context;
    this.#cursor = context.log().head;
    this.#nextCheck = 0;
    this.#publish(this.#state.enabled ? 'watching' : 'paused');
    this.#timer = setInterval(() => {
      void this.check();
    }, 5000);
  }
  stop() {
    clearInterval(this.#timer);
    this.#context = null;
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
  }
  async check(now = Date.now()): Promise<void> {
    const context = this.#context;
    if (!context || !this.#state.enabled || this.#abort || now < this.#nextCheck) return;
    const log = context.log();
    const records = log
      .read(Math.max(0, log.head - 100), 100)
      .entries.filter((r): r is Extract<MeetingLogEntry, { kind: 'transcript' }> => r.kind === 'transcript')
      .map((r) => ({
        seq: r.seq,
        at: Date.parse(r.at),
        peerId: r.speaker.peerId,
        name: r.speaker.name,
        text: r.text.slice(0, 2000),
      }))
      .filter((r) => Number.isFinite(r.at))
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .slice(-40);
    while (records.length > 2 && new TextEncoder().encode(JSON.stringify(records)).length > 48000) records.shift();
    const latest = Math.max(0, ...records.map((r) => r.seq));
    const fresh = log
      .read(Math.max(this.#cursor, log.head - 100), 100)
      .entries.some((r) => !('replayed' in r && r.replayed) && r.kind === 'transcript');
    if (
      !fresh ||
      records.length < 2 ||
      latest <= this.#cursor ||
      this.notices.getSnapshot().notices.some((n) => n.status === 'active' && n.expiresAt > now)
    )
      return;
    // Wait for actual new final speech, not interims, presence, or files.
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#publish('checking');
    this.#nextCheck = now + 30000;
    try {
      const response = await this.request('/api/private-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          you: context.you(),
          records,
          history: this.notices
            .getSnapshot()
            .notices.filter((n) => n.id.startsWith('auto-'))
            .slice(0, 20)
            .map((n) => n.text),
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]),
      });
      if (!response.ok) throw new Error('Analysis unavailable');
      const result = (await response.json()) as { notice: unknown };
      if (generation !== this.#generation || abort.signal.aborted) return;
      // A newer turn could answer the concern while the model was running. Re-evaluate it instead of showing stale advice.
      const changed = log.read(latest, 100).entries.some((r) => r.kind === 'transcript');
      if (!changed && result.notice) {
        this.notices.show(result.notice, log, now);
        this.#nextCheck = now + 120000;
      }
      this.#cursor = latest;
      this.#publish('watching');
    } catch {
      if (generation === this.#generation && !abort.signal.aborted) {
        this.#nextCheck = now + 60000;
        this.#publish('unavailable');
      }
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }
}
