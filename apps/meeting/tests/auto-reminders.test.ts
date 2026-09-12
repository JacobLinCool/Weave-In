import { describe, expect, it, vi } from 'vitest';
import { AutoReminders } from '../src/auto-reminders';
import { MeetingLog } from '../src/meeting-log';
import { PrivateNotices } from '../src/private-notices';

function setup(
  request = vi.fn<typeof fetch>(async () =>
    Response.json({
      notice: { id: 'auto-1', text: 'Before approving launch, can we check recovery?', evidenceSeqs: [1, 2] },
    }),
  ),
) {
  const log = new MeetingLog();
  const notices = new PrivateNotices();
  const monitor = new AutoReminders(notices, request);
  monitor.start({ log: () => log, you: () => 'alice' });
  const say = (text: string) =>
    log.append({ kind: 'transcript', at: new Date().toISOString(), speaker: { peerId: 'alice', name: 'Alice' }, text });
  say('What happens to data when the connection drops?');
  say('Let us approve Friday launch.');
  return { log, notices, monitor, say, request };
}
describe('automatic private monitoring', () => {
  it('does not analyze chat or replay alone and sends only speech in time order', async () => {
    const log = new MeetingLog();
    const notices = new PrivateNotices();
    const request = vi.fn<typeof fetch>(async () => Response.json({ notice: null }));
    const monitor = new AutoReminders(notices, request);
    monitor.start({ log: () => log, you: () => 'alice' });
    try {
      log.append({
        kind: 'chat',
        at: '2026-09-12T00:00:00Z',
        sender: { peerId: 'alice', name: 'Alice' },
        text: 'Private chat fixture',
        agent: null,
      });
      log.append({
        kind: 'transcript',
        at: '2026-09-12T00:00:02Z',
        speaker: { peerId: 'bob', name: 'Bob' },
        text: 'Decision',
        replayed: true,
      });
      log.append({
        kind: 'transcript',
        at: '2026-09-12T00:00:01Z',
        speaker: { peerId: 'alice', name: 'Alice' },
        text: 'Concern',
        replayed: true,
      });
      await monitor.check(1000);
      expect(request).not.toHaveBeenCalled();
      log.append({
        kind: 'transcript',
        at: '2026-09-12T00:00:03Z',
        speaker: { peerId: 'bob', name: 'Bob' },
        text: 'New speech',
      });
      await monitor.check(2000);
      const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
      expect(body.records.map((r: { text: string }) => r.text)).toEqual(['Concern', 'Decision', 'New speech']);
    } finally {
      monitor.stop();
    }
  });

  it('does not treat private Muse or public agent speech as a human concern', async () => {
    const log = new MeetingLog();
    const request = vi.fn<typeof fetch>(async () => Response.json({ notice: null }));
    const monitor = new AutoReminders(new PrivateNotices(), request);
    monitor.start({ log: () => log, you: () => 'alice' });
    const agent = {
      id: 'line-1',
      agentId: 'chat',
      name: 'Muse',
      role: 'assistant' as const,
      input: 'speech' as const,
      audience: 'private' as const,
      text: 'Private concern',
      at: new Date().toISOString(),
      playback: 'finished' as const,
    };
    try {
      log.upsertAgent(agent, 'alice');
      log.upsertAgent({ ...agent, id: 'line-2', audience: 'public', text: 'Public agent decision' }, 'alice');
      await monitor.check(1000);
      expect(request).not.toHaveBeenCalled();
      log.append({
        kind: 'transcript',
        at: agent.at,
        speaker: { peerId: 'alice', name: 'Alice' },
        text: 'Human concern',
      });
      log.append({ kind: 'transcript', at: agent.at, speaker: { peerId: 'bob', name: 'Bob' }, text: 'Human decision' });
      await monitor.check(2000);
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).records.map((r: { text: string }) => r.text)).toEqual(
        ['Human concern', 'Human decision'],
      );
    } finally {
      monitor.stop();
    }
  });
  it('runs without MCP and does not add notices to the shared log; skips unchanged text and cools down', async () => {
    const f = setup();
    try {
      await f.monitor.check(1000);
      expect(f.notices.getSnapshot().notices).toHaveLength(1);
      expect(f.log.length).toBe(2);
      expect(JSON.parse(String(f.request.mock.calls[0]?.[1]?.body)).you).toBe('alice');
      f.notices.dismiss('auto-1');
      await f.monitor.check(40000);
      expect(f.request).toHaveBeenCalledTimes(1);
      f.say('Any objections?');
      await f.monitor.check(80000);
      expect(f.request).toHaveBeenCalledTimes(1);
      await f.monitor.check(122000);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.notices.getSnapshot().notices[0]?.status).toBe('dismissed');
    } finally {
      f.monitor.stop();
    }
  });
  it('sends dismissed event evidence and accepts a later decision without periodic re-notification', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ notice: { id: 'auto-1-2', text: 'Check recovery before launch.', evidenceSeqs: [1, 2] } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          notice: { id: 'auto-1-3', text: 'Deployment started; can we pause to check recovery?', evidenceSeqs: [1, 3] },
        }),
      );
    const f = setup(request);
    try {
      await f.monitor.check(1000);
      f.notices.collapse('auto-1-2');
      f.notices.dismiss('auto-1-2');
      await f.monitor.check(200000);
      expect(request).toHaveBeenCalledTimes(1);
      f.say('Deployment has started; we are sending production traffic.');
      await f.monitor.check(201000);
      const body = JSON.parse(String(request.mock.calls[1]?.[1]?.body));
      expect(body.history).toEqual([
        {
          text: 'Check recovery before launch.',
          concernSeq: 1,
          decisionSeq: 2,
          concernText: 'What happens to data when the connection drops?',
          decisionText: 'Let us approve Friday launch.',
        },
      ]);
      expect(f.notices.getSnapshot().notices.map((n) => [n.id, n.status])).toEqual([
        ['auto-1-3', 'active'],
        ['auto-1-2', 'dismissed'],
      ]);
    } finally {
      f.monitor.stop();
    }
  });
  it.each(['leave', 'new reply'])('discards in-flight results after %s', async (action) => {
    let resolve!: (r: Response) => void;
    const f = setup(
      vi.fn<typeof fetch>(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const pending = f.monitor.check(1000);
    if (action === 'leave') f.monitor.stop();
    else f.say('We tested recovery; no data loss.');
    resolve(Response.json({ notice: { id: 'auto-1', text: 'Check recovery', evidenceSeqs: [1, 2] } }));
    await pending;
    expect(f.notices.getSnapshot().notices).toHaveLength(0);
    f.monitor.stop();
  });
  it('retries provider failures with backoff', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => new Response('', { status: 503 })));
    try {
      await f.monitor.check(1000);
      expect(f.monitor.getSnapshot().status).toBe('unavailable');
      await f.monitor.check(30000);
      expect(f.request).toHaveBeenCalledTimes(1);
      await f.monitor.check(61000);
      expect(f.request).toHaveBeenCalledTimes(2);
    } finally {
      f.monitor.stop();
    }
  });
  it('treats no-event results as silence and does not retry until new records', async () => {
    const f = setup(vi.fn<typeof fetch>(async () => Response.json({ notice: null })));
    try {
      await f.monitor.check(1000);
      await f.monitor.check(90000);
      expect(f.notices.getSnapshot().notices).toHaveLength(0);
      expect(f.request).toHaveBeenCalledTimes(1);
    } finally {
      f.monitor.stop();
    }
  });
});
