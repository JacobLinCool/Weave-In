import type { AgentLine } from '../src/agents/contracts';
import { describe, expect, it } from 'vitest';
import { loadMeetingSession, saveMeetingSession, SESSION_TTL, type MeetingSession } from '../src/meeting-session';
import { MeetingLog } from '../src/meeting-log';
import { PrivateNotices } from '../src/private-notices';
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function fixture(): MeetingSession {
  const log = new MeetingLog();
  log.append({
    kind: 'transcript',
    at: '2026-09-12T00:00:00Z',
    speaker: { peerId: 'a'.repeat(32), name: 'Alice' },
    text: 'Concern',
  });
  const notices = new PrivateNotices();
  notices.show({ id: 'auto-1', text: 'Check the concern', evidenceSeqs: [1] }, log, 1000);
  notices.dismiss('auto-1');
  return {
    version: 1,
    savedAt: 1000,
    roomCode: 'ABCDEF',
    peerId: 'a'.repeat(32),
    name: 'Alice',
    startedAt: 100,
    joinedAt: '2026-09-12T00:00:00Z',
    log: log.snapshot(),
    messages: [],
    transcript: [
      { id: 'one', from: 'self', name: 'Alice', color: '#fff', at: '2026-09-12T00:00:00Z', own: true, text: 'Concern' },
    ],
    notices: notices.getSnapshot(),
  };
}
function chatLine(id = 'line_1'): AgentLine {
  return { id, agentId: 'chat_1', name: 'Muse', role: 'assistant', input: 'text', audience: 'private',
    text: 'We still need to address your concern.', at: '2026-09-12T00:00:00Z', playback: 'not-played' };
}
describe('same-tab room recovery', () => {
  it('restores identity, text, evidence and dismissed state only for the same room', () => {
    const s = storage();
    const value = fixture();
    expect(saveMeetingSession(value, s)).toBe(true);
    expect(loadMeetingSession('ABCDEF', s, 2000)).toEqual(value);
    expect(loadMeetingSession('ZZZZZZ', s, 2000)).toBeNull();
    expect(loadMeetingSession('ABCDEF', s, 1001 + SESSION_TTL)).toBeNull();
  });
  it('does not share history between separate browser tab stores', () => {
    const a = storage(),
      b = storage();
    saveMeetingSession(fixture(), a);
    expect(loadMeetingSession('ABCDEF', b, 2000)).toBeNull();
  });
  it('rejects corrupt storage and handles blocked storage without throwing', () => {
    const s = storage();
    saveMeetingSession({ ...fixture(), log: [{ seq: 1 } as never] }, s);
    expect(loadMeetingSession('ABCDEF', s, 2000)).toBeNull();
    expect(
      saveMeetingSession(fixture(), {
        ...s,
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).toBe(false);
    expect(loadMeetingSession('ABCDEF', { ...s, getItem: () => '{broken' }, 2000)).toBeNull();
  });
  it('restores a bounded log without changing evidence sequence numbers or duplicating subsequent entries', () => {
    const log = new MeetingLog();
    for (let i = 0; i < 2500; i++)
      log.append({ kind: 'transcript', at: 'a', speaker: { peerId: 'a', name: 'Alice' }, text: String(i) });
    const recovered = new MeetingLog();
    recovered.restore(log.snapshot());
    expect(recovered.head).toBe(2500);
    expect(recovered.read(500, 1).entries[0]?.seq).toBe(501);
    expect(recovered.read(2499, 1).entries[0]?.seq).toBe(2500);
    expect(recovered.read(0, 1).entries[0]?.seq).toBe(501);
    expect(
      recovered.append({ kind: 'presence', at: 'a', participant: { peerId: 'a', name: 'Alice' }, event: 'joined' }).seq,
    ).toBe(2501);
  });
  it('accepts cursor gaps after agent updates but rejects duplicate or reordered entries', () => {
    const s = storage();
    const value = fixture();
    const entry = value.log[0]!;
    value.log = [{ ...entry, seq: 2 }, { ...entry, seq: 5 }];
    saveMeetingSession(value, s);
    expect(loadMeetingSession('ABCDEF', s, 2000)?.log.map((row) => row.seq)).toEqual([2, 5]);
    for (const seq of [1, 2]) {
      value.log = [{ ...entry, seq: 2 }, { ...entry, seq }];
      saveMeetingSession(value, s);
      expect(loadMeetingSession('ABCDEF', s, 2000)).toBeNull();
    }
  });
  it('expires restored active reminders without resurfacing dismissed ones', () => {
    const notices = new PrivateNotices();
    const value = fixture();
    notices.restore(value.notices);
    expect(notices.getSnapshot().notices[0]?.status).toBe('dismissed');
    notices.restore({ ...value.notices, notices: value.notices.notices.map((n) => ({ ...n, status: 'active' })) });
    expect(notices.getSnapshot().notices[0]?.status).toBe('expired');
  });
  it('recovers private Muse in its original tab and room, bounds history, and omits public lines', () => {
    const s = storage();
    const value = fixture();
    value.personalChat = Array.from({ length: 205 }, (_, index) => chatLine(`line_${index}`));
    value.personalChat.push({ ...chatLine('public_line'), audience: 'public' });
    expect(saveMeetingSession(value, s)).toBe(true);
    const restored = loadMeetingSession('ABCDEF', s, 2000);
    expect(restored?.personalChat).toHaveLength(200);
    expect(restored?.personalChat?.[0]?.id).toBe('line_5');
    expect(restored?.personalChat?.at(-1)?.id).toBe('line_204');
    expect(loadMeetingSession('ZZZZZZ', s, 2000)).toBeNull();
    expect(loadMeetingSession('ABCDEF', storage(), 2000)).toBeNull();
  });
  it('rejects malformed private Muse checkpoints, including a public audience', () => {
    const invalid = [null, { ...chatLine(), audience: 'public' }, { ...chatLine(), role: 'system' },
      { ...chatLine(), id: '' }, { ...chatLine(), at: 'invalid' }, { ...chatLine(), playback: 'unknown' },
      { ...chatLine(), text: 'x'.repeat(4001) }];
    for (const line of invalid) {
      const source = { ...storage(), getItem: () => JSON.stringify({ ...fixture(), personalChat: [line] }) };
      expect(loadMeetingSession('ABCDEF', source, 2000)).toBeNull();
    }
  });
  it('trims private Muse along with other history to stay within the checkpoint budget', () => {
    const s = storage();
    const value = fixture();
    value.personalChat = Array.from({ length: 200 }, (_, index) => ({ ...chatLine(`line_${index}`), text: 'x'.repeat(4000) }));
    const entry = value.log[0]!;
    value.log = Array.from({ length: 1000 }, (_, index) => ({ ...entry, seq: index + 1, text: 'x'.repeat(2000) }));
    expect(saveMeetingSession(value, s)).toBe(true);
    const restored = loadMeetingSession('ABCDEF', s, 2000);
    expect(restored).not.toBeNull();
    expect(restored?.personalChat?.length).toBeLessThan(200);
    expect(restored?.personalChat?.at(-1)?.id).toBe('line_199');
  });

});
