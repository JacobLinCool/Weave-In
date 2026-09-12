import type {
  AudioSourceOptions,
  CommandResult,
  CredentialInput,
  SessionSummary,
  StartTranscriptionInput,
  StateListener,
  TranscriptQuery,
  TranscriptQueryResult,
  TranscriptState,
  TranscriptWaitQuery,
  TranscriptionOptions,
} from './contracts';
import { TranscriptionSession } from './session';

export type {
  ApiKeyCredential,
  AudioSourceOptions,
  CommandResult,
  Credential,
  CredentialInput,
  CredentialProvider,
  EphemeralTokenCredential,
  SessionSummary,
  StartTranscriptionInput,
  TranscriptError,
  TranscriptQuery,
  TranscriptQueryResult,
  TranscriptSegment,
  TranscriptState,
  TranscriptWaitQuery,
  TranscriptionMode,
  TranscriptionOptions,
  TranscriptionProvider,
  TranscriptionStatus,
} from './contracts';
export {
  DEFAULT_OPTIONS,
  DEFAULT_TRANSCRIPT_QUERY,
  GEMINI_MODEL,
  OPENAI_MODEL,
} from './contracts';
export { TranscribeError } from './errors';
export { MAX_LANGUAGE_CODES } from './options';

export interface Transcription {
  setCredential(credential: CredentialInput): void;
  clearCredential(): void;
  addAudioSource(source: MediaStream | MediaStreamTrack, options?: AudioSourceOptions): string;
  removeAudioSource(sourceId: string): boolean;
  subscribe(listener: StateListener): () => void;
  getState(): TranscriptState;
  start(overrides?: StartTranscriptionInput, signal?: AbortSignal): Promise<CommandResult<SessionSummary>>;
  getTranscript(query?: TranscriptQuery): CommandResult<TranscriptQueryResult>;
  waitForTranscript(query?: TranscriptWaitQuery, signal?: AbortSignal): Promise<CommandResult<TranscriptQueryResult>>;
  stop(): Promise<CommandResult<SessionSummary>>;
  destroy(): Promise<void>;
}

export interface CreateTranscriptionOptions {
  credential?: CredentialInput;
  options?: Partial<TranscriptionOptions>;
}

/**
 * Creates a local, headless live transcription session. Audio sources are mixed
 * in the page and sent directly to the selected provider. The library retains
 * transcript text in memory and does not write browser or server storage.
 */
export function createTranscription(options: CreateTranscriptionOptions = {}): Transcription {
  const session = new TranscriptionSession({
    workletUrl: new URL('./audio-worklet.js?no-inline', import.meta.url).href,
    ...(options.credential ? { credential: options.credential } : {}),
    ...(options.options ? { options: options.options } : {}),
  });
  let destroyPromise: Promise<void> | null = null;
  return {
    setCredential: (credential) => session.setCredential(credential),
    clearCredential: () => session.clearCredential(),
    addAudioSource: (source, sourceOptions) => session.addAudioSource(source, sourceOptions),
    removeAudioSource: (sourceId) => session.removeAudioSource(sourceId),
    subscribe: (listener) => session.subscribe(listener),
    getState: () => session.getState(),
    start: (overrides, signal) => session.start(overrides, signal),
    getTranscript: (query) => session.getTranscript(query),
    waitForTranscript: (query, signal) => session.waitForTranscript(query, signal),
    stop: () => session.stop(),
    destroy: () => {
      destroyPromise ??= session.destroy();
      return destroyPromise;
    },
  };
}
