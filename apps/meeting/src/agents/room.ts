import { LEASE_MS, type AgentCommand, type AgentRoomState, type RoomAgent } from './contracts';

export interface AgentMember { peerId: string; isHost: boolean; ready: boolean; joinedAt: number; heartbeat: number }

/** One room authority; only control metadata goes through the server. */
export function reconcileAgents(state: AgentRoomState, members: AgentMember[], now: number, uuid: () => string): void {
  const present = new Set(members.map((member) => member.peerId));
  state.agents = state.agents.filter((agent) => agent.config.kind === 'group' || present.has(agent.owner));
  const available = members.filter((member) => member.ready && member.heartbeat + LEASE_MS > now).sort((a, b) => a.joinedAt - b.joinedAt || a.peerId.localeCompare(b.peerId));
  for (const agent of state.agents) {
    if (agent.config.kind === 'personal') continue;
    const runner = available.find((member) => member.peerId === agent.runner);
    if (runner) { agent.leaseUntil = runner.heartbeat + LEASE_MS; continue; }
    const next = available[0];
    if (agent.runner !== (next?.peerId ?? null)) {
      agent.epoch++;
      agent.runner = next?.peerId ?? null;
      if (agent.phase !== 'idle' && agent.phase !== 'waiting') agent.pending = true;
      agent.phase = next ? (agent.pending ? 'preparing' : 'idle') : 'waiting';
      if (next && agent.pending) { agent.pending = false; agent.request++; }
    }
    agent.leaseUntil = next ? next.heartbeat + LEASE_MS : 0;
  }
  const floor = state.floor;
  if (floor) {
    const agent = state.agents.find((entry) => entry.id === floor.agentId);
    if (!agent || agent.runner !== floor.runner || agent.epoch !== floor.epoch || floor.expiresAt <= now || !available.some((member) => member.peerId === floor.runner)) {
      state.floor = null;
      if (agent?.phase === 'speaking') settle(agent);
    }
  }
  state.queue = state.queue.filter((id) => state.agents.some((agent) => agent.id === id && available.some((member) => member.peerId === agent.runner)));
  if (!state.floor) {
    const nextId = state.queue.shift();
    const next = state.agents.find((agent) => agent.id === nextId);
    if (next?.runner) grant(state, next, now, uuid);
  }
}

export function applyAgentCommand(state: AgentRoomState, member: AgentMember, command: AgentCommand, now: number, uuid: () => string): void {
  if (command.type === 'agent-ready' || command.type === 'agent-heartbeat') return;
  if (command.type === 'agent-create') {
    const config = command.config;
    if (state.agents.some((agent) => agent.config.kind === config.kind && (config.kind === 'group' || agent.owner === member.peerId))) throw new Error('This agent already exists.');
    if (!member.ready) throw new Error('Enable agent audio on this device before creating an agent.');
    state.agents.push({ id: uuid(), owner: member.peerId, runner: member.peerId, epoch: 1, config, phase: 'idle', request: 0, pending: false, leaseUntil: now + LEASE_MS });
    return;
  }
  if (command.type === 'agent-finish') {
    if (state.floor?.id === command.floorId && state.floor.runner === member.peerId) {
      const agent = state.agents.find((entry) => entry.id === state.floor?.agentId);
      state.floor = null;
      if (agent) settle(agent);
    }
    return;
  }
  const agent = state.agents.find((entry) => entry.id === command.id);
  if (!agent) throw new Error('Agent no longer exists.');
  const group = agent.config.kind === 'group';
  if (!group && agent.owner !== member.peerId) throw new Error('Only the owner can control this personal agent.');
  switch (command.type) {
    case 'agent-remove':
      if (agent.owner !== member.peerId && !member.isHost) throw new Error('Only the creator or host can remove this agent.');
      state.agents = state.agents.filter((entry) => entry !== agent);
      state.queue = state.queue.filter((id) => id !== agent.id);
      if (state.floor?.agentId === agent.id) state.floor = null;
      return;
    case 'agent-signal':
      if (!group) throw new Error('Signals target the group agent.');
      state.signal = { id: (state.signal?.id ?? 0) + 1, by: member.peerId, at: now, kind: 'manual' };
      if (agent.phase === 'idle') { agent.phase = agent.runner ? 'preparing' : 'waiting'; agent.request++; }
      else if (agent.phase === 'speaking' || agent.phase === 'waiting') agent.pending = true;
      return;
    case 'agent-failed':
      if (agent.runner !== member.peerId || agent.epoch !== command.epoch || agent.request !== command.request) return;
      member.ready = false;
      return;
    case 'agent-raised':
      if (group && agent.runner === member.peerId && agent.epoch === command.epoch && agent.request === command.request && agent.phase === 'preparing') agent.phase = 'raised';
      return;
    case 'agent-approve':
      if (!group || agent.phase !== 'raised' || agent.epoch !== command.epoch || agent.request !== command.request || !agent.runner || agent.leaseUntil <= now) return;
      if (state.floor) {
        const previous = state.agents.find((entry) => entry.id === state.floor?.agentId);
        if (previous) previous.phase = 'idle';
      }
      grant(state, agent, now, uuid);
      return;
    case 'agent-floor':
      if (group) throw new Error('Group speech requires a raised hand and approval.');
      if (!member.ready) throw new Error('This device is not ready for audio.');
      if (state.floor?.agentId === agent.id || state.queue.includes(agent.id)) return;
      if (!state.floor) grant(state, agent, now, uuid);
      else state.queue.push(agent.id);
      return;
    case 'agent-cancel':
      state.queue = state.queue.filter((id) => id !== agent.id);
      if (state.floor?.agentId === agent.id) state.floor = null;
      agent.phase = agent.runner ? 'idle' : 'waiting';
      agent.pending = false;
      agent.request++; // Cancels late preparation results, too.
      return;
  }
}
function settle(agent: RoomAgent): void {
  agent.phase = agent.pending ? 'preparing' : 'idle';
  if (agent.pending) { agent.pending = false; agent.request++; }
}
function grant(state: AgentRoomState, agent: RoomAgent, now: number, uuid: () => string): void {
  if (!agent.runner) return;
  state.floor = { id: uuid(), agentId: agent.id, runner: agent.runner, epoch: agent.epoch, startedAt: now, expiresAt: now + 60_000 };
  // ponytail: retain 128 grant proofs for replay; older history is unavailable to late joiners.
  state.grants = [...state.grants.slice(-127), { ...state.floor }];
  agent.phase = 'speaking';
}
