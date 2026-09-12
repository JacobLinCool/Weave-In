import { MeetingLog, type MeetingLogEntry } from '../meeting-log';
import { createMeetingTools, type MeetingSnapshot, type MeetingToolsContext, type ToolDefinition, type ToolResult } from '../webmcp';
import { TOOL_NAMES, record, type AgentConfig, type AgentLine } from './contracts';
import { readSharedFile, READ_SHARED_FILE_SCHEMA, READ_SHARED_FILE_DESCRIPTION } from './attachments';

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const BOARD_PAGE_SIZE = 10;
const CONTEXT_BYTES = 6_000;
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const failure = (text = 'This action is not authorized for the current agent turn.'): ToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const mutation = (name: string, input: unknown) => name === 'send_chat_message' || (name === 'edit_whiteboard' && (!record(input) || input.action !== 'read'));

function scopedSnapshot(snapshot: MeetingSnapshot, config: AgentConfig, owner: string): MeetingSnapshot {
  const allowedPeer = (peer: string) => config.source === 'all' || (config.source === 'owner' && peer === owner);
  return { ...snapshot, participants: snapshot.participants.filter((participant) => allowedPeer(participant.peerId)),
    live: snapshot.live.filter((line) => allowedPeer(line.peerId)), files: config.files ? snapshot.files : [], presentation: config.screen ? snapshot.presentation : null };
}

export function visibleRecord(entry: MeetingLogEntry, config: AgentConfig, owner: string): boolean {
  if (entry.kind === 'file') return config.files;
  if (entry.kind === 'presence') return config.source === 'all' || (config.source === 'owner' && entry.participant.peerId === owner);
  if (config.source === 'none') return false;
  if (entry.kind === 'chat' && !config.chat) return false;
  const peerId = entry.kind === 'transcript' ? entry.speaker.peerId : entry.sender.peerId;
  return config.source === 'all' || peerId === owner;
}

