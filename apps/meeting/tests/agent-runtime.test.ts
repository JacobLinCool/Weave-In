import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agents/runtime';
import { emptyAgentRoom, type AgentLine, type RoomAgent } from '../src/agents/contracts';
import type { LiveCallbacks } from '../src/agents/live';
import { MeetingLog } from '../src/meeting-log';

const calls = vi.hoisted(() => ({ requests: vi.fn(), contexts: vi.fn(), close: vi.fn(), start: vi.fn(), tools: [] as unknown[][], lives: [] as LiveCallbacks[], enable: vi.fn(async (): Promise<void> => undefined), mute: vi.fn(async (): Promise<void> => undefined), attach: vi.fn((_stream: MediaStream, _allowed: () => boolean, _level: unknown, _error: (message: string) => void) => ({ stop: vi.fn(), output: { id: 'output' } as MediaStream })) }));
vi.mock('../src/agents/live', () => ({ AgentLive: class {
  constructor(callbacks: LiveCallbacks, tools: unknown[]) { calls.lives.push(callbacks); calls.tools.push(tools); }
  async start(args: unknown) { calls.start(args); }
  muteMicrophone() { return calls.mute(); }
  canFinish() { return true; }
  context(...args: unknown[]) { calls.contexts(...args); }
  request(...args: unknown[]) { calls.requests(...args); }
  close() { calls.close(); }
} }));
vi.mock('../src/agents/audio', () => ({ AgentAudio: class { attach = calls.attach; enable = calls.enable; silence() { return { track: {}, stop() {} }; } close() {} } }));
let runtime: AgentRuntime | null = null;
afterEach(() => { runtime?.close(); runtime = null; calls.lives = []; calls.enable.mockReset(); calls.mute.mockReset(); calls.attach.mockClear(); calls.requests.mockClear(); calls.contexts.mockClear(); calls.start.mockClear(); calls.close.mockClear(); calls.tools = []; vi.useRealTimers(); });
function setup(beginVoice: (audience: string, owner: string) => Promise<MediaStreamTrack> = vi.fn(), endVoice = vi.fn()) {
  const broadcast = vi.fn(); const publicLine = vi.fn(); const sendAgent = vi.fn();
  const agent: RoomAgent = { id: 'personal', owner: 'owner', runner: 'owner', epoch: 1, phase: 'idle', request: 0, pending: false, leaseUntil: Date.now() + 30000,
    config: { kind: 'personal', name: 'Assistant', instructions: 'Help', language: 'auto', source: 'none', chat: false, system: false, screen: false, files: false, audience: 'private' } };
  const ctx = { peerId: 'owner', room: 'ABC123', controller: { broadcast, sendAgent, addStream: vi.fn(), removeStream: vi.fn(), sessionToken: 'token' },
    tools: { log: () => new MeetingLog(), snapshot: () => ({ you: { name: 'Owner' } }) }, beginVoice, endVoice, publicLine } as unknown as ConstructorParameters<typeof AgentRuntime>[0];
  runtime = new AgentRuntime(ctx);
  runtime.update({ ...emptyAgentRoom(), agents: [agent] }, Date.now());
  return { runtime, publicLine, broadcast, sendAgent };
}
it.each(['personal', 'group'] as const)('waits for acknowledgement before completing %s assistant creation', async (kind) => {
  vi.useFakeTimers();
  const { runtime, sendAgent } = setup();
  const agent = structuredClone(runtime.snapshot().room.agents[0]!);
  agent.id = 'created'; agent.config.kind = kind;
  runtime.update(emptyAgentRoom(), Date.now());
  let completed = false;
  const creating = runtime.create(agent.config).then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-create', config: agent.config });
  expect(completed).toBe(false);
  runtime.update({ ...emptyAgentRoom(), agents: [agent] }, Date.now());
  await creating;
  expect(completed).toBe(true);
});
it('shows a ready status when Muse exists and setup guidance only after it is removed', () => {
  const { runtime } = setup();
  expect(runtime.snapshot().status).toBe('Ready for your question.');
  expect(runtime.snapshot().working).toBe(false);
  runtime.update(emptyAgentRoom(), Date.now());
  expect(runtime.snapshot().status).toBe('Create an assistant to start a conversation.');
});
it.each(['timeout', 'disconnect', 'close'] as const)('rejects unconfirmed creation on %s', async (failure) => {
  vi.useFakeTimers();
  const { runtime } = setup();
  const config = structuredClone(runtime.snapshot().room.agents[0]!.config);
  runtime.update(emptyAgentRoom(), Date.now());
  const pending = runtime.create(config);
  const rejected = expect(pending).rejects.toThrow(failure === 'timeout' ? 'did not confirm' : failure === 'disconnect' ? 'disconnected' : 'closed');
  await vi.advanceTimersByTimeAsync(0);
  if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
  else if (failure === 'disconnect') runtime.connectionLost();
  else runtime.close();
  await rejected;
  runtime.close();
  expect(vi.getTimerCount()).toBe(0);
});
it('ignores legacy persistent public mode and keeps personal transcripts private', async () => {
  const { runtime, publicLine, broadcast, sendAgent } = setup();
  await runtime.ask('private question');
  const callback = calls.lives[0]!;
  callback.transcript('assistant', 'private', 0, 500);
  runtime.setAudience('public');
  callback.transcript('assistant', ' final', 500, 1000);
  expect(runtime.snapshot().lines.at(-1)).toMatchObject({ audience: 'private', text: 'private final', playback: 'not-played' });
  expect(publicLine).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled();
  expect(sendAgent).not.toHaveBeenCalledWith({ type: 'agent-floor', id: 'personal' });
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

it('continues private Muse while Omni publishes a text suggestion', async () => {
  const { runtime } = setup();
  const state = structuredClone(runtime.snapshot().room);
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'group' }, phase: 'speaking' };
  state.agents.push(group);
  state.floor = { id: 'group-floor', agentId: 'group', runner: 'other', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60000 };
  runtime.update(state, Date.now());
  await runtime.ask('Save my question while I wait');
  expect(runtime.snapshot().queued).toBe(0);
  expect(runtime.snapshot().lines.at(-1)).toMatchObject({ text: 'Save my question while I wait', audience: 'private' });
  expect(calls.lives).toHaveLength(1);
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
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'personal' }, phase: 'speaking' };
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
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', owner: 'other', runner: 'other', config: { ...state.agents[0]!.config, kind: 'personal' }, phase: 'speaking' };
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

