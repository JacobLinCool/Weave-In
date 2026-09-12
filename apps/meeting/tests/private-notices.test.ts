import { describe, expect, it } from 'vitest';
import { MeetingLog } from '../src/meeting-log';
import { PrivateNotices } from '../src/private-notices';

function fixture() {
  const log = new MeetingLog();
  log.append({ kind: 'transcript', at: 'a', speaker: { peerId: 'alice', name: 'Alice' }, text: 'Maintenance needs funding.' });
  return { log, store: new PrivateNotices(), input: { id: 'cost', text: 'Your maintenance concern has not been answered.', evidenceSeqs: [1] } };
}

describe('private notices lifecycle', () => {
  it('collapses a toast without dismissing it or marking it read, including after recovery', () => {
    const {store, log, input} = fixture(); store.show(input,log);store.collapse(input.id);
    expect(store.getSnapshot().notices[0]).toMatchObject({status:'active',collapsed:true});
    expect(store.getSnapshot().notices[0]?.read).not.toBe(true);
    const restored = new PrivateNotices();restored.restore(store.getSnapshot());
    expect(restored.getSnapshot()).toEqual(store.getSnapshot());
  });
  it('marks only viewed reminders read and does not resurface them on retries', () => {
    const {store, log, input} = fixture();store.show(input,log);store.markRead([input.id]);
    expect(store.show(input,log)).toMatchObject({read:true,collapsed:true,status:'active'});
    store.show({...input,id:'next'},log);
    expect(store.getSnapshot().notices[0]?.read).not.toBe(true);
  });

  it('keeps one active reminder and never resurfaces a dismissed id on retry', () => {
    const { store, log, input } = fixture();
    store.show(input, log, 0);
    store.dismiss(input.id);
    expect(store.show(input, log, 1000).status).toBe('dismissed');
    store.show({ ...input, id: 'second' }, log, 1000);
    store.show({ ...input, id: 'third' }, log, 2000);
    expect(store.getSnapshot().notices.map((n) => n.status)).toEqual(['active', 'replaced', 'dismissed']);
  });
  it('expires without resetting the deadline on repeated calls', () => {
    const { store, log, input } = fixture();
    store.show(input, log, 0);
    expect(store.show(input, log, 1000).expiresAt).toBe(120000);
    store.expire(120000);
    expect(store.getSnapshot().notices[0]?.status).toBe('expired');
    expect(store.show(input, log, 121000).status).toBe('expired');
  });
  it('hides future reminders too and clears private state between meetings', () => {
    const { store, log, input } = fixture();
    store.setHidden(true);
    store.show(input, log, 0);
    expect(store.getSnapshot().hidden).toBe(true);
    store.clear();
    expect(store.getSnapshot()).toEqual({ hidden: false, notices: [] });
  });
  it('bounds history and keeps different browser stores independent', () => {
    const { store, log, input } = fixture();
    for (let i = 0; i < 60; i++) store.show({ ...input, id: `n${i}` }, log, i);
    expect(store.getSnapshot().notices).toHaveLength(50);
    expect(new PrivateNotices().getSnapshot().notices).toEqual([]);
  });
  it.each([
    { text: ' ' }, { text: 'a'.repeat(241) }, { id: '../bad' }, { evidenceSeqs: [2] },
    { evidenceSeqs: [0] }, { evidenceSeqs: [] }, { ttlSeconds: 301 }, { ttlSeconds: '60' }, { target: 'someone-else' },
  ])('rejects malformed inputs: %j', (invalid) => {
    const { store, log, input } = fixture();
    expect(() => store.show({ ...input, ...invalid }, log, 0)).toThrow();
    expect(store.getSnapshot().notices).toEqual([]);
  });
});
