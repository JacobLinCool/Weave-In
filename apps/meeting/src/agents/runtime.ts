import { AgentAudio } from './audio';
import { AgentLive } from './live';
import { contextText, scopedTools } from './tools';
import { emptyAgentRoom, HEARTBEAT_MS, isApproval, permitsFloor, permitsHistory, type AgentCommand, type AgentConfig, type AgentLine, type AgentPeerMessage, type AgentRoomState, type Audience, type RoomAgent } from './contracts';
import type { MeetingController } from '../meeting-controller';
import type { MeetingToolsContext } from '../webmcp';

interface RuntimeContext {
  peerId: string;
  room: string;
  controller: MeetingController;
  tools: MeetingToolsContext;
  beginVoice(audience: Audience, owner: string): Promise<MediaStreamTrack>;
  endVoice(owner: string): void;
  publicLine(line: AgentLine, peerId: string, replayed?: true): void;
}
interface Operation {
  key: string;
  agent: RoomAgent;
  audience: Audience;
  floorId: string;
  preparing: boolean;
  live: AgentLive | null;
  microphone: MediaStreamTrack | null;
  stopAudio: (() => void) | null;
  streamId: string | null;
  startedAt: number;
  lastSound: number;
  heard: boolean;
  playback: AgentLine['playback'] | null;
  voice: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  rows: Map<string, { line: AgentLine; start: number; end: number }>;
}
export interface AgentView {
  room: AgentRoomState;
  personal: RoomAgent | null;
  group: RoomAgent | null;
  audience: Audience;
  lines: AgentLine[];
  status: string;
  error: string | null;
  voice: boolean;
  ready: boolean;
  queued: number;
}

