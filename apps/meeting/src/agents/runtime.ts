import { GROUP_CHECK_MS, GROUP_MAX_INTERVENTIONS, GROUP_MIN_RECORDS, GROUP_QUIET_MS, GROUP_REVIEW_REQUEST, evidenceKey, isDiscussion, parseGroupDecision, parseGroupEvidence, type DiscussionRecord, type GroupDecision } from './group';
import { defaultAgentConfig } from './config';
import { AgentAudio } from './audio';
import { AgentLive } from './live';
import { contextText, scopedTools } from './tools';
import { emptyAgentRoom, HEARTBEAT_MS, parseAgentConfig, permitsFloor, permitsHistory, type AgentCommand, type AgentConfig, type AgentLine, type AgentPeerMessage, type AgentRoomState, type Audience, type RoomAgent } from './contracts';
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
  speechTimer: ReturnType<typeof setTimeout> | null;
  rows: Map<string, { line: AgentLine; start: number; end: number }>;
}
export interface AgentView {
  room: AgentRoomState;
  personal: RoomAgent | null;
  group: RoomAgent | null;
  groupStatus: string;
  audience: Audience;
  lines: AgentLine[];
  status: string;
  error: string | null;
  voice: boolean;
  ready: boolean;
  queued: number;
  publicPersonalSpeaking: boolean;
  personalActive: boolean;
}

