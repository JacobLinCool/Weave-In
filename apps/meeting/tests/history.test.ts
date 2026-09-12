import { describe, expect, it } from 'vitest';
import { batchHistory, compareTime, insertByTime, selectHistory } from '../src/history';
import { MAX_HISTORY_BATCH_ENTRIES, MAX_PEER_MESSAGE_BYTES, parsePeerMessage, type HistoryEntry } from '../src/protocol';

function chat(index: number, text = `message ${index}`): HistoryEntry {
  return { kind: 'chat', id: `c${index}`, text, at: new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(), agent: null };
}

describe('history replay', () => {
  it('selects the most recent entries in time order regardless of input order', () => {
    const entries = [chat(5), chat(1), { kind: 'transcript', id: 't3', text: 'three', at: chat(3).at } as HistoryEntry, chat(2), chat(4)];
    expect(selectHistory(entries, 3).map((entry) => entry.id)).toEqual(['t3', 'c4', 'c5']);
    expect(selectHistory(entries).map((entry) => entry.id)).toEqual(['c1', 'c2', 't3', 'c4', 'c5']);
  });

  it('batches entries under the data-channel frame limit and flags the last batch', () => {
    const entries = Array.from({ length: 30 }, (_, index) => chat(index, 'x'.repeat(1_500)));
    const batches = batchHistory(entries);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.map((batch) => batch.type === 'history' && batch.more)).toEqual([...batches.slice(1).map(() => true), false]);
    for (const batch of batches) {
      expect(JSON.stringify(batch).length).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
      expect(parsePeerMessage(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
    }
    expect(batches.flatMap((batch) => (batch.type === 'history' ? batch.entries : [])).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    const many = batchHistory(Array.from({ length: MAX_HISTORY_BATCH_ENTRIES + 1 }, (_, index) => chat(index, 'x')));
    expect(many).toHaveLength(2);
    expect(batchHistory([])).toEqual([{ type: 'history', entries: [], more: false }]);
  });

  it('inserts replayed items by time after live items that are not newer', () => {
    const list = [chat(1), chat(3), chat(5)];
    expect(insertByTime(list, chat(4)).map((entry) => entry.id)).toEqual(['c1', 'c3', 'c4', 'c5']);
    expect(insertByTime(list, chat(0)).map((entry) => entry.id)).toEqual(['c0', 'c1', 'c3', 'c5']);
    expect(insertByTime(list, chat(9)).map((entry) => entry.id)).toEqual(['c1', 'c3', 'c5', 'c9']);
    const twin = { ...chat(3), id: 'twin' };
    expect(insertByTime(list, twin).map((entry) => entry.id)).toEqual(['c1', 'c3', 'twin', 'c5']);
    expect(compareTime('not a date', 'z')).toBeLessThan(0);
  });
});
