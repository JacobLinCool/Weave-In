export const LIVE_MODEL = 'gpt-live-1';
export const REASONING_MODEL = 'gpt-5.6-terra';
export const HEARTBEAT_MS = 10_000;
export const LEASE_MS = 30_000;
export const PUBLIC_TURN_MS = 10 * 60_000;
export const MAX_AGENT_TEXT = 4_000;
export const TOOL_NAMES = ['read_meeting', 'capture_screen_share', 'read_shared_file', 'send_chat_message', 'capture_whiteboard', 'edit_whiteboard'] as const;
export type AgentKind = 'personal' | 'group';
export type Audience = 'private' | 'public';
export interface AgentConfig {
  kind: AgentKind;
  name: string;
  instructions: string;
  language: string;
  source: 'none' | 'owner' | 'all';
  chat: boolean;
  system: boolean;
  screen: boolean;
  files: boolean;
  /** Explicit permission to publish Room messages; missing legacy values deny access. */
  roomMessages?: boolean;
  audience: Audience;
}
export interface RoomAgent {
  id: string;
  owner: string;
  runner: string | null;
  epoch: number;
  config: AgentConfig;
  phase: 'idle' | 'preparing' | 'raised' | 'speaking' | 'waiting';
  request: number;
  pending: boolean;
  leaseUntil: number;
}
export interface Floor {
  id: string;
  agentId: string;
  runner: string;
  epoch: number;
  startedAt: number;
  expiresAt: number;
}
export interface AgentRoomState {
  agents: RoomAgent[];
  /** Persisted so removing Omni is respected for the rest of this room. */
  groupInitialized?: boolean;
  floor: Floor | null;
  grants: Floor[];
  queue: string[];
  signal: { id: number; at: number; by: string; kind: 'manual' } | null;
}
export const emptyAgentRoom = (): AgentRoomState => ({ agents: [], floor: null, grants: [], queue: [], signal: null });
export type AgentCommand =
  | { type: 'agent-ready'; ready: boolean }
  | { type: 'agent-heartbeat' }
  | { type: 'agent-create'; config: AgentConfig }
  | { type: 'agent-configure'; id: string; config: AgentConfig }
  | { type: 'agent-remove' | 'agent-signal' | 'agent-floor' | 'agent-cancel'; id: string }
  | { type: 'agent-raised' | 'agent-approve' | 'agent-failed'; id: string; epoch: number; request: number }
  | { type: 'agent-finish'; floorId: string };
