export const GEMINI_MODEL = 'gemini-3.5-transcribe-live' as const;
export const OPENAI_MODEL = 'gpt-live-transcribe' as const;

export type TranscriptionProvider = 'gemini' | 'openai';

export type TranscriptionStatus =
  | 'idle'
  | 'starting'
  | 'transcribing'
  | 'stopping'
  | 'stopped'
  | 'error';

export type TranscriptionMode = 'SMART' | 'VERBATIM';

export interface TranscriptionOptions {
  provider: TranscriptionProvider;
  /** BCP-47 codes the speaker uses; an empty array enables automatic detection. */
  languageCodes: string[];
  mode: TranscriptionMode;
  customVocabulary: string[];
}

export interface StartTranscriptionInput {
  provider?: TranscriptionProvider;
  languageCodes?: string[];
  mode?: TranscriptionMode;
  customVocabulary?: string[];
}

export interface ApiKeyCredential {
  type: 'api-key';
  value: string;
}

export interface EphemeralTokenCredential {
  type: 'ephemeral-token';
  value: string;
}

export type Credential = ApiKeyCredential | EphemeralTokenCredential;
export type CredentialProvider = (context: {
  reason: 'initial' | 'rotation';
  /** One-based connection number; failed reconnect attempts reuse the next number. */
  connection: number;
  provider: TranscriptionProvider;
}) => Promise<Credential>;
export type CredentialInput = Credential | CredentialProvider;

export interface AudioSourceOptions {
  id?: string;
  /** Per-track gain in the range 0–4; defaults to 1. */
  gain?: number;
  /** Stop tracks on removal or audio resource cleanup; defaults to false. */
  owned?: boolean;
}

export interface TranscriptSegment {
  id: number;
  text: string;
  receivedAt: string;
  connection: number;
}

export interface TranscriptError {
  code: string;
  message: string;
  occurredAt: string;
}

export interface TranscriptState {
  status: TranscriptionStatus;
  sessionId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  interim: string;
  segments: TranscriptSegment[];
  nextSegmentId: number;
  droppedSegments: number;
  connectionCount: number;
  audioSourceCount: number;
  options: TranscriptionOptions;
  error: TranscriptError | null;
}

export interface TranscriptQuery {
  afterSegmentId?: number;
  /** Finalized-text budget in UTF-16 code units, clamped to 256–50,000. */
  maxChars?: number;
  /** Include current interim text outside maxChars; defaults to true. */
  includeInterim?: boolean;
}

export interface TranscriptWaitQuery extends TranscriptQuery {
  /** Wait for finalized text or lifecycle changes, up to 30,000 ms; defaults to 0. */
  waitMs?: number;
}

export interface TranscriptQueryResult {
  status: TranscriptionStatus;
  sessionId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  segments: TranscriptSegment[];
  interim: string;
  cursor: number;
  latestSegmentId: number;
  hasMore: boolean;
  historyTruncated: boolean;
  droppedSegments: number;
  connectionCount: number;
  error: TranscriptError | null;
}

export type CommandResult<T = unknown> =
  | { ok: true; code: string; message: string; data: T }
  | { ok: false; code: string; message: string; data?: T };

export interface SessionSummary {
  status: TranscriptionStatus;
  sessionId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  segmentCount: number;
  latestSegmentId: number;
  connectionCount: number;
  audioSourceCount: number;
  error: TranscriptError | null;
}

export type StateListener = (state: TranscriptState) => void;

export const DEFAULT_OPTIONS: Readonly<TranscriptionOptions> = Object.freeze({
  provider: 'gemini',
  languageCodes: [],
  mode: 'VERBATIM',
  customVocabulary: [],
});

export function cloneOptions(options: TranscriptionOptions): TranscriptionOptions {
  return {
    ...options,
    languageCodes: [...options.languageCodes],
    customVocabulary: [...options.customVocabulary],
  };
}

export const DEFAULT_TRANSCRIPT_QUERY = Object.freeze({
  maxChars: 50_000,
  includeInterim: true,
});

export function createInitialState(): TranscriptState {
  return {
    status: 'idle',
    sessionId: null,
    startedAt: null,
    stoppedAt: null,
    interim: '',
    segments: [],
    nextSegmentId: 1,
    droppedSegments: 0,
    connectionCount: 0,
    audioSourceCount: 0,
    options: cloneOptions(DEFAULT_OPTIONS),
    error: null,
  };
}

export function success<T>(code: string, message: string, data: T): CommandResult<T> {
  return { ok: true, code, message, data };
}

export function failure<T = never>(
  code: string,
  message: string,
  data?: T,
): CommandResult<T> {
  return data === undefined ? { ok: false, code, message } : { ok: false, code, message, data };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
