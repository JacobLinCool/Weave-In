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
  it('preserves cursor gaps from agent updates through recovery and permission filtering', () => {
    const log = new MeetingLog();
    const line = { id: 'line_1', agentId: 'agent_1', name: 'Chat', role: 'assistant' as const,
      input: 'text' as const, audience: 'private' as const, text: 'Draft', at: '2026-09-12T00:00:00Z', playback: 'not-played' as const };
    log.append({ kind: 'presence', at: line.at, participant: alice, event: 'joined' });
    log.upsertAgent(line, alice.peerId);
    log.append({ kind: 'chat', at: line.at, sender: alice, text: 'Public', agent: null });
    log.upsertAgent({ ...line, text: 'Final' }, alice.peerId);
    const recovered = new MeetingLog();
    recovered.restore(log.snapshot());
    expect(recovered.read(1, 1)).toMatchObject({ entries: [{ seq: 3, text: 'Public' }], nextCursor: 3, hasMore: true });
    expect(recovered.read(3).entries).toMatchObject([{ seq: 4, text: 'Final' }]);
    expect(recovered.read().entries.filter((entry) => entry.kind === 'transcript')).toHaveLength(1);
    const publicLog = recovered.filtered((entry) => entry.kind !== 'transcript');
    expect(publicLog.read(1)).toMatchObject({ entries: [{ seq: 3 }], nextCursor: 4, hasMore: false });
    expect(publicLog.read(4)).toEqual({ entries: [], nextCursor: 4, hasMore: false });
    expect(recovered.append({ kind: 'presence', at: line.at, participant: alice, event: 'left' }).seq).toBe(5);
  });

});