export interface AgentLine {
  id: string;
  agentId: string;
  name: string;
  role: 'user' | 'assistant';
  input: 'text' | 'speech';
  audience: Audience;
  text: string;
  at: string;
  playback: 'not-played' | 'playing' | 'interrupted' | 'finished';
}
export type AgentPeerMessage =
  | { type: 'agent-line'; floorId: string; epoch: number; line: AgentLine }
  | { type: 'agent-history'; entries: Array<Extract<AgentPeerMessage, { type: 'agent-line' }>> }
  | { type: 'agent-stream'; floorId: string; agentId: string; epoch: number; streamId: string };

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,64}$/u.test(value);
}
export function parseAgentConfig(value: unknown): AgentConfig | null {
  if (!record(value) || (value.kind !== 'personal' && value.kind !== 'group')) return null;
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 40 || /\p{Cc}/u.test(value.name)) return null;
  if (typeof value.instructions !== 'string' || !value.instructions.trim() || value.instructions.length > 8_000) return null;
  if (typeof value.language !== 'string' || !value.language.trim() || value.language.length > 80) return null;
  if (!['none', 'owner', 'all'].includes(String(value.source)) || !['private', 'public'].includes(String(value.audience))) return null;
  if (['chat', 'system', 'screen', 'files'].some((key) => typeof value[key] !== 'boolean')) return null;
  if (value.roomMessages !== undefined && typeof value.roomMessages !== 'boolean') return null;
  const group = value.kind === 'group';
  return { kind: value.kind, name: value.name.trim(), instructions: value.instructions, language: value.language.trim(),
    source: group ? 'all' : value.source as AgentConfig['source'], chat: group || (value.source !== 'none' && value.chat as boolean),
    system: group || value.system as boolean, screen: value.screen as boolean, files: value.files as boolean, roomMessages: value.roomMessages === true,
    audience: group ? 'public' : value.audience as Audience };
}
export function parseAgentCommand(value: unknown): AgentCommand | null {
  if (!record(value)) return null;
  switch (value.type) {
    case 'agent-ready': return typeof value.ready === 'boolean' ? { type: value.type, ready: value.ready } : null;
    case 'agent-heartbeat': return { type: value.type };
    case 'agent-create': { const config = parseAgentConfig(value.config); return config ? { type: value.type, config } : null; }
    case 'agent-configure': { const config = parseAgentConfig(value.config); return config && identifier(value.id) ? { type: value.type, id: value.id, config } : null; }
    case 'agent-remove': case 'agent-signal': case 'agent-floor': case 'agent-cancel':
      return identifier(value.id) ? { type: value.type, id: value.id } : null;
    case 'agent-raised': case 'agent-approve': case 'agent-failed':
      return identifier(value.id) && Number.isSafeInteger(value.epoch) && Number(value.epoch) > 0 && Number.isSafeInteger(value.request) && Number(value.request) >= 0
        ? { type: value.type, id: value.id, epoch: Number(value.epoch), request: Number(value.request) } : null;
    case 'agent-finish': return identifier(value.floorId) ? { type: value.type, floorId: value.floorId } : null;
    default: return null;
  }
}
export function parseAgentPeerMessage(value: unknown): AgentPeerMessage | null {
  if (!record(value)) return null;
  if (value.type === 'agent-history') {
    if (!Array.isArray(value.entries) || value.entries.length > 10) return null;
    const entries: Array<Extract<AgentPeerMessage, { type: 'agent-line' }>> = [];
    for (const entry of value.entries) {
      if (!record(entry) || entry.type !== 'agent-line') return null;
      const parsed = parseAgentPeerMessage(entry);
      if (!parsed || parsed.type !== 'agent-line') return null;
      entries.push(parsed);
    }
    return { type: 'agent-history', entries };
  }
  if (!identifier(value.floorId) || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1) return null;
  if (value.type === 'agent-stream' && identifier(value.agentId) && typeof value.streamId === 'string' && /^[\w{}-]{1,128}$/u.test(value.streamId)) {
    return { type: value.type, floorId: value.floorId, agentId: value.agentId, epoch: Number(value.epoch), streamId: value.streamId };
  }
  const line = value.line;
  if (value.type !== 'agent-line' || !record(line) || !identifier(line.id) || !identifier(line.agentId) || line.audience !== 'public') return null;
  if (typeof line.name !== 'string' || line.name.length > 40 || typeof line.text !== 'string' || line.text.length > MAX_AGENT_TEXT) return null;
  if (typeof line.at !== 'string' || line.at.length > 40 || !Number.isFinite(Date.parse(line.at))) return null;
  if (!['user', 'assistant'].includes(String(line.role)) || !['text', 'speech'].includes(String(line.input)) || !['not-played', 'playing', 'interrupted', 'finished'].includes(String(line.playback))) return null;
  return { type: 'agent-line', floorId: value.floorId, epoch: Number(value.epoch), line: {
    id: line.id, agentId: line.agentId, name: line.name, text: line.text, at: line.at, audience: 'public',
    role: line.role as AgentLine['role'], input: line.input as AgentLine['input'], playback: line.playback as AgentLine['playback'],
  } };
}
export function isApproval(text: string): boolean {
  return /^(?:團隊助理[，,。.\s]*請發言|weave[，,。.\s]+go ahead)[。.!！]?$/iu.test(text.trim());
}
export function permitsFloor(state: AgentRoomState, peer: string, floorId: string, epoch: number, now = Date.now()): boolean {
  const floor = state.floor;
  const agent = state.agents.find((entry) => entry.id === floor?.agentId);
  return !!floor && !!agent && agent.runner === peer && agent.epoch === epoch && (agent.config.kind !== 'group' || agent.leaseUntil > now) && floor.runner === peer && floor.id === floorId && floor.epoch === epoch && floor.expiresAt > now;
}

/** Replay proves who held the original public floor; it never authorizes new audio. */
export function permitsHistory(state: AgentRoomState, peer: string, message: Extract<AgentPeerMessage, { type: 'agent-line' }>): boolean {
  const grant = state.grants.find((floor) => floor.id === message.floorId);
  const at = Date.parse(message.line.at);
  return !!grant && grant.runner === peer && grant.epoch === message.epoch && grant.agentId === message.line.agentId && at >= grant.startedAt && at <= grant.expiresAt + 15_000;
}