export class AgentRuntime {
  #state = emptyAgentRoom();
  #lines: AgentLine[] = [];
  #audience: Audience = 'private';
  #connectionLost = false;
  #recoverConfig: AgentConfig | null = null;
  #recoverReady = false;
  #creatingPersonal: Promise<RoomAgent> | null = null;
  #approvalVersion = 0;
  #publicRequestPending = false;
  #restorePrivateHistory = false;
  #awaitingRecoveryState = false;
  #personalId = '';
  #audio: AgentAudio | null = null;
  #operations = new Map<'personal' | 'group', Operation>();
  #draft: GroupDecision | null = null;
  #reviewRecords: DiscussionRecord[] = [];
  #reviewCursor = 0;
  #observedCursor = 0;
  #lastHumanAt = Date.now();
  #nextReviewAttempt = 0;
  #draftAt = 0;
  #groupMonitoring = true;
  #groupForeground = true;
  #seenGroup = '';
  #queue: Array<{ text: string; voice: boolean; audience: Audience; line: AgentLine | undefined }> = [];
  #listeners = new Set<() => void>();
  #closed = false;
  #serverOffset = 0;
  #lastState = 0;
  #signal = 0;
  #releasedFloor = '';
  #error: string | null = null;
  #status = 'Add Muse to start a conversation.';
  #ready = false;
  #remoteStreams = new Map<string, { peer: string; stream: MediaStream }>();
  #announcements = new Map<string, { peer: string; message: Extract<AgentPeerMessage, { type: 'agent-stream' }>; stop: (() => void) | null }>();
  #publicRows = new Map<string, AgentLine>();
  #pendingPeer: Array<{ peer: string; message: AgentPeerMessage; until: number }> = [];
  #ownPublicRows = new Map<string, Extract<AgentPeerMessage, { type: 'agent-line' }>>();
  #pastFloors = new Map<string, { floor: NonNullable<AgentRoomState['floor']>; until: number }>();
  #heartbeat: ReturnType<typeof setInterval>;
  #contextTimer: ReturnType<typeof setInterval>;
  #view: AgentView;
  constructor(readonly ctx: RuntimeContext) {
    this.#view = this.#snapshot();
    this.#heartbeat = setInterval(() => {
      this.command({ type: 'agent-heartbeat' });
      if (this.#lastState && Date.now() - this.#lastState > 30_000) {
        this.#stop('group', 'interrupted'); this.#stop('personal', 'interrupted');
        this.#error = 'Room coordination lost. Agent audio is stopped.'; this.#emit();
      }
    }, HEARTBEAT_MS);
    // Include participant, interim-caption and file-availability changes even when
    // the finalized log has not advanced. Live suppresses unchanged records.
    this.#contextTimer = setInterval(() => {
      this.checkGroup(); this.#emit();
      for (const op of this.#operations.values()) {
        if (!this.#valid(op) || (op.agent.config.kind === 'personal' && op.audience === 'public')) continue;
        op.live?.context(contextText(this.ctx.tools.log(), op.agent.config, op.agent.owner, [], this.ctx.tools.snapshot()));
      }
    }, 2_000);
  }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): AgentView => this.#view;
  #snapshot(): AgentView {
    return { room: this.#state, personal: this.#personal(), group: this.#state.agents.find((agent) => agent.config.kind === 'group') ?? null,
      groupStatus: this.#state.automation.published >= GROUP_MAX_INTERVENTIONS ? 'Five suggestions shared; automatic review is finished for this room.' : this.#now() < this.#state.automation.nextPublishAt ? 'Giving the room time to discuss.' : this.#discussion().length < GROUP_MIN_RECORDS ? 'Waiting for at least four public discussion messages.' : 'Watching for new public discussion.',
      personalActive: this.#operations.has('personal') || this.#queue.length > 0 || this.#publicRequestPending,
      audience: this.#audience, lines: [...this.#lines], status: this.#status, error: this.#error, voice: !!this.#operations.get('personal')?.microphone, ready: this.#ready, queued: this.#queue.length, publicPersonalSpeaking: this.#publicRequestPending || this.#operations.get('personal')?.audience === 'public' || this.#queue.some((item) => item.audience === 'public') };
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
  #pendingSaves = new Set<() => void>();
  async create(config: AgentConfig): Promise<void> {
    if (config.kind === 'group') await this.enable();
    await this.#saveConfig({ type: 'agent-create', config });
  }
  async configure(id: string, config: AgentConfig): Promise<void> {
    await this.#saveConfig({ type: 'agent-configure', id, config });
  }
  #saveConfig(command: Extract<AgentCommand, { type: 'agent-create' | 'agent-configure' }>): Promise<void> {
    if (this.#closed || this.#connectionLost || this.#awaitingRecoveryState) return Promise.reject(new Error('Reconnect to the meeting before saving agent settings.'));
    const config = parseAgentConfig(command.config);
    if (!config) return Promise.reject(new Error('Invalid agent settings.'));
    command = { ...command, config };
    if (command.type === 'agent-create' && this.#state.agents.some((agent) => agent.config.kind === command.config.kind && (agent.config.kind === 'group' || agent.owner === this.ctx.peerId))) return Promise.reject(new Error('This agent already exists. Open settings to edit it.'));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timeout); unsubscribe(); this.#pendingSaves.delete(cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error('The meeting closed before settings were saved.'));
      const unsubscribe = this.subscribe(() => {
        if (this.#connectionLost) { finish(new Error('The meeting disconnected. Please retry.')); return; }
        const agent = this.#state.agents.find((entry) => command.type === 'agent-configure' ? entry.id === command.id : entry.config.kind === command.config.kind && (entry.config.kind === 'group' || entry.owner === this.ctx.peerId));
        if (agent && command.type === 'agent-create' && agent.owner !== this.ctx.peerId) finish(new Error('Another participant has already added Omni. Open settings to edit it.'));
        else if (agent && JSON.stringify(parseAgentConfig(agent.config)) === JSON.stringify(command.config)) finish();
      });
      const timeout = setTimeout(() => finish(new Error('The room did not confirm settings. Please retry.')), 10_000);
      this.#pendingSaves.add(cancel);
      try { this.command(command); } catch (error) { finish(error instanceof Error ? error : new Error('Unable to save settings.')); }
    });
  }

  remove(id: string): void {
    if (this.#closed) return;
    if (this.#connectionLost || this.#awaitingRecoveryState) {
      this.#error = 'Reconnect to the meeting before removing an assistant.'; this.#emit(); return;
    }
    this.#error = null;
    for (const [kind, op] of this.#operations) if (op.agent.id === id) this.#stop(kind, 'interrupted');
    if (id === this.#personalId) { this.#queue = []; this.#lines = []; }
    this.command({ type: 'agent-remove', id });
    this.#emit();
  }
  /** Kept for callers upgrading from the old panel; persistent public mode is disabled. */
  setAudience(_audience: Audience): void { this.#audience = 'private'; }
  restoreConversation(lines: AgentLine[]): void {
    // Restored records are local context only, never replayed as public messages or audio.
    this.#lines = lines.filter((line) => line.audience === 'private').slice(-200).map((line) => ({ ...line,
      playback: line.playback === 'playing' ? 'interrupted' : line.playback,
    }));
    this.#restorePrivateHistory = !this.#personal();
    this.#emit();
  }
  async initializePersonal(): Promise<void> { await this.#ensurePersonal(); }
  async #ensurePersonal(config = defaultAgentConfig('personal')): Promise<RoomAgent> {
    const existing = this.#personal();
    if (existing) return existing;
    if (this.#creatingPersonal) return this.#creatingPersonal;
    this.#creatingPersonal = (async () => {
      if (this.#closed || this.#connectionLost) throw new Error('Reconnect to the meeting before using Muse.');
      this.command({ type: 'agent-create', config });
      return await new Promise<RoomAgent>((resolve, reject) => {
        const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Muse could not be created. Please try again.')); }, 10_000);
        const unsubscribe = this.subscribe(() => {
          const personal = this.#personal();
          if (personal) { clearTimeout(timeout); unsubscribe(); resolve(personal); }
          else if (this.#connectionLost) { clearTimeout(timeout); unsubscribe(); reject(new Error('The meeting disconnected. Please retry.')); }
        });
      });
    })();
    try { return await this.#creatingPersonal; } finally { this.#creatingPersonal = null; }
  }
  async discussReminder(text: string): Promise<void> {
    await this.#ensurePersonal();
    await this.ask(`Help me consider this private reminder. Do not speak to the room: ${text}`);
  }
  async speakForMe(text: string): Promise<void> {
    text = text.trim();
    if (!text || text.length > 4_000) throw new Error('Select a reminder to speak about.');
    this.stopPersonal();
    const version = this.#approvalVersion;
    this.#publicRequestPending = true; this.#emit();
    let personal: RoomAgent;
    try {
      personal = await this.#ensurePersonal();
      if (version !== this.#approvalVersion) return;
      await this.enable();
    } finally {
      if (version === this.#approvalVersion) { this.#publicRequestPending = false; this.#emit(); }
    }
    if (this.#closed || this.#connectionLost || version !== this.#approvalVersion || this.#personal()?.id !== personal.id) return;
    // A fresh session receives only the approved text: private conversations and tools are excluded.
    this.#queue.push({ text: `Speak once on behalf of ${this.ctx.tools.snapshot().you.name}. The owner approved ONLY the concern below. You may explain it briefly, in about 15–20 seconds. Do not add a new stance, commitment, unrelated claim, or private detail. Then stop. Approved concern: ${JSON.stringify(text)}`, voice: false, audience: 'public', line: undefined });
    this.#drain(); this.#emit();
  }
  ownerStartedSpeaking(): void {
    // Also revoke permission while awaiting an asynchronous enable or a speaking turn.
    this.#approvalVersion++; this.#publicRequestPending = false;
    const publicPending = this.#queue.some((item) => item.audience === 'public');
    this.#queue = this.#queue.filter((item) => item.audience !== 'public');
    if (this.#operations.get('personal')?.audience === 'public') this.#stop('personal', 'interrupted');
    if (publicPending && this.#personal()) this.command({ type: 'agent-cancel', id: this.#personal()!.id });
    this.#emit();
  }
  connectionLost(): void {
    if (this.#connectionLost) return;
    this.#recoverConfig = this.#personal()?.config ?? this.#recoverConfig;
    this.#recoverReady = this.#ready;
    this.#restorePrivateHistory = true; this.#seenGroup = '';
    this.#connectionLost = true;
    this.stopPersonal(); this.#stop('group', 'interrupted');
    for (const entry of this.#announcements.values()) entry.stop?.();
    this.#announcements.clear(); this.#remoteStreams.clear();
    this.#ready = false; this.#emit();
  }
  connectionRestored(): void {
    this.#connectionLost = false;
    if (this.#recoverReady) { this.#ready = true; this.command({ type: 'agent-ready', ready: true }); }
    // Welcome precedes the authoritative agent-state. The cached personal agent may no longer exist.
    this.#awaitingRecoveryState = !!this.#recoverConfig;
    this.#recoverReady = false; this.#emit();
  }
  async ask(text: string, voice = false): Promise<void> {
    const personal = this.#personal();
    if (!personal) return;
    text = text.trim();
    if ((!text && !voice) || text.length > 4_000) return;
    const audience: Audience = 'private';
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
      this.#status = 'Listening ended. Waiting for Muse.'; this.#emit();
    }
  }
  stopPersonal(): void { this.#approvalVersion++; this.#publicRequestPending = false; this.#queue = []; this.#stop('personal', 'interrupted'); if (this.#personal()) this.command({ type: 'agent-cancel', id: this.#personal()!.id }); this.#emit(); }
  setGroupForeground(visible: boolean): void { this.#groupForeground = visible; this.noteHumanActivity(); }
  setGroupMonitoring(available: boolean): void {
    this.#groupMonitoring = available;
    if (!available) this.#error = 'Omni is paused because speech activity monitoring is unavailable.';
    else if (this.#error === 'Omni is paused because speech activity monitoring is unavailable.') this.#error = null;
    this.#emit();
  }
  noteHumanActivity(): void { this.#lastHumanAt = Date.now(); }
  #discussion(): DiscussionRecord[] { return this.ctx.tools.log().snapshot(500).filter(isDiscussion).slice(-40); }
  #quiet(): boolean {
    const cursor = this.#discussion().at(-1)?.seq ?? 0;
    if (cursor !== this.#observedCursor || this.ctx.tools.snapshot().live.length) {
      this.#observedCursor = cursor; this.noteHumanActivity();
    }
    return Date.now() - this.#lastHumanAt >= GROUP_QUIET_MS;
  }
  #discardGroup(group: RoomAgent): void {
    this.#draft = null;
    this.#stop('group', 'not-played', false);
    this.command({ type: 'agent-cancel', id: group.id });
  }
  /** Called by the regular context timer; there is no user-triggered review path. */
  checkGroup(): void {
    const group = this.#viewGroup();
    if (!group || !this.#groupMonitoring || !this.#groupForeground || group.runner !== this.ctx.peerId || !this.#ready || this.#closed || this.#connectionLost || Date.now() - this.#lastState > 30_000 || group.leaseUntil <= this.#now()) return;
    const quiet = this.#quiet();
    const records = this.#discussion();
    if (group.phase === 'raised' || group.phase === 'speaking') {
      if (!this.#draft || !parseGroupDecision(JSON.stringify(this.#draft), this.#reviewRecords, this.ctx.tools.snapshot()) || records.at(-1)?.seq !== this.#reviewCursor || Date.now() - this.#draftAt > 30_000) { this.#discardGroup(group); return; }
      if (!quiet) return;
      if (group.phase === 'raised') {
        if (!this.#state.floor) this.command({ type: 'agent-publish', id: group.id, epoch: group.epoch, request: group.request });
      } else if (this.#state.floor?.agentId === group.id) {
        const line: AgentLine = { id: crypto.randomUUID(), agentId: group.id, name: 'Omni', role: 'assistant', input: 'text', audience: 'public', text: this.#draft.text, at: new Date(this.#now()).toISOString(), playback: 'not-played' };
        const message: Extract<AgentPeerMessage, { type: 'agent-line' }> = { type: 'agent-line', floorId: this.#state.floor.id, epoch: group.epoch, line };
        this.#draft = null;
        this.ctx.publicLine(line, this.ctx.peerId); this.#publicRows.set(line.id, line); this.#ownPublicRows.set(line.id, message); this.ctx.controller.broadcast(message);
        this.command({ type: 'agent-published', floorId: this.#state.floor.id });
      }
      return;
    }
    if (group.phase !== 'idle' || !quiet || this.#state.floor || this.#now() < Math.max(this.#state.automation.nextCheckAt, this.#state.automation.nextPublishAt) ||
      this.#state.automation.published >= GROUP_MAX_INTERVENTIONS || Date.now() < this.#nextReviewAttempt || records.length < GROUP_MIN_RECORDS ||
      !records.some(record => record.seq > this.#reviewCursor && !record.replayed)) return;
    // Advance the consumed cursor only when the authority accepts preparation.
    this.#nextReviewAttempt = Date.now() + GROUP_CHECK_MS;
    this.command({ type: 'agent-review', id: group.id, epoch: group.epoch, request: group.request });
  }
  update(state: AgentRoomState, serverNow: number): void {
    const previousPersonal = this.#personal();
    const previousGroup = this.#viewGroup();
    this.#serverOffset = serverNow - Date.now(); this.#lastState = Date.now();
    if (this.#state.floor && this.#state.floor.id !== state.floor?.id) this.#pastFloors.set(this.#state.floor.id, { floor: this.#state.floor, until: this.#now() + 15_000 });
    for (const [id, past] of this.#pastFloors) if (past.until < this.#now()) this.#pastFloors.delete(id);
    this.#state = state;
    const personal = this.#personal();
    if (personal && previousPersonal?.id === personal.id && previousPersonal.epoch !== personal.epoch) {
      this.#approvalVersion++; this.#publicRequestPending = false; this.#queue = [];
      this.#stop('personal', 'interrupted');
    }
    if (personal?.id !== this.#personalId) {
      this.#stop('personal', 'interrupted'); if (!this.#restorePrivateHistory) this.#lines = []; this.#queue = [];
      if (personal) this.#restorePrivateHistory = false;
      this.#personalId = personal?.id ?? ''; this.#audience = 'private';
      this.#status = personal ? 'Ready for your question.' : 'Add Muse to start a conversation.';
    }
    for (const [kind, op] of this.#operations) if (!this.#valid(op)) this.#stop(kind, 'interrupted');
    const group = this.#viewGroup();
    if (group?.id !== previousGroup?.id || group?.epoch !== previousGroup?.epoch) {
      this.#draft = null; this.#reviewCursor = this.#discussion().at(-1)?.seq ?? 0;
      this.#observedCursor = this.#reviewCursor; this.noteHumanActivity();
    }
    if (state.signal && state.signal.id !== this.#signal) {
      this.#signal = state.signal.id;
      for (const op of this.#operations.values()) {
        if (!this.#valid(op) || !op.agent.config.system || (op.agent.config.kind === 'personal' && op.audience === 'public')) continue;
        op.live?.context(JSON.stringify({ systemSignal: state.signal }));
      }
    }
    if (group?.runner === this.ctx.peerId && group.phase === 'preparing' && this.#ready) {
      const key = `${group.id}:${group.epoch}:${group.request}`;
      if (key !== this.#seenGroup) {
        this.#seenGroup = key; this.#draft = null;
        this.#stop('group', 'interrupted', false);
        const recent = this.#discussion();
        const anchors = this.ctx.tools.log().filtered(isDiscussion).read(0, 3).entries.filter(isDiscussion);
        this.#reviewRecords = [...anchors.filter(record => !recent.some(entry => entry.seq === record.seq)), ...recent];
        this.#reviewCursor = this.#reviewRecords.at(-1)?.seq ?? 0;
        if (this.#reviewRecords.length < GROUP_MIN_RECORDS) this.#discardGroup(group);
        else void this.#start(group, 'public', true, GROUP_REVIEW_REQUEST, false);
      }
    }
    if (group && ['raised', 'speaking'].includes(group.phase)) this.checkGroup();
    if (this.#awaitingRecoveryState && !this.#connectionLost) {
      this.#awaitingRecoveryState = false;
      const config = this.#recoverConfig; this.#recoverConfig = null;
      if (config && !personal) void this.#ensurePersonal(config).catch((error: unknown) => { this.#error = error instanceof Error ? error.message : 'Unable to restore Muse.'; this.#emit(); });
    }
    const pending = this.#pendingPeer.splice(0);
    for (const item of pending) if (item.until > Date.now()) this.receive(item.peer, item.message, item.until);
    this.#attachRemote(); this.#drain(); this.#emit();
  }
  #viewGroup(): RoomAgent | null { return this.#state.agents.find((agent) => agent.config.kind === 'group') ?? null; }
  #now(): number { return Date.now() + this.#serverOffset; }
  #valid(op: Operation): boolean {
    if (this.#closed || this.#connectionLost || this.#operations.get(op.agent.config.kind) !== op || Date.now() - this.#lastState > 30_000) return false;
    const agent = this.#state.agents.find((entry) => entry.id === op.agent.id);
    if (!agent || agent.runner !== this.ctx.peerId || agent.epoch !== op.agent.epoch) return false;
    if (agent.config.kind === 'group' && (agent.request !== op.agent.request || agent.leaseUntil <= this.#now() || agent.phase !== (op.preparing ? 'preparing' : 'speaking'))) return false;
    return op.preparing || op.audience === 'private' || permitsFloor(this.#state, this.ctx.peerId, op.floorId, op.agent.epoch, this.#now());
  }
  #playable(op: Operation): boolean { return this.#valid(op) && !op.preparing && op.agent.config.kind === 'personal'; }
  #drain(): void {
    if (this.#closed || this.#operations.has('personal') || !this.#queue.length || (this.#state.floor && this.#state.floor.id === this.#releasedFloor)) return;
    const personal = this.#personal(); const item = this.#queue[0];
    if (!personal || !item) return;
    if (item.audience === 'public' && this.#state.floor && this.#state.floor.agentId !== personal.id) return;
    if (item.audience === 'public' && this.#state.floor?.agentId !== personal.id) {
      this.command({ type: 'agent-floor', id: personal.id }); this.#status = 'Waiting for the public speaking turn…'; return;
    }
    this.#queue.shift(); void this.#start(personal, item.audience, false, item.text, item.voice, item.line);
  }
  async #start(agent: RoomAgent, audience: Audience, preparing: boolean, text: string, voice: boolean, inputLine?: AgentLine): Promise<void> {
    const op: Operation = { key: crypto.randomUUID(), agent: structuredClone(agent), audience, floorId: this.#state.floor?.agentId === agent.id ? this.#state.floor.id : '', preparing,
      live: null, microphone: null, stopAudio: null, streamId: null, startedAt: Date.now(), lastSound: 0, heard: false, playback: null, voice, timer: null, speechTimer: null, rows: new Map() };
    this.#operations.set(agent.config.kind, op);
    this.#error = null;
    const behalf = agent.config.kind === 'personal' && audience === 'public';
    const history = agent.config.kind === 'personal' && !behalf ? this.#lines : [];
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
      // A direct private request may ask for a shared text/board action. It does
      // not grant the assistant a public audio floor or expose private history.
      const tools = behalf ? [] : scopedTools(this.ctx.tools, agent.config, agent.owner, valid,
        () => valid() && !preparing && agent.config.kind === 'personal' && audience === 'private');
      const live = new AgentLive({
        stream: (stream) => {
          if (!valid() || !this.#audio || agent.config.kind === 'group') return;
          const attached = this.#audio.attach(stream, () => this.#playable(op), (level, playing) => {
            if (!valid() || preparing) return;
            if (level > 0.02 && playing) {
              if (!op.heard && behalf) op.speechTimer = setTimeout(() => { if (valid()) { this.#stop('personal', 'finished'); this.#drain(); } }, 20_000);
              op.heard = true; op.lastSound = Date.now();
            }
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
        transcript: (role, delta, start, end) => { if (!this.#closed && !preparing && (audience === 'private' || valid()) && (agent.config.kind === 'group' || this.#personalId === agent.id)) this.#line(op, role, delta, start, end, 'speech'); },
        prepared: async (draft) => {
          if (!valid()) return;
          try {
            const decision = parseGroupDecision(draft, this.#reviewRecords, this.ctx.tools.snapshot());
            if (!decision) { this.#discardGroup(agent); return; }
            const evidence = await Promise.all(this.#reviewRecords.filter(record => decision.evidenceSeqs.includes(record.seq)).map(evidenceKey));
            if (!valid()) return;
            const signal = parseGroupEvidence({ kind: decision.kind, evidence });
            if (!signal || this.#discussion().at(-1)?.seq !== this.#reviewCursor) { this.#discardGroup(agent); return; }
            this.#draft = decision; this.#draftAt = Date.now();
            this.#stop('group', 'not-played', false);
            this.command({ type: 'agent-raised', id: agent.id, epoch: agent.epoch, request: agent.request, signal });
          } catch {
            if (valid()) { this.#error = 'Omni could not validate the review evidence.'; this.#discardGroup(agent); this.#emit(); }
          }
        },
        contextPaused: () => {
          if (!valid()) return;
          this.#status = 'Background updates paused to reserve space for tools. Muse can fetch current meeting details when asked. Start a new voice session for continuous updates.';
          this.#emit();
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
      this.#status = voice ? 'Connecting private microphone…' : preparing ? 'Preparing a suggestion…' : 'Connecting Muse…'; this.#emit();
      await live.start({ room: this.ctx.room, token: this.ctx.controller.sessionToken, agent: behalf ? { ...agent, config: { ...agent.config, instructions: 'Speak once on behalf of the owner using only the current approved concern. Modest elaboration is allowed, without new positions, promises, or private information. Speak for at most 20 seconds, then stop.' } } : agent, microphone: op.microphone, silence: this.#audio!.silence() });
      if (!valid()) { live.close(); return; }
      let context = behalf ? '{}' : contextText(this.ctx.tools.log(), agent.config, agent.owner, history, this.ctx.tools.snapshot());
      if (preparing) {
        const seed = JSON.parse(context) as Record<string, unknown>;
        seed.reviewEvidence = { eligibleSeqs: this.#reviewRecords.map(record => record.seq), opening: this.#reviewRecords.slice(0, 3).map(record => ({ ...record, text: record.text.slice(0, 1000) })) };
        context = JSON.stringify(seed);
      }
      if (!behalf && agent.config.system && this.#state.signal) context += `\nSystem signal: ${JSON.stringify(this.#state.signal)}`;
      if (voice) live.context(context); else live.request(context, text);
      this.#status = voice ? (audience === 'private' ? 'Speak privately to Muse. Your meeting microphone is paused.' : 'Speak publicly to Muse. Everyone can hear you.') : preparing ? 'Preparing a suggestion…' : 'Waiting for Muse’s response…';
      // Muse conversations have no fixed duration limit. Only group suggestion
      // preparation is bounded by the room's preparation lease.
      if (preparing) op.timer = setTimeout(() => {
        if (!valid()) return;
        this.#error = 'Omni preparation timed out.';
        this.#stop(agent.config.kind, 'interrupted');
        this.command({ type: 'agent-cancel', id: agent.id });
        this.#drain();
        this.#emit();
      }, 55_000);
      this.#emit();
    } catch (error) {
      if (valid()) { this.#error = error instanceof Error ? error.message : 'Unable to start the agent.'; this.#stop(agent.config.kind, 'interrupted'); if (preparing) this.command({ type: 'agent-cancel', id: agent.id }); this.#emit(); }
    }
  }
  #line(op: Operation, role: AgentLine['role'], delta: string, start: number, end: number, input: AgentLine['input']): void {
    if (!this.#state.agents.some((agent) => agent.id === op.agent.id && agent.epoch === op.agent.epoch)) return;
    // Group nearby fragments by timestamp, including late arrivals, without rewriting their text.
    const matching = [...op.rows.values()].find((row) => row.line.role === role && row.line.input === input && start <= row.end + 1_500 && end >= row.start - 1_500 && row.line.text.length + delta.length <= 4_000);
    const row = matching ?? { line: { id: crypto.randomUUID(), agentId: op.agent.id, name: role === 'user' ? this.ctx.tools.snapshot().you.name : op.agent.config.kind === 'personal' && op.audience === 'public' ? `${this.ctx.tools.snapshot().you.name.slice(0, 24)}’s Muse` : op.agent.config.name,
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
    if (op.speechTimer) clearTimeout(op.speechTimer);
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
      if (message.agentId !== this.#state.floor?.agentId || this.#state.agents.find((agent) => agent.id === message.agentId)?.config.kind !== 'personal') return;
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
    for (const cancel of this.#pendingSaves) cancel();
    this.#stop('personal', 'interrupted'); this.#stop('group', 'interrupted');
    this.command({ type: 'agent-ready', ready: false }); this.#closed = true;
    clearInterval(this.#heartbeat); clearInterval(this.#contextTimer); this.#audio?.close(); this.#listeners.clear(); this.#lines = []; this.#queue = [];
  }
}