export function scopedTools(base: MeetingToolsContext, config: AgentConfig, owner: string, active: () => boolean, canPublish: () => boolean): ToolDefinition[] {
  const context: MeetingToolsContext = {
    ...base,
    snapshot: () => scopedSnapshot(base.snapshot(), config, owner),
    log: () => base.log().filtered((entry) => visibleRecord(entry, config, owner)),
    download: async (fileId) => {
      if (!active() || !config.files) throw new Error('Shared file access is not authorized.');
      const downloaded = await base.download(fileId);
      if (!active()) throw new Error('This agent turn has ended.');
      return downloaded;
    },
    captureWhiteboard: async (options) => {
      if (!active()) throw new Error('This agent turn has ended.');
      return base.captureWhiteboard(options, active);
    },
    editWhiteboard: async (input) => {
      const authorized = () => active() && (!mutation('edit_whiteboard', input) || canPublish());
      if (!authorized()) throw new Error('Shared whiteboard editing is not authorized for this turn.');
      return base.editWhiteboard(input, authorized);
    },
    sendAgentMessage: (text) => {
      if (!active() || !canPublish() || (config.kind === 'personal' && config.roomMessages !== true)) throw new Error('Public posting is not authorized for this turn.');
      return base.sendAgentMessage(text, config.name);
    },
  };
  const tools = [...createMeetingTools(context), {
    name: 'read_shared_file',
    description: READ_SHARED_FILE_DESCRIPTION,
    inputSchema: READ_SHARED_FILE_SCHEMA,
    annotations: readOnly, execute: (input: unknown) => readSharedFile(context, input, active),
  }];
  return tools.filter((tool) =>
    TOOL_NAMES.some((name) => name === tool.name) && (tool.name !== 'capture_screen_share' || config.screen) &&
    (tool.name !== 'read_shared_file' || config.files) &&
    (tool.name !== 'send_chat_message' || config.kind !== 'personal' || config.roomMessages === true) &&
    (!['edit_whiteboard', 'capture_whiteboard'].includes(tool.name) || config.kind === 'personal'),
  ).map((tool): ToolDefinition => ({ ...tool,
    ...(tool.name === 'read_meeting' ? { description: 'Read every available meeting record from this browser, scoped to the configured sources: finalized transcripts with speakers, Room messages, file announcements and presence. Pages default to 500 complete records, with a maximum of 500. Start at after=0 and continue using nextCursor until hasMore=false to read all available history. Sequence numbers reflect arrival order; replayed records retain their original at timestamp. Also returns current participants, interim captions, screen-share metadata, and file inventory. Use read_shared_file with a file id to download and inspect its contents. File inventory is paged separately using fileOffset. This browser may not have records from the entire meeting.',
      inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), limit: { type: 'integer', minimum: 1, maximum: 500, default: 500 }, fileOffset: { type: 'integer', minimum: 0, default: 0, description: 'Starting file inventory index; each page includes up to 20 files.' } } } } : {}),
    ...(tool.name === 'capture_whiteboard' ? { description: 'Capture the shared whiteboard as an image, automatically opening it in this browser. Use after edit_whiteboard to verify the visual layout and labels. Captures the current viewport; objects outside it may require read pages to inspect. Does not modify board objects.',
      inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), quality: { type: 'number', maximum: 1, description: 'JPEG quality from 0.1 to 1; defaults to 0.8.' } } } } : {}),
    ...(tool.name === 'edit_whiteboard' ? { description: `${tool.description} Agent reads return up to 10 compact records; continue with nextOffset. Mutations require the current owner's explicit request.`,
      inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), limit: { type: 'integer', minimum: 1, maximum: BOARD_PAGE_SIZE, default: BOARD_PAGE_SIZE } } } } : {}),
    execute: async (input) => {
    if (!active() || (mutation(tool.name, input) && !canPublish()) || (tool.name === 'send_chat_message' && config.kind === 'personal' && config.roomMessages !== true)) return failure();
    let result: ToolResult;
    if (tool.name === 'read_meeting') {
      const args = record(input) ? input : {};
      const fileOffset = args.fileOffset ?? 0;
      if (!Number.isSafeInteger(fileOffset) || Number(fileOffset) < 0) return failure('fileOffset must be a non-negative integer.');
      result = await tool.execute({ ...args, limit: args.limit ?? 500 });
      result = mapPayload(result, (payload) => {
        const { privateReminderGuidance: _privateReminderGuidance, ...meeting } = payload;
        const files = Array.isArray(payload.files) ? payload.files : [];
        return { ...meeting, files: files.slice(Number(fileOffset), Number(fileOffset) + 20), fileInventory: { total: files.length, nextOffset: Math.min(files.length, Number(fileOffset) + 20), hasMore: Number(fileOffset) + 20 < files.length },
          coverage: { localOnly: true, throughCursor: context.log().head, availableRecords: context.log().length, note: 'Available in this browser, including received history replay. Earlier records may be unavailable.' } };
      });
    } else if (tool.name === 'edit_whiteboard') {
      const args = record(input) ? input : {};
      result = await tool.execute(args.action === 'read' ? { ...args, limit: typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(args.limit, BOARD_PAGE_SIZE) : args.limit ?? BOARD_PAGE_SIZE } : input);
      result = mapPayload(result, compactBoard);
    } else result = await tool.execute(input);
    if (!active()) return failure('This agent turn has ended.');
    return result;
  } }));
}

function mapPayload(result: ToolResult, transform: (payload: Record<string, unknown>) => Record<string, unknown>): ToolResult {
  if (result.isError) return result;
  return { ...result, content: result.content.map((part) => {
    if (part.type !== 'text') return part;
    const payload: unknown = JSON.parse(part.text);
    return record(payload) ? { type: 'text', text: JSON.stringify(transform(payload)) } : part;
  }) };
}

