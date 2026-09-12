import { describe, expect, it } from 'vitest';

import { cloneOptions, DEFAULT_OPTIONS } from '../src/contracts';
import { queryTranscriptState, TranscriptStore } from '../src/transcript-store';

describe('TranscriptStore', () => {
  it('keeps a stable cursor and remains readable after stop', () => {
    const store = new TranscriptStore(() => new Date('2026-08-27T00:00:00.000Z'));
    store.begin({
      sessionId: 'session-1',
      options: cloneOptions(DEFAULT_OPTIONS),
      audioSourceCount: 2,
    });
    store.markTranscribing(1);
    store.appendFinal('The first idea.', 1);
    store.appendFinal('The second idea.', 1);
    const first = store.query({ afterSegmentId: 0, maxChars: 256 });
    expect(first.cursor).toBe(2);
    store.markStopped();
    expect(store.query({ afterSegmentId: first.cursor }).status).toBe('stopped');
    expect(store.query({ afterSegmentId: 0 }).segments).toHaveLength(2);
  });

  it('returns at most 50,000 finalized characters by default', () => {
    const store = new TranscriptStore();
    store.begin({
      sessionId: 'session-2',
      options: cloneOptions(DEFAULT_OPTIONS),
      audioSourceCount: 1,
    });
    store.appendFinal('word '.repeat(12_000), 1);
    const result = store.query();
    const characters = result.segments.reduce((total, segment) => total + segment.text.length, 0);
    expect(characters).toBeGreaterThan(20_000);
    expect(characters).toBeLessThanOrEqual(50_000);
    expect(result.hasMore).toBe(true);
  });

  it('reports a cursor older than retained history', () => {
    const state = {
      ...new TranscriptStore().snapshot(),
      droppedSegments: 4,
      nextSegmentId: 7,
      segments: [
        { id: 5, text: 'retained one', receivedAt: '2026-08-27T00:00:00.000Z', connection: 1 },
        { id: 6, text: 'retained two', receivedAt: '2026-08-27T00:00:01.000Z', connection: 1 },
      ],
    };
    expect(queryTranscriptState(state, { afterSegmentId: 0 }).historyTruncated).toBe(true);
    expect(queryTranscriptState(state, { afterSegmentId: 4 }).historyTruncated).toBe(false);
  });
});
