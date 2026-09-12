import { AudioMixer, type PcmAudioFormat } from './audio-mixer';
import {
  failure,
  success,
  type AudioSourceOptions,
  type CommandResult,
  type CredentialInput,
  type SessionSummary,
  type StartTranscriptionInput,
  type StateListener,
  type TranscriptQuery,
  type TranscriptQueryResult,
  type TranscriptState,
  type TranscriptWaitQuery,
  type TranscriptionOptions,
} from './contracts';
import { errorDetails, TranscribeError } from './errors';
import { normalizeOptions, resolveOptions } from './options';
import { TranscriptStore } from './transcript-store';
import {
  createLiveTranscriber,
  type LiveTranscriber,
  type LiveTranscriptionCallbacks,
} from './transcriber';

export interface SessionAudioMixer {
  readonly sourceCount: number;
  addSource(input: MediaStream | MediaStreamTrack, options?: AudioSourceOptions): string;
  removeSource(id: string): boolean;
  startPcm(onPcm: (chunk: ArrayBuffer) => void, format: PcmAudioFormat): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export interface TranscriptionSessionDependencies {
  createTranscriber(args: {
    provider: TranscriptionOptions['provider'];
    credential: CredentialInput | null;
    options: TranscriptionOptions;
    callbacks: LiveTranscriptionCallbacks;
  }): LiveTranscriber;
  randomUUID(): string;
}

const DEFAULT_DEPENDENCIES: TranscriptionSessionDependencies = {
  createTranscriber: (args) => createLiveTranscriber(args),
  randomUUID: () => crypto.randomUUID(),
};

export class TranscriptionSession {
  readonly #store: TranscriptStore;
  readonly #mixer: SessionAudioMixer;
  readonly #dependencies: TranscriptionSessionDependencies;
  readonly #listeners = new Set<StateListener>();
  readonly #baseOptions: TranscriptionOptions;
  #credential: CredentialInput | null;
  #transcriber: LiveTranscriber | null = null;
  #destroyed = false;
  #startPromise: Promise<CommandResult<SessionSummary>> | null = null;
  #stopPromise: Promise<CommandResult<SessionSummary>> | null = null;

