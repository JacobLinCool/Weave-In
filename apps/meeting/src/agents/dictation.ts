import { createTranscription, type Credential, type Transcription } from '@weave-in/transcribe';
import { requestTranscriptionToken } from '../transcription-token';
import { observeVoiceActivity } from '../voice-activity';

interface DictationState {
  status: 'idle' | 'starting' | 'recording' | 'stopping';
  text: string;
  level: number;
  error: string | null;
}

/** Private transcription only: drafts never enter the meeting log or agent session. */
export class Dictation {
  #state: DictationState = { status: 'idle', text: '', level: 0, error: null };
  #listeners = new Set<() => void>();
  #session: Transcription | null = null;
  #track: MediaStreamTrack | null = null;
  #unsubscribe: (() => void) | null = null;
  #monitor: (() => void) | null = null;
  #abort: AbortController | null = null;
  #starting: Promise<void> | null = null;
  #stopping: Promise<string> | null = null;
  #owner = crypto.randomUUID();
  constructor(private readonly media: { beginVoice(audience: 'private', owner: string): Promise<MediaStreamTrack>; endVoice(owner: string): void }) {}
  snapshot = (): DictationState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #publish(state: Partial<DictationState>): void { this.#state = { ...this.#state, ...state }; for (const listener of this.#listeners) listener(); }

  start(): Promise<void> {
    if (this.#state.status !== 'idle') return Promise.reject(new Error('Dictation is already active.'));
    const abort = this.#abort = new AbortController();
    this.#publish({ status: 'starting', text: '', level: 0, error: null });
    this.#starting = this.#start(abort).finally(() => { this.#starting = null; });
    return this.#starting;
  }
  async #start(abort: AbortController): Promise<void> {
    try {
      this.#track = await this.media.beginVoice('private', this.#owner);
      abort.signal.throwIfAborted();
      const issued = await requestTranscriptionToken(abort.signal);
      abort.signal.throwIfAborted();
      let initial: Credential | null = { type: 'ephemeral-token', value: issued.token };
      const session = this.#session = createTranscription({
        credential: async () => {
          const credential = initial; initial = null;
          return credential ?? { type: 'ephemeral-token', value: (await requestTranscriptionToken(abort.signal)).token };
        },
        options: { provider: issued.provider, mode: 'VERBATIM' },
      });
      session.addAudioSource(this.#track);
      this.#unsubscribe = session.subscribe(state => {
        this.#publish({ text: [...state.segments.map(segment => segment.text), state.interim].filter(Boolean).join(' '), error: state.error?.message ?? null });
        if (state.error && this.#state.status === 'recording') void this.stop().catch(() => undefined);
      });
      const started = await session.start(undefined, abort.signal);
      if (!started.ok) throw new Error(started.message);
      abort.signal.throwIfAborted();
      this.#publish({ status: 'recording' });
      this.#monitor = observeVoiceActivity(this.#track, level => this.#publish({ level }));
    } catch (cause) {
      this.#publish({ error: abort.signal.aborted ? null : cause instanceof Error ? cause.message : 'Unable to start dictation.' });
      await this.#cleanup();
      this.#publish({ status: 'idle', level: 0 });
      throw cause;
    }
  }
  stop(): Promise<string> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#stop().finally(() => { this.#stopping = null; });
    return this.#stopping;
  }
  async #stop(): Promise<string> {
    await this.#starting;
    const session = this.#session;
    if (!session) return this.#state.text;
    this.#publish({ status: 'stopping' });
    try {
      const stopped = await session.stop();
      const text = session.getState().segments.map(segment => segment.text).join(' ');
      this.#publish({ text });
      if (!stopped.ok) throw new Error(stopped.message);
      return text;
    } finally {
      await this.#cleanup();
      this.#publish({ status: 'idle', level: 0 });
    }
  }
  async cancel(): Promise<void> {
    this.#abort?.abort();
    await this.#starting?.catch(() => undefined);
    await this.#stopping?.catch(() => undefined);
    await this.#cleanup();
    this.#publish({ status: 'idle', level: 0 });
  }
  async #cleanup(): Promise<void> {
    this.#unsubscribe?.(); this.#unsubscribe = null;
    this.#monitor?.(); this.#monitor = null;
    this.#track?.stop(); this.#track = null;
    const session = this.#session; this.#session = null;
    try { await session?.destroy(); } finally { this.media.endVoice(this.#owner); }
  }
}
