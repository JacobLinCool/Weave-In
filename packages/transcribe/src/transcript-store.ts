import {
  cloneOptions,
  createInitialState,
  type TranscriptError,
  type TranscriptQuery,
  type TranscriptQueryResult,
  type TranscriptSegment,
  type TranscriptState,
  type TranscriptionOptions,
} from './contracts';
import { prefersTraditionalChinese, toTraditionalCharacters } from './chinese-script';

const MAX_STORED_CHARACTERS = 500_000;
const DEFAULT_QUERY_CHARACTERS = 50_000;
const MIN_QUERY_CHARACTERS = 256;
const MAX_QUERY_CHARACTERS = 50_000;
const MAX_SEGMENT_CHARACTERS = MIN_QUERY_CHARACTERS;

export class TranscriptStore {
  readonly #now: () => Date;
  #state: TranscriptState;
  #storedCharacters = 0;
  #useTraditionalCharacters: boolean;

  constructor(now: () => Date = () => new Date(), initial?: TranscriptState) {
    this.#now = now;
    this.#state = initial ? cloneState(initial) : createInitialState();
    this.#useTraditionalCharacters = prefersTraditionalChinese(this.#state.options.languageCodes);
    this.#storedCharacters = this.#state.segments.reduce(
      (total, segment) => total + segment.text.length,
      0,
    );
  }

  begin(args: { sessionId: string; options: TranscriptionOptions; audioSourceCount: number }): void {
    this.#state = {
      ...createInitialState(),
      status: 'starting',
      sessionId: args.sessionId,
      startedAt: this.#now().toISOString(),
      audioSourceCount: args.audioSourceCount,
      options: cloneOptions(args.options),
    };
    this.#storedCharacters = 0;
    this.#useTraditionalCharacters = prefersTraditionalChinese(this.#state.options.languageCodes);
  }

  setAudioSourceCount(count: number): void {
    this.#state.audioSourceCount = count;
  }

  markTranscribing(connectionCount: number): void {
    this.#state.status = 'transcribing';
    this.#state.connectionCount = connectionCount;
    this.#state.error = null;
  }

  markStopping(): void {
    if (this.#state.status === 'transcribing' || this.#state.status === 'starting') {
      this.#state.status = 'stopping';
    }
  }

  markStopped(): void {
    this.#state.status = 'stopped';
    this.#state.stoppedAt = this.#now().toISOString();
    this.#state.interim = '';
  }

  markError(code: string, message: string): void {
    const error: TranscriptError = {
      code,
      message,
      occurredAt: this.#now().toISOString(),
    };
    this.#state.status = 'error';
    this.#state.error = error;
    this.#state.stoppedAt = this.#now().toISOString();
    this.#state.interim = '';
  }

  setInterim(text: string): void {
    this.#state.interim = this.#normalizeTranscript(text);
  }

  appendFinal(text: string, connection: number): TranscriptSegment[] {
    const chunks = splitTranscript(this.#normalizeTranscript(text));
    const appended: TranscriptSegment[] = [];
    for (const chunk of chunks) {
      const segment: TranscriptSegment = {
        id: this.#state.nextSegmentId,
        text: chunk,
        receivedAt: this.#now().toISOString(),
        connection,
      };
      this.#state.nextSegmentId += 1;
      this.#state.segments.push(segment);
      this.#storedCharacters += chunk.length;
      appended.push(segment);
    }
    this.#state.interim = '';
    this.#enforceStorageLimit();
    return appended;
  }

  snapshot(): TranscriptState {
    return cloneState(this.#state);
  }

  query(input: TranscriptQuery = {}): TranscriptQueryResult {
    return queryTranscriptState(this.#state, input);
  }

  #normalizeTranscript(text: string): string {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    return this.#useTraditionalCharacters ? toTraditionalCharacters(normalized) : normalized;
  }

  #enforceStorageLimit(): void {
    while (this.#storedCharacters > MAX_STORED_CHARACTERS && this.#state.segments.length > 1) {
      const removed = this.#state.segments.shift();
      if (!removed) break;
      this.#storedCharacters -= removed.text.length;
      this.#state.droppedSegments += 1;
    }
  }
}

export function queryTranscriptState(
  state: TranscriptState,
  input: TranscriptQuery = {},
): TranscriptQueryResult {
  const afterSegmentId = toBoundedInteger(input.afterSegmentId, 0, Number.MAX_SAFE_INTEGER, 0);
  const maxChars = toBoundedInteger(
    input.maxChars,
    MIN_QUERY_CHARACTERS,
    MAX_QUERY_CHARACTERS,
    DEFAULT_QUERY_CHARACTERS,
  );
  const includeInterim = input.includeInterim ?? true;
  const earliestSegmentId = state.segments[0]?.id ?? state.nextSegmentId;
  const latestSegmentId = state.nextSegmentId - 1;
  const available = state.segments.filter((segment) => segment.id > afterSegmentId);
  const selected: TranscriptSegment[] = [];
  let usedCharacters = 0;

  for (const segment of available) {
    if (usedCharacters + segment.text.length > maxChars) break;
    selected.push({ ...segment });
    usedCharacters += segment.text.length;
  }

  const cursor = selected.at(-1)?.id ?? Math.min(afterSegmentId, latestSegmentId);
  return {
    status: state.status,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    segments: selected,
    interim: includeInterim ? state.interim : '',
    cursor,
    latestSegmentId,
    hasMore: available.length > selected.length,
    historyTruncated:
      state.droppedSegments > 0 && afterSegmentId < Math.max(0, earliestSegmentId - 1),
    droppedSegments: state.droppedSegments,
    connectionCount: state.connectionCount,
    error: state.error ? { ...state.error } : null,
  };
}

function cloneState(state: TranscriptState): TranscriptState {
  return {
    ...state,
    segments: state.segments.map((segment) => ({ ...segment })),
    options: cloneOptions(state.options),
    error: state.error ? { ...state.error } : null,
  };
}

function splitTranscript(text: string): string[] {
  if (!text) return [];
  if (text.length <= MAX_SEGMENT_CHARACTERS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_SEGMENT_CHARACTERS) {
    const candidate = remaining.slice(0, MAX_SEGMENT_CHARACTERS + 1);
    const breakAt = Math.max(
      candidate.lastIndexOf(' '),
      candidate.lastIndexOf('。'),
      candidate.lastIndexOf('！'),
      candidate.lastIndexOf('？'),
      candidate.lastIndexOf('.'),
    );
    let end = breakAt >= MAX_SEGMENT_CHARACTERS / 2 ? breakAt + 1 : MAX_SEGMENT_CHARACTERS;
    const boundary = remaining.codePointAt(end - 1);
    if (boundary !== undefined && boundary > 0xffff) end -= 1;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function toBoundedInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
