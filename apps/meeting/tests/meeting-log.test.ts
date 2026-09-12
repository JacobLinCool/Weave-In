import { describe, expect, it } from 'vitest';
import { MeetingLog } from '../src/meeting-log';

const alice = { peerId: 'peer_alice_0001', name: 'Alice' };

describe('meeting log', () => {
  it('numbers entries densely and reads forward from a cursor', () => {
    const log = new MeetingLog();
    for (let index = 1; index <= 5; index += 1) {
      log.append({ kind: 'transcript', at: `2026-09-12T00:00:0${index}.000Z`, speaker: alice, text: `line ${index}` });
    }
    expect(log.head).toBe(5);
    const first = log.read(0, 2);
    expect(first.entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextCursor: 2, hasMore: true });
    const second = log.read(first.nextCursor, 2);
    expect(second.entries.map((entry) => entry.seq)).toEqual([3, 4]);
    const third = log.read(second.nextCursor, 2);
    expect(third.entries.map((entry) => entry.seq)).toEqual([5]);
    expect(third).toMatchObject({ nextCursor: 5, hasMore: false });
    const nothing = log.read(5);
    expect(nothing).toEqual({ entries: [], nextCursor: 5, hasMore: false });
  });

  it('keeps entry kinds intact, bounds the page size, and clears', () => {
    const log = new MeetingLog();
    log.append({ kind: 'presence', at: 'a', participant: alice, event: 'joined' });
    log.append({ kind: 'chat', at: 'b', sender: alice, text: 'hi', agent: 'ChatGPT' });
    log.append({ kind: 'file', at: 'c', sender: alice, file: { id: 'f1', name: 'deck.pdf', size: 10, mime: 'application/pdf' } });
    expect(log.read().entries).toEqual([
      { seq: 1, kind: 'presence', at: 'a', participant: alice, event: 'joined' },
      { seq: 2, kind: 'chat', at: 'b', sender: alice, text: 'hi', agent: 'ChatGPT' },
      { seq: 3, kind: 'file', at: 'c', sender: alice, file: { id: 'f1', name: 'deck.pdf', size: 10, mime: 'application/pdf' } },
    ]);
    expect(log.read(-10, 0).entries).toHaveLength(1);
    expect(log.read(99).entries).toEqual([]);
    log.clear();
    expect(log.length).toBe(0);
    expect(log.append({ kind: 'presence', at: 'd', participant: alice, event: 'left' }).seq).toBe(1);
  });
});