export class AgentRuntime {
  #state = emptyAgentRoom();
  #lines: AgentLine[] = [];
  #audience: Audience = 'private';
  #personalId = '';
  #audio: AgentAudio | null = null;
  #operations = new Map<'personal' | 'group', Operation>();
  #draft = '';
  #seenGroup = '';
  #queue: Array<{ text: string; voice: boolean; audience: Audience; line: AgentLine | undefined }> = [];
  #listeners = new Set<() => void>();
  #closed = false;
  #serverOffset = 0;
  #lastState = 0;
  #signal = 0;
  #releasedFloor = '';
  #contextHead = 0;
  #error: string | null = null;
  #status = 'Create an assistant to start a conversation.';
  #ready = false;
  #remoteStreams = new Map<string, { peer: string; stream: MediaStream }>();
  #announcements = new Map<string, { peer: string; message: Extract<AgentPeerMessage, { type: 'agent-stream' }>; stop: (() => void) | null }>();
  #publicRows = new Map<string, AgentLine>();
  #pendingPeer: Array<{ peer: string; message: AgentPeerMessage; until: number }> = [];
  #ownPublicRows = new Map<string, Extract<AgentPeerMessage, { type: 'agent-line' }>>();
  #pastFloors = new Map<string, { floor: NonNullable<AgentRoomState['floor']>; until: number }>();
  #heartbeat: ReturnType<typeof setInterval>;
  #view: AgentView;
  constructor(readonly ctx: RuntimeContext) {
    this.#view = this.#snapshot();
    this.#heartbeat = setInterval(() => {
      this.command({ type: 'agent-heartbeat' });
      if (this.ctx.tools.log().head !== this.#contextHead) {
        this.#contextHead = this.ctx.tools.log().head;
        for (const op of this.#operations.values()) if (this.#valid(op)) op.live?.context(contextText(this.ctx.tools.log(), op.agent.config, op.agent.owner, []));
      }
      if (this.#lastState && Date.now() - this.#lastState > 30_000) {
        this.#stop('group', 'interrupted'); this.#stop('personal', 'interrupted');
        this.#error = 'Room coordination lost. Agent audio is stopped.'; this.#emit();
      }
    }, HEARTBEAT_MS);
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): AgentView => this.#view;
  #snapshot(): AgentView {
    return { room: this.#state, personal: this.#personal(), group: this.#state.agents.find((agent) => agent.config.kind === 'group') ?? null,
      audience: this.#audience, lines: [...this.#lines], status: this.#status, error: this.#error, voice: !!this.#operations.get('personal')?.microphone, ready: this.#ready, queued: this.#queue.length };
  }
  #emit(): void { if (this.#closed) return; this.#view = this.#snapshot(); for (const listener of this.#listeners) listener(); }
  #personal(): RoomAgent | null { return this.#state.agents.find((agent) => agent.config.kind === 'personal' && agent.owner === this.ctx.peerId) ?? null; }
  command(command: AgentCommand): void { if (!this.#closed) this.ctx.controller.sendAgent(command); }
  async enable(): Promise<void> {
    try {
      this.#audio ??= new AgentAudio(); await this.#audio.enable();
      this.#ready = true; this.#error = null; this.command({ type: 'agent-ready', ready: true });
      this.#attachRemote(); this.#emit();
    } catch (error) { this.#error = error instanceof Error ? error.message : 'Unable to enable audio.'; this.#emit(); throw error; }
  }
  async create(config: AgentConfig): Promise<void> { await this.enable(); this.command({ type: 'agent-create', config }); }
  remove(id: string): void {
    for (const [kind, op] of this.#operations) if (op.agent.id === id) this.#stop(kind, 'interrupted');
    if (id === this.#personalId) { this.#queue = []; this.#lines = []; }
    this.command({ type: 'agent-remove', id });
  }
  setAudience(audience: Audience): void {
    if (audience === this.#audience) return;
    this.#stop('personal', 'interrupted');
    if (this.#personal()) this.command({ type: 'agent-cancel', id: this.#personal()!.id });
    this.#queue = []; this.#audience = audience;
    this.#status = audience === 'public' ? 'Public mode: future replies may refer to earlier private discussion.' : 'Only you can hear and read this conversation.';
    this.#emit();
  }
  async ask(text: string, voice = false): Promise<void> {
    const personal = this.#personal();
    if (!personal) return;
    text = text.trim();
    if ((!text && !voice) || text.length > 4_000) return;
    const audience = this.#audience;
    await this.enable();
    if (this.#closed || this.#personal()?.id !== personal.id) return;
    const line: AgentLine | undefined = text ? { id: crypto.randomUUID(), agentId: personal.id, name: this.ctx.tools.snapshot().you.name, role: 'user', input: 'text', audience, text, at: new Date(this.#now()).toISOString(), playback: 'not-played' } : undefined;
    if (line) this.#lines.push(line);
    this.#queue.push({ text, voice, audience, line });
    this.#drain(); this.#emit();
  }
  endVoice(): void {
    const op = this.#operations.get('personal');
    if (op?.microphone) {
      void op.live?.muteMicrophone().catch(() => { if (!this.#valid(op)) return; this.#error = 'Unable to finish microphone input.'; this.#stop('personal', 'interrupted'); });
      op.microphone.stop(); op.microphone = null; this.ctx.endVoice(op.key);
      this.#status = 'Listening ended. Waiting for your assistant.'; this.#emit();
    }
  }
  stopPersonal(): void { this.#queue = []; this.#stop('personal', 'interrupted'); if (this.#personal()) this.command({ type: 'agent-cancel', id: this.#personal()!.id }); this.#emit(); }
  approve(): void {
    const group = this.#view.group;
    if (group?.phase === 'raised') this.command({ type: 'agent-approve', id: group.id, epoch: group.epoch, request: group.request });
  }
  humanSpeech(text: string): void { if (isApproval(text)) this.approve(); }
  update(state: AgentRoomState, serverNow: number): void {
    this.#serverOffset = serverNow - Date.now(); this.#lastState = Date.now();
    if (this.#state.floor && this.#state.floor.id !== state.floor?.id) this.#pastFloors.set(this.#state.floor.id, { floor: this.#state.floor, until: this.#now() + 15_000 });
    for (const [id, past] of this.#pastFloors) if (past.until < this.#now()) this.#pastFloors.delete(id);
    const groupTookFloor = state.floor?.id !== this.#state.floor?.id && state.agents.some((agent) => agent.config.kind === 'group' && agent.id === state.floor?.agentId);
    this.#state = state;
    const personal = this.#personal();
    if (personal?.id !== this.#personalId) {
      this.#stop('personal', 'interrupted'); this.#lines = []; this.#queue = [];
      this.#personalId = personal?.id ?? ''; this.#audience = personal?.config.audience ?? 'private';
    }
    for (const [kind, op] of this.#operations) if (!this.#valid(op)) this.#stop(kind, 'interrupted');
    const group = this.#viewGroup();
    if (groupTookFloor) {
      this.#queue = [];
      if (personal) this.command({ type: 'agent-cancel', id: personal.id });
    }
    if (state.floor && group?.id === state.floor.agentId) {
      this.#stop('personal', 'interrupted');
      if (personal) this.#status = 'Group assistant has the floor. Continue your personal conversation afterwards.';
    }
    if (state.signal && state.signal.id !== this.#signal) {
      this.#signal = state.signal.id;
      if (personal?.config.system) this.#operations.get('personal')?.live?.context(JSON.stringify({ systemSignal: state.signal }));
    }
    if (group?.runner === this.ctx.peerId && ['preparing', 'speaking'].includes(group.phase) && this.#ready) {
      const key = `${group.id}:${group.epoch}:${group.request}:${group.phase}`;
      if (key !== this.#seenGroup) {
        this.#seenGroup = key;
        this.#stop('group', 'interrupted', false);
        const preparing = group.phase === 'preparing';
        this.#status = group.epoch > 1 ? 'Taking over using the public history available on this device; earlier records may be missing.' : preparing ? 'Preparing a group suggestion…' : 'Group assistant is connecting to speak…';
        void this.#start(group, 'public', preparing, preparing ? 'A manual system signal requests a review. Prepare one concise suggestion or question. Do not publish it.' : `The room has explicitly granted the floor. Reconsider this prepared suggestion using the latest meeting context, then share a concise helpful response: ${this.#draft}`, false);
      }
    }
    const pending = this.#pendingPeer.splice(0);
    for (const item of pending) if (item.until > Date.now()) this.receive(item.peer, item.message, item.until);
    this.#attachRemote(); this.#drain(); this.#emit();
  }
  #viewGroup(): RoomAgent | null { return this.#state.agents.find((agent) => agent.config.kind === 'group') ?? null; }
  #now(): number { return Date.now() + this.#serverOffset; }
  #valid(op: Operation): boolean {
    if (this.#closed || this.#operations.get(op.agent.config.kind) !== op || Date.now() - this.#lastState > 30_000) return false;
    const agent = this.#state.agents.find((entry) => entry.id === op.agent.id);
    if (!agent || agent.runner !== this.ctx.peerId || agent.epoch !== op.agent.epoch) return false;
    if (agent.config.kind === 'group' && (agent.request !== op.agent.request || agent.leaseUntil <= this.#now() || agent.phase !== (op.preparing ? 'preparing' : 'speaking'))) return false;
    return op.preparing || op.audience === 'private' || permitsFloor(this.#state, this.ctx.peerId, op.floorId, op.agent.epoch, this.#now());
  }
  #playable(op: Operation): boolean { return this.#valid(op) && !op.preparing && !(op.agent.config.kind === 'personal' && this.#state.floor && this.#state.floor.agentId === this.#viewGroup()?.id); }
  #drain(): void {
    if (this.#closed || this.#operations.has('personal') || !this.#queue.length || (this.#state.floor && (this.#state.floor.agentId === this.#viewGroup()?.id || this.#state.floor.id === this.#releasedFloor))) return;
    const personal = this.#personal(); const item = this.#queue[0];
    if (!personal || !item) return;
    if (item.audience === 'public' && this.#state.floor?.agentId !== personal.id) {
      this.command({ type: 'agent-floor', id: personal.id }); this.#status = 'Waiting for the public speaking turn…'; return;
    }
    this.#queue.shift(); void this.#start(personal, item.audience, false, item.text, item.voice, item.line);
  }
  async #start(agent: RoomAgent, audience: Audience, preparing: boolean, text: string, voice: boolean, inputLine?: AgentLine): Promise<void> {
    const op: Operation = { key: crypto.randomUUID(), agent: structuredClone(agent), audience, floorId: this.#state.floor?.agentId === agent.id ? this.#state.floor.id : '', preparing,
      live: null, microphone: null, stopAudio: null, streamId: null, startedAt: Date.now(), lastSound: 0, heard: false, playback: null, voice, timer: null, rows: new Map() };
    this.#operations.set(agent.config.kind, op);
    const history = agent.config.kind === 'personal' ? this.#lines : [];
    if (inputLine) {
      const line = { ...inputLine, at: audience === 'public' ? new Date(this.#now()).toISOString() : inputLine.at };
      op.rows.set(line.id, { line, start: 0, end: 0 });
      this.#line(op, 'user', '', 0, 0, 'text');
    }
    const valid = () => this.#valid(op);
    try {
      if (voice) {
        const microphone = await this.ctx.beginVoice(audience, op.key);
        if (!valid()) { microphone.stop(); this.ctx.endVoice(op.key); return; }
        op.microphone = microphone;
      }
      const tools = scopedTools(this.ctx.tools, agent.config, agent.owner, valid, () => this.#playable(op) && audience === 'public');
      const live = new AgentLive({
        stream: (stream) => {
          if (!valid() || !this.#audio) return;
          const attached = this.#audio.attach(stream, () => this.#playable(op), (level, playing) => {
            if (!valid() || preparing) return;
            if (level > 0.02 && playing) { op.heard = true; op.lastSound = Date.now(); }
            // ponytail: two seconds of output silence closes a bounded reply; long rhetorical pauses may end it early.
            if (op.heard && !op.microphone && op.live?.canFinish(op.lastSound) && Date.now() - op.lastSound > 2_000) { this.#stop(agent.config.kind, 'finished'); this.#drain(); }
          }, (message) => { if (valid()) { this.#error = message; this.#stop(agent.config.kind, 'interrupted'); } });
          op.stopAudio = attached.stop;
          if (audience === 'public' && !preparing) {
            op.streamId = attached.output.id;
            this.ctx.controller.broadcast({ type: 'agent-stream', floorId: op.floorId, agentId: agent.id, epoch: agent.epoch, streamId: attached.output.id });
            this.ctx.controller.addStream(attached.output);
          }
        },
        transcript: (role, delta, start, end) => { if (!this.#closed && !preparing && (agent.config.kind === 'group' || this.#personalId === agent.id)) this.#line(op, role, delta, start, end, 'speech'); },
        prepared: (draft) => {
          if (!valid()) return;
          this.#draft = draft;
          this.#stop('group', 'not-played', false);
          this.command({ type: 'agent-raised', id: agent.id, epoch: agent.epoch, request: agent.request });
        },
        error: (message) => {
          if (!valid()) { if (!this.#closed && op.playback !== null) { this.#error = message; this.#emit(); } return; }
          this.#error = message; this.#stop(agent.config.kind, 'interrupted', agent.config.kind !== 'group');
          if (agent.config.kind === 'group') { this.#ready = false; this.command({ type: 'agent-failed', id: agent.id, epoch: agent.epoch, request: agent.request }); }
          this.#emit();
        },
        closed: () => { if (valid()) { this.#stop(agent.config.kind, op.heard ? 'finished' : 'not-played'); this.#drain(); } },
      }, tools, preparing, valid);
      op.live = live;
      this.#status = voice ? 'Connecting private microphone…' : preparing ? 'Preparing a suggestion…' : 'Connecting assistant…'; this.#emit();
      await live.start({ room: this.ctx.room, token: this.ctx.controller.sessionToken, agent, microphone: op.microphone, silence: this.#audio!.silence() });
      if (!valid()) { live.close(); return; }
      let context = contextText(this.ctx.tools.log(), agent.config, agent.owner, history);
      if (agent.config.system && this.#state.signal) context += `\nSystem signal: ${JSON.stringify(this.#state.signal)}`;
      if (voice) live.context(context); else live.request(context, text);
      this.#status = voice ? (audience === 'private' ? 'Speak privately to your assistant. Your meeting microphone is paused.' : 'Speak publicly to your assistant. Everyone can hear you.') : preparing ? 'Preparing a suggestion…' : 'Waiting for the assistant’s response…';
      op.timer = setTimeout(() => {
        if (!valid()) return;
        this.#error = preparing ? 'Preparation timed out. Trigger the group assistant again.' : 'This interaction reached its time limit. Continue with a new request.';
        this.#stop(agent.config.kind, 'interrupted');
        if (preparing) this.command({ type: 'agent-cancel', id: agent.id });
        this.#emit();
      }, voice ? 180_000 : 55_000);
      this.#emit();
    } catch (error) {
      if (valid()) { this.#error = error instanceof Error ? error.message : 'Unable to start the assistant.'; this.#stop(agent.config.kind, 'interrupted'); this.#emit(); }
    }
  }
  #line(op: Operation, role: AgentLine['role'], delta: string, start: number, end: number, input: AgentLine['input']): void {
    // Group nearby fragments by timestamp, including late arrivals, without rewriting their text.
    const matching = [...op.rows.values()].find((row) => row.line.role === role && row.line.input === input && start <= row.end + 1_500 && end >= row.start - 1_500 && row.line.text.length + delta.length <= 4_000);
    const row = matching ?? { line: { id: crypto.randomUUID(), agentId: op.agent.id, name: role === 'user' ? this.ctx.tools.snapshot().you.name : op.agent.config.name,
      role, input, audience: op.audience, text: '', at: new Date(this.#now()).toISOString(), playback: 'not-played' } as AgentLine, start, end };
    row.line = { ...row.line, text: row.line.text + delta.slice(0, 4_000), playback: role === 'assistant' ? (op.playback ?? (this.#playable(op) && op.heard ? 'playing' : 'not-played')) : 'not-played' };
    row.start = Math.min(row.start, start); row.end = Math.max(row.end, end); op.rows.set(row.line.id, row);
    if (op.agent.config.kind === 'personal') {
      const index = this.#lines.findIndex((line) => line.id === row.line.id);
      if (index < 0) this.#lines.push(row.line); else this.#lines[index] = row.line;
    }
    this.#publishLine(op, row.line); this.#emit();
  }
  #publishLine(op: Operation, line: AgentLine): void {
    if (line.audience !== 'public' || (op.agent.config.kind === 'group' && this.#viewGroup()?.epoch !== op.agent.epoch)) return;
    this.ctx.publicLine(line, this.ctx.peerId); this.#publicRows.set(line.id, line); this.#ownPublicRows.set(line.id, { type: 'agent-line', floorId: op.floorId, epoch: op.agent.epoch, line });
    this.ctx.controller.broadcast({ type: 'agent-line', floorId: op.floorId, epoch: op.agent.epoch, line });
  }
  #stop(kind: 'personal' | 'group', playback: AgentLine['playback'], release = true): void {
    const op = this.#operations.get(kind); if (!op) return;
    op.playback = op.heard ? playback : 'not-played';
    for (const row of op.rows.values()) if (row.line.role === 'assistant') {
      row.line = { ...row.line, playback: op.heard ? playback : 'not-played' };
      const index = this.#lines.findIndex((line) => line.id === row.line.id); if (index >= 0) this.#lines[index] = row.line;
      this.#publishLine(op, row.line);
    }
    this.#operations.delete(kind);
    if (op.timer) clearTimeout(op.timer);
    op.stopAudio?.();
    if (op.streamId) this.ctx.controller.removeStream(op.streamId);
    op.microphone?.stop();
    if (op.voice) this.ctx.endVoice(op.key);
    op.live?.close();
    if (release && op.floorId) { this.#releasedFloor = op.floorId; this.command({ type: 'agent-finish', floorId: op.floorId }); }
    this.#status = playback === 'interrupted' ? 'Audio stopped. Continue when ready.' : 'Ready for your next question.';
    this.#emit();
  }
  receive(peer: string, message: AgentPeerMessage, until = Date.now() + 3_000): void {
    if (message.type === 'agent-history') {
      for (const entry of message.entries) if (permitsHistory(this.#state, peer, entry) && !this.#publicRows.has(entry.line.id)) { this.#publicRows.set(entry.line.id, entry.line); this.ctx.publicLine(entry.line, peer, true); }
      return;
    }
    const current = permitsFloor(this.#state, peer, message.floorId, message.epoch, this.#now());
    const past = this.#pastFloors.get(message.floorId);
    const late = message.type === 'agent-line' && this.#state.agents.some((agent) => agent.id === message.line.agentId && agent.epoch === message.epoch) && past && past.until > this.#now() && past.floor.runner === peer && past.floor.epoch === message.epoch && past.floor.agentId === message.line.agentId;
    if (!current && !late) {
      if (!past && until > Date.now() && this.#pendingPeer.length < 32) this.#pendingPeer.push({ peer, message, until });
      return;
    }
    if (message.type === 'agent-line') {
      if (current && message.line.agentId !== this.#state.floor?.agentId) return;
      this.#publicRows.set(message.line.id, message.line); this.ctx.publicLine(message.line, peer);
    } else {
      if (message.agentId !== this.#state.floor?.agentId) return;
      const key = `${peer}:${message.streamId}`;
      this.#announcements.get(key)?.stop?.();
      this.#announcements.set(key, { peer, message, stop: null }); this.#attachRemote();
    }
  }
  replayTo(peer: string): void {
    for (const op of this.#operations.values()) if (op.streamId && this.#valid(op)) this.ctx.controller.send(peer, { type: 'agent-stream', floorId: op.floorId, agentId: op.agent.id, epoch: op.agent.epoch, streamId: op.streamId });
    for (const entry of [...this.#ownPublicRows.values()].slice(-400)) this.ctx.controller.send(peer, { type: 'agent-history', entries: [entry] });
  }
  remoteStream(peer: string, stream: MediaStream): void { this.#remoteStreams.set(`${peer}:${stream.id}`, { peer, stream }); this.#attachRemote(); }
  remoteStreamEnded(peer: string, streamId: string): void {
    const key = `${peer}:${streamId}`;
    this.#remoteStreams.delete(key);
    this.#announcements.get(key)?.stop?.();
    this.#announcements.delete(key);
  }
  #attachRemote(): void {
    for (const [key, entry] of this.#announcements) {
      const allowed = () => Date.now() - this.#lastState < 30_000 && permitsFloor(this.#state, entry.peer, entry.message.floorId, entry.message.epoch, this.#now());
      if (!allowed()) { entry.stop?.(); this.#announcements.delete(key); continue; }
      const remote = this.#remoteStreams.get(key);
      if (!entry.stop && remote && this.#audio && this.#ready) entry.stop = this.#audio.attach(remote.stream, allowed, undefined, (message) => {
        entry.stop?.(); entry.stop = null; this.#ready = false; this.command({ type: 'agent-ready', ready: false }); this.#error = message; this.#emit();
      }).stop;
    }
  }
  peerLeft(peer: string): void {
    for (const [key, entry] of this.#announcements) if (entry.peer === peer) { entry.stop?.(); this.#announcements.delete(key); }
    for (const [key, entry] of this.#remoteStreams) if (entry.peer === peer) this.#remoteStreams.delete(key);
  }
  close(): void {
    if (this.#closed) return;
    this.#stop('personal', 'interrupted'); this.#stop('group', 'interrupted');
    this.command({ type: 'agent-ready', ready: false }); this.#closed = true;
    clearInterval(this.#heartbeat); this.#audio?.close(); this.#listeners.clear(); this.#lines = []; this.#queue = [];
  }
}