function grantPersonal(runtime: AgentRuntime) {
  const state = structuredClone(runtime.snapshot().room);
  state.floor = { id: 'personal-floor', agentId: 'personal', runner: 'owner', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  state.agents[0]!.phase = 'speaking';
  runtime.update(state, Date.now());
}

it('isolates approved public speech from private history and tools, and returns to private afterwards', async () => {
  const { runtime, publicLine, sendAgent } = setup();
  await runtime.ask('Secret private position');
  await runtime.speakForMe('Confirm the mute button remains usable');
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-floor', id: 'personal' });
  grantPersonal(runtime);
  await Promise.resolve();
  expect(calls.requests).toHaveBeenLastCalledWith('{}', expect.stringContaining('Confirm the mute button remains usable'));
  expect(calls.tools.at(-1)).toEqual([]);
  expect(JSON.stringify(calls.start.mock.calls.at(-1))).not.toContain('Secret private position');
  calls.lives.at(-1)!.transcript('assistant', 'Can we verify mute still works?', 0, 500);
  expect(publicLine).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Owner’s Muse', audience: 'public' }), 'owner');
  runtime.stopPersonal();
  const state = structuredClone(runtime.snapshot().room); state.floor = null; runtime.update(state, Date.now());
  await runtime.ask('Continue privately');
  expect(runtime.snapshot().lines.at(-1)).toMatchObject({ audience: 'private', text: 'Continue privately' });
});

it('owner speech revokes a queued public grant without restarting it', async () => {
  const { runtime, sendAgent } = setup();
  await runtime.speakForMe('Approved concern');
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(true);
  runtime.ownerStartedSpeaking();
  grantPersonal(runtime);
  expect(calls.lives).toHaveLength(0);
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(false);
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-cancel', id: 'personal' });
});

it('owner speech immediately cuts the active public audio and does not resume', async () => {
  const { runtime, sendAgent } = setup();
  await runtime.speakForMe('Approved concern'); grantPersonal(runtime); await Promise.resolve();
  calls.lives.at(-1)!.stream({} as MediaStream);
  runtime.ownerStartedSpeaking();
  expect(calls.attach.mock.results.at(-1)!.value.stop).toHaveBeenCalledOnce();
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-finish', floorId: 'personal-floor' });
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(false);
  runtime.update(runtime.snapshot().room, Date.now());
  expect(calls.lives).toHaveLength(1);
});

it('caps public personal speech at 20 seconds from the first audible sample', async () => {
  vi.useFakeTimers();
  const { runtime, sendAgent } = setup();
  await runtime.speakForMe('Approved concern'); grantPersonal(runtime); await Promise.resolve();
  calls.lives.at(-1)!.stream({} as MediaStream);
  const level = calls.attach.mock.calls.at(-1)![2] as (level: number, playing: boolean) => void;
  level(0.2, true);
  await vi.advanceTimersByTimeAsync(19_999);
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(false);
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-finish', floorId: 'personal-floor' });
});

it('creates Muse on an explicit reminder action and waits for room acknowledgement', async () => {
  const { runtime, sendAgent } = setup();
  const saved = runtime.snapshot().room;
  runtime.update(emptyAgentRoom(), Date.now());
  const request = runtime.discussReminder('Unresolved concern');
  await vi.waitFor(() => expect(sendAgent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-create', config: expect.objectContaining({ name: 'Muse', audience: 'private' }) })));
  runtime.update(saved, Date.now()); await request;
  expect(calls.requests).toHaveBeenLastCalledWith(expect.any(String), expect.stringContaining('Unresolved concern'));
});

it('publishes Omni text once without audible output or a voice approval', async () => {
  const { runtime, sendAgent, publicLine } = setup(); await runtime.enable();
  const state = structuredClone(runtime.snapshot().room);
  const group: RoomAgent = { ...state.agents[0]!, id: 'group', config: { ...state.agents[0]!.config, kind: 'group', name: 'Omni' }, phase: 'preparing', request: 1 };
  state.agents.push(group); runtime.update(state, Date.now()); await Promise.resolve();
  calls.lives.at(-1)!.stream({} as MediaStream);
  expect(calls.attach).not.toHaveBeenCalled();
  calls.lives.at(-1)!.prepared('A public text suggestion.');
  group.phase = 'raised'; runtime.update(structuredClone(state), Date.now());
  expect(sendAgent).toHaveBeenCalledWith({ type: 'agent-approve', id: 'group', epoch: 1, request: 1 });
  group.phase = 'speaking'; state.floor = { id: 'text-floor', agentId: 'group', runner: 'owner', epoch: 1, startedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  runtime.update(structuredClone(state), Date.now()); runtime.update(structuredClone(state), Date.now());
  expect(publicLine).toHaveBeenCalledTimes(1);
  expect(publicLine).toHaveBeenCalledWith(expect.objectContaining({ name: 'Omni', text: 'A public text suggestion.', input: 'text', playback: 'not-played' }), 'owner');
  expect(calls.lives).toHaveLength(1);
});


it('reconnects Muse without resuming public speech or losing private conversation', async () => {
  const { runtime, sendAgent } = setup();
  await runtime.ask('Retain my private context');
  const saved = runtime.snapshot().room;
  await runtime.speakForMe('Approved concern'); grantPersonal(runtime); await Promise.resolve();
  runtime.connectionLost();
  runtime.connectionRestored();
  expect(runtime.snapshot().personal).not.toBeNull(); // stale pre-disconnect snapshot
  runtime.update(emptyAgentRoom(), Date.now());
  expect(sendAgent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-create' }));
  const newState = structuredClone(saved); newState.agents[0]!.id = 'recovered';
  runtime.update(newState, Date.now());
  expect(runtime.snapshot().lines).toContainEqual(expect.objectContaining({ text: 'Retain my private context' }));
  expect(runtime.snapshot().publicPersonalSpeaking).toBe(false);
});

it('does not accept late public words after owner interruption', async () => {
  const { runtime, publicLine } = setup();
  await runtime.speakForMe('Approved concern'); grantPersonal(runtime); await Promise.resolve();
  const live = calls.lives.at(-1)!;
  runtime.ownerStartedSpeaking(); publicLine.mockClear();
  live.transcript('assistant', 'These words were never spoken', 100, 300);
  expect(publicLine).not.toHaveBeenCalled();
});

it('creates Muse on room entry without audio playback or Live connection', async () => {
  const { runtime, sendAgent } = setup(); const saved = runtime.snapshot().room;
  runtime.update(emptyAgentRoom(), Date.now()); const pending = runtime.initializePersonal();
  expect(sendAgent).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-create' }));
  runtime.update(saved, Date.now()); await pending;
  expect(calls.enable).not.toHaveBeenCalled(); expect(calls.lives).toHaveLength(0);
});


it('restores private Muse history before a fresh personal agent exists without replay or audio', async () => {
  const { runtime, publicLine, broadcast } = setup();
  const savedState = runtime.snapshot().room;
  runtime.update(emptyAgentRoom(), Date.now());
  const saved: AgentLine = { id: 'saved', agentId: 'previous-agent', name: 'Muse', role: 'assistant', input: 'speech', audience: 'private', text: 'Your earlier private concern', at: new Date().toISOString(), playback: 'playing' };
  runtime.restoreConversation([saved, { ...saved, id: 'public', audience: 'public' }]);
  const fresh = structuredClone(savedState); fresh.agents[0]!.id = 'new-chat';
  runtime.update(fresh, Date.now());
  expect(runtime.snapshot().lines).toEqual([{ ...saved, playback: 'interrupted' }]);
  expect(publicLine).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(calls.lives).toHaveLength(0);
  await runtime.ask('What was my concern?');
  expect(calls.requests.mock.calls.at(-1)![0]).toContain('Your earlier private concern');
});
