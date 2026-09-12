import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agents/runtime';
import { emptyAgentRoom, type AgentLine, type RoomAgent } from '../src/agents/contracts';
import type { LiveCallbacks } from '../src/agents/live';
import { MeetingLog } from '../src/meeting-log';

const calls = vi.hoisted(() => ({ lives: [] as LiveCallbacks[], enable: vi.fn(async (): Promise<void> => undefined), mute: vi.fn(async (): Promise<void> => undefined), attach: vi.fn((_stream: MediaStream, _allowed: () => boolean, _level: unknown, _error: (message: string) => void) => ({ stop: vi.fn() })) }));
vi.mock('../src/agents/live', () => ({ AgentLive: class {
  constructor(callbacks: LiveCallbacks) { calls.lives.push(callbacks); }
  async start() {}
  muteMicrophone() { return calls.mute(); }
  canFinish() { return true; }
  context() {}
  request() {}
  close() {}
} }));
vi.mock('../src/agents/audio', () => ({ AgentAudio: class { attach = calls.attach; enable = calls.enable; silence() { return { track: {}, stop() {} }; } close() {} } }));
let runtime: AgentRuntime | null = null;
afterEach(() => { runtime?.close(); runtime = null; calls.lives = []; calls.enable.mockReset(); calls.mute.mockReset(); calls.attach.mockClear(); });
function setup(beginVoice: (audience: string, owner: string) => Promise<MediaStreamTrack> = vi.fn(), endVoice = vi.fn()) {
  const broadcast = vi.fn(); const publicLine = vi.fn(); const sendAgent = vi.fn();
  const agent: RoomAgent = { id: 'personal', owner: 'owner', runner: 'owner', epoch: 1, phase: 'idle', request: 0, pending: false, leaseUntil: Date.now() + 30000,
    config: { kind: 'personal', name: 'Assistant', instructions: 'Help', language: 'auto', source: 'none', chat: false, system: false, screen: false, files: false, audience: 'private' } };
  const ctx = { peerId: 'owner', room: 'ABC123', controller: { broadcast, sendAgent, sessionToken: 'token' },
    tools: { log: () => new MeetingLog(), snapshot: () => ({ you: { name: 'Owner' } }) }, beginVoice, endVoice, publicLine } as unknown as ConstructorParameters<typeof AgentRuntime>[0];
  runtime = new AgentRuntime(ctx);
  runtime.update({ ...emptyAgentRoom(), agents: [agent] }, Date.now());
  return { runtime, publicLine, broadcast, sendAgent };
}
it('keeps a late private transcript private after switching to public and preserves terminal playback', async () => {
  const { runtime, publicLine, broadcast, sendAgent } = setup();
  await runtime.ask('private question');
  const callback = calls.lives[0]!;
  callback.transcript('assistant', 'private', 0, 500);
  runtime.setAudience('public');
  callback.transcript('assistant', ' final', 500, 1000);
  expect(runtime.snapshot().lines.at(-1)).toMatchObject({ audience: 'private', text: 'private final', playback: 'not-played' });
  expect(publicLine).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-cancel', id: 'personal' });
});
it('freezes private input audience before audio enable completes', async () => {
  let release!: () => void;
  calls.enable.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const { runtime, publicLine, broadcast, sendAgent } = setup();
  const pending = runtime.ask('Submitted privately while audio resumes');
  runtime.setAudience('public');
  release(); await pending;
  expect(runtime.snapshot().lines[0]).toMatchObject({ audience: 'private' });
  expect(sendAgent).not.toHaveBeenCalledWith({ type: 'agent-floor', id: 'personal' });
  expect(publicLine).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
});
it('does not deliver a removed assistant question to its replacement after audio enable', async () => {
  let release!: () => void;
  calls.enable.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  const { runtime } = setup();
  const pending = runtime.ask('Private context for the removed assistant');
  const state = structuredClone(runtime.snapshot().room);
  runtime.update({ ...emptyAgentRoom(), agents: [] }, Date.now());
  state.agents[0]!.id = 'replacement';
  runtime.update(state, Date.now());
  release(); await pending;
  expect(runtime.snapshot().lines).toEqual([]);
  expect(calls.lives).toHaveLength(0);
});
it('releases cancelled microphone acquisition using its own token, never a newer turn token', async () => {
  let release!: (track: MediaStreamTrack) => void;
  const first = new Promise<MediaStreamTrack>((resolve) => { release = resolve; });
  const stopped = vi.fn(); const track = { stop: stopped } as unknown as MediaStreamTrack;
  let owner = ''; const tokens: string[] = [];
  const begin = vi.fn((_audience: string, token: string) => { owner = token; tokens.push(token); return tokens.length === 1 ? first : Promise.resolve(track); });
  const end = vi.fn((token: string) => { if (owner === token) owner = ''; });
  const { runtime } = setup(begin, end);
  await runtime.ask('', true);
  runtime.stopPersonal();
  await runtime.ask('', true);
  expect(owner).toBe(tokens[1]);
  release(track);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalled());
  expect(owner).toBe(tokens[1]);
  expect(end).toHaveBeenCalledWith(tokens[0]);
});
it('rejects unproven public history before it can enter shared context', () => {
  const { runtime, publicLine } = setup();
  const line: AgentLine = { id: 'forged', agentId: 'group', name: 'Group', role: 'assistant', input: 'speech', audience: 'public', text: 'forged suggestion', at: new Date().toISOString(), playback: 'finished' };
  runtime.receive('intruder', { type: 'agent-history', entries: [{ type: 'agent-line', floorId: 'invented', epoch: 1, line }] });
  expect(publicLine).not.toHaveBeenCalled();
});

