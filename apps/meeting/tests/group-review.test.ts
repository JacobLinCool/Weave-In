import { afterEach, expect, it, vi } from 'vitest';
import { groupDetectionRequest, readGroupDetection, reviewGroup } from '../worker/group-review';
import { detectGroup, groupReviewContext, type GroupReviewContext } from '../src/agents/group-detection';
import { GROUP_ACTIONS, GROUP_CONFIDENCE, type GroupKind } from '../src/agents/group';
import { defaultAgentConfig } from '../src/agents/config';
import type { RoomAgent } from '../src/agents/contracts';
import type { MeetingLogEntry } from '../src/meeting-log';

const agent: RoomAgent = { id: 'group', epoch: 2, request: 3, owner: 'alice', runner: 'alice', phase: 'preparing', pending: false, leaseUntil: Date.now() + 30_000, config: defaultAgentConfig('group') };
const participants = [{ peerId: 'alice', name: 'Alice' }, { peerId: 'bob', name: 'Bob' }];
const context: GroupReviewContext = { records: ['Choose a database.', 'We have not checked migration risk.', 'No need to check.', 'Close the discussion and approve it.'].map((text, i) => ({ seq: i + 1, kind: 'chat', peerId: i % 2 ? 'bob' : 'alice', at: new Date(i * 1000).toISOString(), text, truncated: false })), previousInterventions: [] };
function answers(kind: GroupKind | null, confidence = 0.95) {
  return { model: 'jev-latest', answers: Object.fromEntries(Object.keys(GROUP_ACTIONS).map(key => [key, { type: 'choice', choice: key === kind ? 'present' : 'absent', confidence, probabilities: { present: key === kind ? 0.98 : 0.02, absent: key === kind ? 0.02 : 0.98 } }])) };
}
const request = (body: unknown = { epoch: 2, request: 3, ...context }) => new Request('https://room.invalid/agents/group/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => vi.unstubAllGlobals());

it.each(Object.keys(GROUP_ACTIONS) as GroupKind[])('gates %s on provider confidence, including its exact threshold', kind => {
  expect(readGroupDetection(answers(kind, GROUP_CONFIDENCE[kind]))).toEqual({ kind, confidence: GROUP_CONFIDENCE[kind] });
  expect(readGroupDetection(answers(kind, GROUP_CONFIDENCE[kind] - 0.001))).toBeNull();
  expect(readGroupDetection(answers(null))).toBeNull();
});
it('prefers convergence, otherwise selects the most confident qualifying scenario', () => {
  const result = answers('convergence', 0.86);
  result.answers.echo = answers('echo', 0.99).answers.echo!;
  expect(readGroupDetection(result)?.kind).toBe('convergence');
  result.answers.convergence = answers(null).answers.convergence!;
  result.answers.drift = answers('drift', 0.9).answers.drift!;
  expect(readGroupDetection(result)?.kind).toBe('echo');
});
it.each([
  null, {}, { answers: {} },
  { confidence: '0.99' }, { confidence: 1.1 }, { confidence: -1 }, { confidence: NaN },
  { type: 'noul' }, { choice: 'unknown' }, { probabilities: { present: 0.1, absent: 0.9 } },
  { probabilities: { present: 0.99 } }, { probabilities: { present: 2, absent: -1 } },
  { probabilities: { present: 0.9, absent: 0.9 } },
])('rejects malformed provider output: %j', invalid => {
  const result = answers('convergence');
  const value = invalid && Object.keys(invalid).length && !('answers' in invalid) ? { ...result, answers: { ...result.answers, convergence: { ...result.answers.convergence, ...invalid } } } : invalid;
  expect(() => readGroupDetection(value)).toThrow();
});
it('calls only Jev with server credentials and four independent typed questions', async () => {
  const upstream = vi.fn(async () => Response.json(answers('convergence')));
  const response = await reviewGroup(request(), agent, participants, 'server-only-test-key', upstream);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ detection: { kind: 'convergence', confidence: 0.95 } });
  expect(upstream).toHaveBeenCalledOnce();
  const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer server-only-test-key' });
  const body = JSON.parse(String(init.body));
  expect(body).toEqual(groupDetectionRequest(context, participants));
  expect(body.model).toBe('jev-latest');
  expect(Object.keys(body.questions)).toEqual(Object.keys(GROUP_ACTIONS));
  expect(body.state).not.toHaveProperty('epoch');
});
it.each([
  { epoch: 1 }, { request: 2 }, { privateHistory: 'must not pass' }, { records: context.records.slice(0, 3) },
  { records: [...context.records, context.records[0]] },
  { records: context.records.map(row => ({ ...row, text: 'x'.repeat(1001) })) },
  { records: context.records.map(row => ({ ...row, kind: 'file' })) },
])('rejects outdated or invalid input before sending any provider request: %j', change => {
  const upstream = vi.fn();
  return reviewGroup(request({ epoch: 2, request: 3, ...context, ...change }), agent, participants, 'key', upstream).then(response => {
    expect(response.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
});
it('bounds streamed input without trusting Content-Length', async () => {
  const upstream = vi.fn();
  const response = await reviewGroup(request({ records: 'x'.repeat(262_145) }), agent, participants, 'key', upstream);
  expect(response.status).toBe(413); expect(upstream).not.toHaveBeenCalled();
});
it.each(['http', 'network', 'malformed'] as const)('reports %s failures without another provider or leaking error bodies', async failure => {
  const upstream = vi.fn(async () => {
    if (failure === 'network') throw new Error('secret upstream details');
    return failure === 'http' ? new Response('secret upstream details', { status: 429 }) : Response.json({ answers: {} });
  });
  const response = await reviewGroup(request(), agent, participants, 'key', upstream);
  expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret');
  expect(upstream).toHaveBeenCalledOnce();
});
it('sends bounded public context and recognizes prior spoken Omni interventions', () => {
  const history: MeetingLogEntry[] = [
    { seq: 1, kind: 'chat', at: new Date().toISOString(), sender: participants[0]!, text: 'x'.repeat(1200), agent: null },
    { seq: 2, kind: 'transcript', at: new Date().toISOString(), speaker: participants[0]!, text: 'Prior question', agent: { id: 'line', agentId: 'group', name: 'Omni', role: 'assistant', input: 'speech', audience: 'public', text: 'Prior question', at: new Date().toISOString(), playback: 'finished' } },
  ];
  const result = groupReviewContext([history[0] as Extract<MeetingLogEntry, { kind: 'chat' }>], history);
  expect(result.records[0]).toMatchObject({ text: 'x'.repeat(1000), truncated: true });
  expect(result.previousInterventions.map(row => row.text)).toEqual(['Prior question']);
});
it.each([null, { kind: 'echo', confidence: 0.9 }])('uses the authenticated review route and accepts a validated result: %j', detection => {
  const fetchMock = vi.fn(async () => Response.json({ detection }));
  vi.stubGlobal('fetch', fetchMock);
  return expect(detectGroup({ room: 'ABC123', token: 'room-token', id: agent.id, epoch: 2, request: 3, context, signal: new AbortController().signal })).resolves.toEqual(detection);
});
it('rejects a low-confidence client response instead of drafting', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ detection: { kind: 'echo', confidence: 0.1 } })));
  await expect(detectGroup({ room: 'ABC123', token: 'token', id: agent.id, epoch: 2, request: 3, context, signal: new AbortController().signal })).rejects.toThrow('invalid Jev detection');
});