  constructor(args: {
    workletUrl: string;
    credential?: CredentialInput;
    options?: Partial<TranscriptionOptions>;
    dependencies?: Partial<TranscriptionSessionDependencies>;
    mixer?: SessionAudioMixer;
    now?: () => Date;
  }) {
    this.#credential = args.credential ?? null;
    this.#baseOptions = normalizeOptions(args.options);
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...args.dependencies };
    this.#store = new TranscriptStore(args.now);
    this.#mixer =
      args.mixer ??
      new AudioMixer({
        workletUrl: args.workletUrl,
        onSourcesChanged: (count) => {
          this.#store.setAudioSourceCount(count);
          this.#emit();
        },
        onEmptyWhileRunning: () => void this.#failActiveSession(
          'NO_ACTIVE_AUDIO',
          'Every audio source ended while transcription was running.',
        ),
      });
  }

  setCredential(credential: CredentialInput): void {
    this.#assertAlive();
    this.#credential = credential;
  }

  clearCredential(): void {
    this.#credential = null;
  }

  addAudioSource(
    input: MediaStream | MediaStreamTrack,
    options: AudioSourceOptions = {},
  ): string {
    this.#assertAlive();
    const id = this.#mixer.addSource(input, options);
    this.#store.setAudioSourceCount(this.#mixer.sourceCount);
    this.#emit();
    return id;
  }

  removeAudioSource(id: string): boolean {
    this.#assertAlive();
    const removed = this.#mixer.removeSource(id);
    if (removed) {
      this.#store.setAudioSourceCount(this.#mixer.sourceCount);
      this.#emit();
    }
    return removed;
  }

  subscribe(listener: StateListener): () => void {
    this.#assertAlive();
    this.#listeners.add(listener);
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  getState(): TranscriptState {
    return this.#store.snapshot();
  }

  start(
    overrides?: StartTranscriptionInput,
    signal?: AbortSignal,
  ): Promise<CommandResult<SessionSummary>> {
    if (this.#destroyed) {
      return Promise.resolve(failure('DESTROYED', 'This transcription instance has been destroyed.'));
    }
    const state = this.#store.snapshot();
    if (state.status === 'starting' || state.status === 'transcribing') {
      return Promise.resolve(
        success('ALREADY_RUNNING', 'Transcription is already running.', summarizeState(state)),
      );
    }
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start(overrides, signal).finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  getTranscript(query: TranscriptQuery = {}): CommandResult<TranscriptQueryResult> {
    if (this.#destroyed) {
      return failure('DESTROYED', 'This transcription instance has been destroyed.');
    }
    return success('TRANSCRIPT_READY', 'Transcript state retrieved.', this.#store.query(query));
  }

  async waitForTranscript(
    query: TranscriptWaitQuery = {},
    signal?: AbortSignal,
  ): Promise<CommandResult<TranscriptQueryResult>> {
    if (this.#destroyed) {
      return failure('DESTROYED', 'This transcription instance has been destroyed.');
    }
    const waitMs = normalizeTranscriptWait(query.waitMs);
    const initial = this.getTranscript(query);
    if (!initial.ok || waitMs === 0 || transcriptQueryIsReady(initial.data)) return initial;
    if (signal?.aborted) return failure('ABORTED', 'Waiting for transcript was aborted.');

    return await new Promise((resolve) => {
      let settled = false;
      let detach: (() => void) | null = null;
      const finish = (result: CommandResult<TranscriptQueryResult>): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        detach?.();
        resolve(result);
      };
      const onAbort = (): void => {
        finish(failure('ABORTED', 'Waiting for transcript was aborted.'));
      };
      const timeout = globalThis.setTimeout(() => finish(this.getTranscript(query)), waitMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      detach = this.subscribe(() => {
        const current = this.getTranscript(query);
        if (!current.ok || transcriptQueryChanged(initial.data, current.data)) finish(current);
      });
      if (settled) detach();
    });
  }

  stop(signal?: AbortSignal): Promise<CommandResult<SessionSummary>> {
    if (this.#destroyed) {
      return Promise.resolve(failure('DESTROYED', 'This transcription instance has been destroyed.'));
    }
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stop(signal).finally(() => {
      this.#stopPromise = null;
    });
    return this.#stopPromise;
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    if (this.#startPromise) await this.#startPromise.catch(() => undefined);
    await this.#stop();
    await this.#mixer.destroy();
    this.#credential = null;
    this.#listeners.clear();
    this.#destroyed = true;
  }

  async #start(
    overrides: StartTranscriptionInput | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CommandResult<SessionSummary>> {
    if (signal?.aborted) return failure('ABORTED', 'Starting transcription was aborted.');
    let options: TranscriptionOptions;
    try {
      options = resolveOptions(this.#baseOptions, overrides);
    } catch (error) {
      const details = errorDetails(error);
      return failure(details.code, details.message);
    }
    if (!this.#credential) {
      return failure('MISSING_CREDENTIAL', 'Set a provider credential before starting transcription.');
    }
    if (this.#mixer.sourceCount === 0) {
      return failure('NO_ACTIVE_AUDIO', 'Add at least one live audio source before starting.');
    }

    this.#store.begin({
      sessionId: this.#dependencies.randomUUID(),
      options,
      audioSourceCount: this.#mixer.sourceCount,
    });
    this.#emit();

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const transcriber = this.#dependencies.createTranscriber({
        provider: options.provider,
        credential: this.#credential,
        options,
        callbacks: {
          onInterim: (text) => {
            this.#store.setInterim(text);
            this.#emit();
          },
          onFinal: (text, connection) => {
            this.#store.appendFinal(text, connection);
            this.#emit();
          },
          onConnectionReady: (connection) => {
            this.#store.markTranscribing(connection);
            this.#emit();
          },
          onReconnecting: () => {
            this.#store.markReconnecting();
            this.#emit();
          },
          onFatalError: (code, message) => void this.#failActiveSession(code, message),
        },
      });
      this.#transcriber = transcriber;
      await this.#mixer.startPcm(
        (chunk) => transcriber.sendAudio(chunk),
        transcriber.audioFormat,
      );
      if (aborted) throw new TranscribeError('ABORTED', 'Starting transcription was aborted.');
      await transcriber.start();
      if (aborted) throw new TranscribeError('ABORTED', 'Starting transcription was aborted.');
      return success(
        'TRANSCRIPTION_STARTED',
        'Live transcription started.',
        summarizeState(this.#store.snapshot()),
      );
    } catch (error) {
      await this.#releaseActiveResources();
      const details = errorDetails(error);
      if (details.code === 'ABORTED') {
        this.#store.markStopped();
        this.#emit();
        return failure(details.code, details.message);
      }
      this.#store.markError(details.code, redactCredential(details.message));
      this.#emit();
      return failure(details.code, redactCredential(details.message), summarizeState(this.#store.snapshot()));
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #stop(signal?: AbortSignal): Promise<CommandResult<SessionSummary>> {
    const state = this.#store.snapshot();
    if (
      !this.#transcriber &&
      state.status !== 'starting' &&
      state.status !== 'transcribing' &&
      state.status !== 'stopping'
    ) {
      return success('ALREADY_STOPPED', 'No transcription session is active.', summarizeState(state));
    }
    this.#store.markStopping();
    this.#emit();
    const aborted = signal?.aborted ?? false;
    await this.#releaseActiveResources();
    this.#store.setAudioSourceCount(this.#mixer.sourceCount);
    this.#store.markStopped();
    this.#emit();
    if (aborted || signal?.aborted) {
      return failure(
        'ABORTED',
        'Stopping transcription was aborted after resources were safely released.',
        summarizeState(this.#store.snapshot()),
      );
    }
    return success(
      'TRANSCRIPTION_STOPPED',
      'Transcription stopped. Retained transcript remains available.',
      summarizeState(this.#store.snapshot()),
    );
  }

  async #releaseActiveResources(): Promise<void> {
    const transcriber = this.#transcriber;
    this.#transcriber = null;
    if (transcriber) await transcriber.stop().catch(() => undefined);
    await this.#mixer.stop().catch(() => undefined);
  }

  async #failActiveSession(code: string, message: string): Promise<void> {
    const state = this.#store.snapshot();
    if (state.status !== 'starting' && state.status !== 'transcribing') return;
    this.#store.markError(code, redactCredential(message));
    this.#emit();
    await this.#releaseActiveResources();
    this.#store.setAudioSourceCount(this.#mixer.sourceCount);
    this.#emit();
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const state = this.#store.snapshot();
    for (const listener of this.#listeners) listener(state);
  }

  #assertAlive(): void {
    if (this.#destroyed) {
      throw new TranscribeError('DESTROYED', 'This transcription instance has been destroyed.');
    }
  }
}

export function summarizeState(state: TranscriptState): SessionSummary {
  return {
    status: state.status,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    segmentCount: state.segments.length,
    latestSegmentId: state.nextSegmentId - 1,
    connectionCount: state.connectionCount,
    audioSourceCount: state.audioSourceCount,
    error: state.error ? { ...state.error } : null,
  };
}

function redactCredential(message: string): string {
  return message.replace(/([?&](?:key|access_token)=)[^&\s]+/giu, '$1[redacted]');
}

function normalizeTranscriptWait(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(30_000, Math.max(0, Math.trunc(value)));
}

function transcriptQueryIsReady(result: TranscriptQueryResult): boolean {
  return (
    result.segments.length > 0 ||
    result.hasMore ||
    (result.status !== 'starting' && result.status !== 'transcribing')
  );
}

function transcriptQueryChanged(
  initial: TranscriptQueryResult,
  current: TranscriptQueryResult,
): boolean {
  return (
    current.segments.length > 0 ||
    current.hasMore ||
    current.latestSegmentId !== initial.latestSegmentId ||
    current.status !== initial.status ||
    current.sessionId !== initial.sessionId ||
    current.error?.occurredAt !== initial.error?.occurredAt
  );
}
