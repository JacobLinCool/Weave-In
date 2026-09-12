import { describe, expect, it } from 'vitest';

import { cloneOptions, DEFAULT_OPTIONS } from '../src/contracts';
import { queryTranscriptState, TranscriptStore } from '../src/transcript-store';

describe('TranscriptStore', () => {
  it('normalizes interim and final text before snapshots, queries, and segmentation', () => {
    const store = new TranscriptStore();
    store.begin({
      sessionId: 'traditional',
      options: { ...cloneOptions(DEFAULT_OPTIONS), languageCodes: ['cmn-Hant-TW', 'en-US'] },
      audioSourceCount: 1,
    });
    store.setInterim(' 这个软件\n很好。 ');
    expect(store.snapshot().interim).toBe('這個軟件 很好。');
    expect(store.query().interim).toBe('這個軟件 很好。');
    const appended = store.appendFinal('这个软件很好。'.repeat(80), 2);
    expect(appended.length).toBeGreaterThan(1);
    expect(appended.map((segment) => segment.text).join('')).toBe('這個軟件很好。'.repeat(80));
    expect(store.query().segments).toEqual(appended);
    expect(store.snapshot().segments).toEqual(appended);
    expect(store.snapshot().interim).toBe('');
  });

  it('recomputes the script preference when starting another session', () => {
    const store = new TranscriptStore();
    for (const languageCodes of [
      ['cmn-Hant-TW'], ['cmn-Hant-TW', 'cmn-Hans-CN'], [], ['cmn-Hant-TW'],
    ]) {
      store.begin({
        sessionId: 'restart',
        options: { ...cloneOptions(DEFAULT_OPTIONS), languageCodes },
        audioSourceCount: 1,
      });
      const expected = languageCodes.length === 1 ? '這個軟件' : '这个软件';
      store.setInterim('这个软件');
      expect(store.query().interim).toBe(expected);
      expect(store.appendFinal('这个软件', 1)[0]?.text).toBe(expected);
    }
  });

  it('keeps converted supplementary characters intact at segment boundaries', () => {
    const store = new TranscriptStore();
    store.begin({
      sessionId: 'unicode',
      options: { ...cloneOptions(DEFAULT_OPTIONS), languageCodes: ['cmn-Hant-TW'] },
      audioSourceCount: 1,
    });
    const segments = store.appendFinal('a'.repeat(255) + '㓆汉', 1);
    expect(segments.map((segment) => segment.text)).toEqual(['a'.repeat(255), '𠗣漢']);
    expect(segments.every((segment) => segment.text.isWellFormed())).toBe(true);
  });

  it('uses the language preference from restored state for new text', () => {
    const initial = new TranscriptStore().snapshot();
    initial.options.languageCodes = ['cmn-Hant-TW'];
    const store = new TranscriptStore(undefined, initial);
    store.setInterim('汉语');
    expect(store.query().interim).toBe('漢語');
    expect(store.appendFinal('汉语', 1)[0]?.text).toBe('漢語');
  });

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

  it.each(['.', '。', '！', '？'])('keeps a %s at the query boundary pageable', (punctuation) => {
    const store = new TranscriptStore();
    const transcript = 'a'.repeat(256) + punctuation + 'b'.repeat(256);
    store.appendFinal(transcript, 1);

    let cursor = 0;
    const received: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = store.query({ afterSegmentId: cursor, maxChars: 256 });
      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.segments.reduce((length, segment) => length + segment.text.length, 0))
        .toBeLessThanOrEqual(256);
      expect(result.cursor).toBeGreaterThan(cursor);
      received.push(...result.segments.map((segment) => segment.text));
      cursor = result.cursor;
      if (!result.hasMore) break;
    }
    expect(received.join('')).toBe(transcript);
    expect(store.query({ afterSegmentId: cursor }).segments).toEqual([]);
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
