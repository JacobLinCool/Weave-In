import { expect, it } from 'vitest';
import { GROUP_ACTIONS, GROUP_REVIEW_POLICY, evidenceKey, parseGroupEvidence, parseGroupDecision, isDiscussion, type DiscussionRecord } from '../src/agents/group';
import { emptyAgentRoom, type AgentConfig } from '../src/agents/contracts';
import { applyAgentCommand } from '../src/agents/room';
import type { MeetingSnapshot } from '../src/webmcp';

const people = ['Alice', 'Bob', 'Carol'].map(name => ({ peerId: name, name, you: name === 'Alice', isHost: name === 'Alice', micOn: false, cameraOn: false, sharingScreen: false }));
const snapshot: MeetingSnapshot = { roomCode: 'ABC123', you: people[0]!, participants: people, captions: 'idle', presentation: null, live: [], files: [] };
const records: DiscussionRecord[] = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, kind: 'chat', at: new Date(i * 1000).toISOString(), sender: people[0]!, text: `Public discussion ${i}`, agent: null }));
const decision = { kind: 'convergence', severity: 0.8, evidenceSeqs: [1, 6], targetPeerId: null, text: 'Can we examine the unresolved launch risk first?' };
it.each(Object.entries(GROUP_ACTIONS))('accepts grounded %s decisions with the %s intervention', (kind, action) => {
  const value = { ...decision, kind, ...(kind === 'float' ? { targetPeerId: 'Carol', text: 'Carol, what evidence would help us choose a launch date?' } : {}) };
  expect(parseGroupDecision(JSON.stringify(value), records, snapshot)).toEqual(value);
  expect(GROUP_REVIEW_POLICY).toContain(`${kind} / ${action}`);
});
it.each([
  { kind: 'none', severity: 0, evidenceSeqs: [], text: '' },
  { kind: 'manual' }, { severity: 0.49 }, { severity: 2 }, { evidenceSeqs: [1, 999] }, { evidenceSeqs: [1, 1] },
  { evidenceSeqs: [1, 2] }, { text: 'x'.repeat(241) }, { targetPeerId: 'Carol' },
  { kind: 'float', targetPeerId: 'nobody' }, { kind: 'float', targetPeerId: 'Alice', text: 'Alice, any thoughts?' },
])('abstains on unsupported, low-confidence or ungrounded output: %j', value => {
  expect(parseGroupDecision(JSON.stringify({ ...decision, ...value }), records, snapshot)).toBeNull();
});
it('rejects malformed JSON and does not treat agent messages as evidence', () => {
  expect(parseGroupDecision('A generic suggestion', records, snapshot)).toBeNull();
  expect(isDiscussion({ ...records[0]!, kind: 'chat', sender: people[0]!, agent: 'Omni' })).toBe(false);
});
it('does not invite participants in two-person rooms', () => {
  expect(parseGroupDecision(JSON.stringify({ ...decision, kind: 'float', targetPeerId: 'Bob', text: 'Bob, any thoughts?' }), records, { ...snapshot, participants: people.slice(0, 2) })).toBeNull();
});
it('room authority fences the runner and persists throttling, cooldown, duplicate suppression and the room cap', () => {
  const state = emptyAgentRoom(); const member = { peerId: 'Alice', isHost: true, ready: true, joinedAt: 0, heartbeat: 0 };
  const config: AgentConfig = { kind: 'group', name: 'Omni', instructions: '', language: 'auto', source: 'all', chat: true, system: true, screen: false, files: false, audience: 'public' };
  applyAgentCommand(state, member, { type: 'agent-create', config }, 0, () => 'group');
  const agent = state.agents[0]!;
  agent.leaseUntil = 10_000_000;
  const review = (now: number) => applyAgentCommand(state, member, { type: 'agent-review', id: agent.id, epoch: agent.epoch, request: agent.request }, now, () => 'floor');
  applyAgentCommand(state, { ...member, peerId: 'Bob' }, { type: 'agent-review', id: agent.id, epoch: 1, request: 0 }, 0, () => 'floor');
  expect(agent.phase).toBe('idle');
  review(0); expect(agent.phase).toBe('preparing');
  applyAgentCommand(state, member, { type: 'agent-cancel', id: agent.id }, 1, () => 'floor');
  review(1000); expect(agent.phase).toBe('idle');
  for (let i = 0; i < 5; i++) {
    const now = 30_000 + i * 120_000;
    review(now); expect(agent.phase).toBe('preparing');
    const signal = { kind: 'echo' as const, evidence: [`Alice/${i}`, `Bob/${i}`] };
    applyAgentCommand(state, member, { type: 'agent-raised', id: agent.id, epoch: 1, request: agent.request, signal }, now, () => 'floor');
    const command = { type: 'agent-publish' as const, id: agent.id, epoch: 1, request: agent.request };
    applyAgentCommand(state, { ...member, peerId: 'Bob' }, command, now, () => 'floor');
    expect(state.floor).toBeNull();
    applyAgentCommand(state, member, command, now, () => 'floor');
    applyAgentCommand(state, member, command, now, () => 'floor');
    expect(state.automation.published).toBe(i);
    applyAgentCommand(state, member, { type: 'agent-published', floorId: 'floor' }, now, () => 'floor');
    expect(state.automation.published).toBe(i + 1);
    review(now + 30_000); expect(agent.phase).toBe('idle');
  }
  review(1_000_000); expect(agent.phase).toBe('idle');
  applyAgentCommand(state, member, { type: 'agent-configure', id: agent.id, config }, 1_000_000, () => 'floor');
  review(1_000_000); expect(agent.phase).toBe('idle');
  expect(state.automation.events).toHaveLength(5);
});

it('canceling a granted but unpublished question does not consume the room allowance', () => {
  const state = emptyAgentRoom();
  const member = { peerId: 'Alice', isHost: true, ready: true, joinedAt: 0, heartbeat: 1000 };
  state.agents.push({ id: 'group', owner: 'Alice', runner: 'Alice', epoch: 1, phase: 'raised', request: 1, pending: false, leaseUntil: 100000,
    config: { kind: 'group', name: 'Omni', instructions: '', language: 'auto', source: 'all', chat: true, system: true, screen: false, files: false, audience: 'public' } });
  state.signal = { id: 1, by: 'Alice', at: 0, kind: 'echo', evidence: ['Alice/1', 'Bob/2'] };
  applyAgentCommand(state, member, { type: 'agent-publish', id: 'group', epoch: 1, request: 1 }, 1000, () => 'floor');
  expect(state.floor?.id).toBe('floor');
  applyAgentCommand(state, member, { type: 'agent-cancel', id: 'group' }, 1001, () => 'floor');
  expect(state.automation).toMatchObject({ published: 0, nextPublishAt: 0, events: [] });
  applyAgentCommand(state, member, { type: 'agent-published', floorId: 'floor' }, 1002, () => 'floor');
  expect(state.automation.published).toBe(0);
});

it('uses stable, distinct evidence identifiers for different messages in the same millisecond', async () => {
  const first = records[0]!;
  const second = { ...first, seq: 100, text: 'A distinct contribution at the same timestamp' };
  const keys = await Promise.all([first, second].map(evidenceKey));
  expect(keys[0]).not.toBe(keys[1]);
  expect(await evidenceKey({ ...first, seq: 999 })).toBe(keys[0]);
  expect(parseGroupEvidence({ kind: 'echo', evidence: keys })).not.toBeNull();
});