function compactBoard(payload: Record<string, unknown>): Record<string, unknown> {
  const { elements, ...metadata } = payload;
  if (payload.action !== 'read') {
    const changedIds = Array.isArray(metadata.changedIds) ? metadata.changedIds : [];
    return { ...metadata, changedIds: changedIds.slice(0, 50), changedIdCount: changedIds.length, changedIdsTruncated: changedIds.length > 50,
      verification: 'Edit accepted. Use capture_whiteboard to verify appearance and edit_whiteboard action read for current object ids.' };
  }
  return { ...metadata, elements: (Array.isArray(elements) ? elements : []).filter(record).map((element) => {
    const text = typeof element.originalText === 'string' ? element.originalText : typeof element.text === 'string' ? element.text : undefined;
    const compact: Record<string, unknown> = {};
    for (const key of ['id', 'type', 'kind', 'x', 'y', 'width', 'height', 'angle', 'containerId', 'from', 'to', 'isDeleted']) if (element[key] !== undefined) compact[key] = element[key];
    for (const key of ['startBinding', 'endBinding']) if (record(element[key])) compact[key] = { elementId: element[key].elementId };
    if (Array.isArray(element.boundElements)) {
      compact.boundElements = element.boundElements.filter(record).slice(0, 20).map((bound) => ({ id: bound.id, type: bound.type }));
      if (element.boundElements.length > 20) compact.boundElementsTruncated = true;
    }
    if (text !== undefined) { compact.text = text.slice(0, 400); if (text.length > 400) compact.textTruncated = true; }
    return compact;
  }) };
}

export function contextText(log: MeetingLog, config: AgentConfig, owner: string, history: AgentLine[], snapshot?: MeetingSnapshot): string {
  const visible: MeetingLogEntry[] = [];
  for (let after = 0; ;) {
    const page = log.read(after, 500);
    visible.push(...page.entries.filter((entry) => visibleRecord(entry, config, owner)));
    if (!page.hasMore) break;
    after = page.nextCursor;
  }
  const scoped = snapshot ? scopedSnapshot(snapshot, config, owner) : undefined;
  // Keep inventories separate from recent records: a shared file must remain discoverable
  // after its original announcement falls out of the bounded context window.
  const context = {
    ...(scoped ? { room: { code: scoped.roomCode, captions: scoped.captions }, you: scoped.you,
      participants: scoped.participants.map(({ peerId, name, isHost }) => ({ peerId, name, isHost })).slice(0, 30),
      files: scoped.files.map(({ id, name, mime, size, sharedBy, status }) => ({ id, name, mime, size, sharedBy, status })).slice(-20),
      live: scoped.live.map((line) => ({ ...line, text: line.text.slice(-500) })).slice(-5), screenShare: scoped.presentation,
    } : {}),
    meeting: visible.slice(-200), conversation: history.slice(-100), omitted: Math.max(0, visible.length - 200) + Math.max(0, history.length - 100),
    coverage: { localOnly: true, availableRecords: visible.length, includedRecords: 0, omittedRecords: 0,
      firstAvailableCursor: visible[0]?.seq ?? null, includedFromCursor: null as number | null, throughCursor: log.head,
      availableFiles: scoped?.files.length ?? 0, omittedFiles: 0, availableParticipants: scoped?.participants.length ?? 0, omittedParticipants: 0,
      retrieval: 'Use read_meeting after=0 with pages of up to 500 full records; follow nextCursor until hasMore=false for all available earlier records. read_meeting fileOffset pages list every available attachment; read_shared_file retrieves content. Author replay may be incomplete; this browser does not guarantee the whole meeting history.' },
  };
  const summarize = () => {
    Object.assign(context.coverage, { includedRecords: context.meeting.length, omittedRecords: visible.length - context.meeting.length,
      includedFromCursor: context.meeting[0]?.seq ?? null, omittedFiles: (scoped?.files.length ?? 0) - (context.files?.length ?? 0),
      omittedParticipants: (scoped?.participants.length ?? 0) - (context.participants?.length ?? 0) });
    return JSON.stringify(context);
  };
  let json = summarize();
  while (utf8Bytes(json) > CONTEXT_BYTES) {
    if (context.meeting.length > 1 || context.conversation.length > 1) {
      if (context.meeting.length >= context.conversation.length) context.meeting.shift(); else context.conversation.shift();
      context.omitted++;
    } else if ((context.live?.length ?? 0) > 1) context.live!.shift();
    else if ((context.files?.length ?? 0) > 3) context.files!.shift();
    else if ((context.participants?.length ?? 0) > 8) context.participants!.pop();
    else if (context.meeting.length || context.conversation.length) {
      if (context.meeting.length >= context.conversation.length) context.meeting.shift(); else context.conversation.shift();
      context.omitted++;
    } else if (context.live?.length) context.live.shift();
    else if (context.files?.length) context.files.shift();
    else if (context.participants?.length) context.participants.pop();
    else break;
    json = summarize();
  }
  return json;
}