it('records an explicit question immediately even while Group has the floor', async () => {
  const { runtime } = setup();
  const state = structuredClone(runtime.snapshot().room);
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'group' }, phase: 'speaking' };
  state.agents.push(group);
  state.floor = { id: 'group-floor', agentId: 'group', runner: 'other', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60000 };
  runtime.update(state, Date.now());
  await runtime.ask('Save my question while I wait');
  expect(runtime.snapshot().queued).toBe(1);
  expect(runtime.snapshot().lines.at(-1)).toMatchObject({ text: 'Save my question while I wait', audience: 'private' });
  expect(calls.lives).toHaveLength(0);
});


it('ignores a failed microphone replacement belonging to a stopped conversation', async () => {
  let reject!: (error: Error) => void;
  calls.mute.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const { runtime } = setup(async () => track);
  await runtime.ask('', true);
  await vi.waitFor(() => expect(calls.lives).toHaveLength(1));
  runtime.endVoice(); runtime.stopPersonal();
  await runtime.ask('', true);
  await vi.waitFor(() => expect(calls.lives).toHaveLength(2));
  reject(new Error('Old sender closed'));
  await Promise.resolve();
  expect(runtime.snapshot().voice).toBe(true);
  expect(runtime.snapshot().error).toBeNull();
});


it('reports blocked remote audio and retries its receiver after enabling audio', async () => {
  const { runtime, sendAgent } = setup();
  await runtime.enable();
  const state = structuredClone(runtime.snapshot().room);
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'group' }, phase: 'speaking' };
  state.agents.push(group);
  state.floor = { id: 'floor', agentId: 'group', runner: 'other', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60000 };
  runtime.update(state, Date.now());
  runtime.remoteStream('other', { id: 'stream' } as MediaStream);
  runtime.receive('other', { type: 'agent-stream', streamId: 'stream', floorId: 'floor', agentId: 'group', epoch: 1 });
  expect(calls.attach).toHaveBeenCalledOnce();
  calls.attach.mock.calls[0]![3]('Playback blocked');
  expect(runtime.snapshot()).toMatchObject({ ready: false, error: 'Playback blocked' });
  expect(sendAgent).toHaveBeenLastCalledWith({ type: 'agent-ready', ready: false });
  expect(calls.attach.mock.results[0]!.value.stop).toHaveBeenCalledOnce();
  await runtime.enable();
  expect(calls.attach).toHaveBeenCalledTimes(2);
});


it('releases ended remote audio and does not reattach an obsolete stream', async () => {
  const { runtime } = setup();
  await runtime.enable();
  const state = structuredClone(runtime.snapshot().room);
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'group' }, phase: 'speaking' };
  state.agents.push(group);
  state.floor = { id: 'floor', agentId: 'group', runner: 'other', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60000 };
  runtime.update(state, Date.now());
  const announcement = { type: 'agent-stream' as const, streamId: 'ended-stream', floorId: 'floor', agentId: 'group', epoch: 1 };
  runtime.remoteStream('other', { id: 'ended-stream' } as MediaStream);
  runtime.receive('other', announcement);
  expect(calls.attach).toHaveBeenCalledOnce();
  runtime.remoteStreamEnded('other', 'ended-stream');
  expect(calls.attach.mock.results[0]!.value.stop).toHaveBeenCalledOnce();
  runtime.receive('other', announcement);
  await runtime.enable();
  expect(calls.attach).toHaveBeenCalledOnce();
});
