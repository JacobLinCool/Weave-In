import { MeetingLog, type MeetingLogEntry } from '../meeting-log';
import { createMeetingTools, type MeetingToolsContext, type ToolDefinition } from '../webmcp';
import { record, type AgentConfig, type AgentLine } from './contracts';

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
const FILE_PAGE_BYTES = 1024;

export function visibleRecord(entry: MeetingLogEntry, config: AgentConfig, owner: string): boolean {
  if (entry.kind === 'file') return config.files;
  if (entry.kind === 'presence') return config.source !== 'none';
  if (config.source === 'none') return false;
  if (entry.kind === 'chat' && !config.chat) return false;
  const peerId = entry.kind === 'transcript' ? entry.speaker.peerId : entry.sender.peerId;
  return config.source === 'all' || peerId === owner;
}

export function scopedTools(base: MeetingToolsContext, config: AgentConfig, owner: string, active: () => boolean, canPublish: () => boolean): ToolDefinition[] {
  const allowedPeer = (peer: string) => config.source === 'all' || (config.source === 'owner' && peer === owner);
  const context: MeetingToolsContext = {
    ...base,
    snapshot: () => {
      const snapshot = base.snapshot();
      return { ...snapshot, live: snapshot.live.filter((line) => allowedPeer(line.peerId)), files: config.files ? snapshot.files : [], presentation: config.screen ? snapshot.presentation : null };
    },
    log: () => base.log().filtered((entry) => visibleRecord(entry, config, owner)),
    sendAgentMessage: (text) => {
      if (!active() || !canPublish()) throw new Error('Public posting is not authorized for this turn.');
      return base.sendAgentMessage(text, config.name);
    },
  };
  return createMeetingTools(context).filter((tool) =>
    (tool.name !== 'capture_screen_share' || config.screen) && (tool.name !== 'download_file' || config.files),
  ).map((tool) => ({ ...tool,
    ...(tool.name === 'download_file' ? { description: `${tool.description} Agent reads are limited to 1024 bytes per call; continue with nextOffset until eof.`,
      inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), length: { type: 'integer', minimum: 1, maximum: FILE_PAGE_BYTES, default: FILE_PAGE_BYTES } } } } : {}),
    ...(tool.name === 'read_meeting' ? { description: `${tool.description} Agent pages contain at most 5 records; use nextCursor to continue.`,
      inputSchema: { ...tool.inputSchema, properties: { ...(tool.inputSchema.properties as Record<string, unknown>), limit: { type: 'integer', minimum: 1, maximum: 5, default: 5 } } } } : {}),
    execute: async (input) => {
    if (!active() || (tool.name === 'send_chat_message' && !canPublish())) return { isError: true, content: [{ type: 'text', text: 'This action is not authorized for the current agent turn.' }] };
    if (tool.name === 'download_file') {
      const args = record(input) ? input : {};
      let length = typeof args.length === 'number' && Number.isInteger(args.length) ? Math.min(args.length, FILE_PAGE_BYTES) : args.length ?? FILE_PAGE_BYTES;
      const offset = args.offset ?? 0;
      // Keep successive UTF-8 text pages on character boundaries, without changing byte offsets.
      if (typeof args.fileId === 'string' && typeof length === 'number' && Number.isInteger(length) && length > 0 && typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) {
        let blob: Blob;
        try { ({ blob } = await base.download(args.fileId.trim())); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'The file could not be fetched.' }] }; }
        if (!active()) return { isError: true, content: [{ type: 'text', text: 'This agent turn has ended.' }] };
        if (offset + length < blob.size) {
          const start = Math.max(offset, offset + length - 4);
          const edge = new Uint8Array(await blob.slice(start, offset + length + 1).arrayBuffer());
          let boundary = edge.length - 1;
          while (boundary > 0 && (edge[boundary]! & 0xc0) === 0x80) boundary--;
          const aligned = start + boundary - offset;
          if (aligned === 0) return { isError: true, content: [{ type: 'text', text: 'This file page is too short for a complete UTF-8 character. Request at least 4 bytes.' }] };
          if (aligned > 0) length = aligned;
        }
      }
      return tool.execute({ ...args, length });
    }
    if (tool.name === 'read_meeting') {
      const args = record(input) ? input : {};
      return tool.execute({ ...args, limit: typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(args.limit, 5) : args.limit ?? 5 });
    }
    return tool.execute(input);
  } }));
}

export function contextText(log: MeetingLog, config: AgentConfig, owner: string, history: AgentLine[]): string {
  const visible: MeetingLogEntry[] = [];
  for (let after = 0; ;) {
    const page = log.read(after, 500);
    visible.push(...page.entries.filter((entry) => visibleRecord(entry, config, owner)));
    if (!page.hasMore) break;
    after = page.nextCursor;
  }
  // ponytail: bounded recent context; paginated read_meeting retrieves older local records when needed.
  const context = { meeting: visible.slice(-200), conversation: history.slice(-100), omitted: Math.max(0, visible.length - 200) + Math.max(0, history.length - 100) };
  let json = JSON.stringify(context);
  while (utf8Bytes(json) > 6_000 && (context.meeting.length || context.conversation.length)) {
    if (context.meeting.length >= context.conversation.length) context.meeting.shift(); else context.conversation.shift();
    context.omitted++;
    json = JSON.stringify(context);
  }
  return json;
}
