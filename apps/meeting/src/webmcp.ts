import type { TranscriptionStatus } from '@weave-in/transcribe';
import type { SharedFile, SharedFileStatus } from './file-share';
import { DEFAULT_LOG_PAGE, MAX_LOG_PAGE, type LogParticipant, type MeetingLog } from './meeting-log';
import { MAX_AGENT_LABEL_CHARACTERS, MAX_CHAT_CHARACTERS } from './protocol';
import type { CaptureOptions, CapturedFrame } from './screen-capture';
import { WHITEBOARD_EDIT_SCHEMA, type WhiteboardEditResult } from './whiteboard-webmcp';

/**
 * WebMCP exposes meeting, screen capture and shared whiteboard tools to an agent in the
 * participant's browser. Results come from this browser's own copy of the room.
 */

export const MEETING_TOOL_NAMES = Object.freeze({
  read: 'read_meeting',
  download: 'download_file',
  capture: 'capture_screen_share',
  send: 'send_chat_message',
  captureWhiteboard: 'capture_whiteboard',
  editWhiteboard: 'edit_whiteboard',
});

export const MIN_CAPTURE_WIDTH = 320;
export const MAX_CAPTURE_WIDTH = 1920;
export const DEFAULT_CAPTURE_WIDTH = 1280;
export const DEFAULT_CAPTURE_QUALITY = 0.8;

/** Largest slice of a file one `download_file` call returns, before encoding. */
export const MAX_FILE_SLICE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FILE_SLICE_BYTES = 1024 * 1024;

export interface MeetingParticipantView extends LogParticipant {
  you: boolean;
  isHost: boolean;
  micOn: boolean | null;
  cameraOn: boolean | null;
  sharingScreen: boolean;
}

export interface MeetingSnapshot {
  roomCode: string;
  you: LogParticipant;
  participants: MeetingParticipantView[];
  captions: TranscriptionStatus;
  /** Who is presenting a screen right now, if anyone. */
  presentation: (LogParticipant & { you: boolean }) | null;
  live: Array<LogParticipant & { text: string }>;
  files: Array<{ id: string; name: string; size: number; mime: string; at: string; sharedBy: LogParticipant; status: SharedFileStatus }>;
}

export interface ScreenCapture extends CapturedFrame {
  presenter: LogParticipant & { you: boolean };
}

export interface MeetingToolsContext {
  snapshot(): MeetingSnapshot;
  log(): MeetingLog;
  download(fileId: string): Promise<{ file: SharedFile; blob: Blob }>;
  /** Resolves null when nobody is sharing a screen. */
  captureScreen(options: CaptureOptions): Promise<ScreenCapture | null>;
  /** Captures the open whiteboard viewport; rejects when the board is closed. */
  captureWhiteboard(options: CaptureOptions): Promise<CapturedFrame>;
  /** Mutates the shared room store; implementations should use the validated editWhiteboard helper. */
  editWhiteboard(input: unknown): WhiteboardEditResult | Promise<WhiteboardEditResult>;
  sendAgentMessage(text: string, agent: string | null): { id: string; at: string };
}

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolResult {
  content: Array<ToolTextContent | ToolImageContent>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  execute(input: unknown, context?: { signal?: AbortSignal }): Promise<ToolResult>;
}

/** The subset of `navigator.modelContext` this page relies on. */
export interface ModelContextLike {
  registerTool?(tool: ToolDefinition, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): unknown;
  provideContext?(context: { tools: ToolDefinition[] }): unknown;
  clearContext?(): unknown;
}

export function createMeetingTools(context: MeetingToolsContext): ToolDefinition[] {
  return [
    {
      name: MEETING_TOOL_NAMES.read,
      description:
        'Read the Weave In meeting open in this tab: room code, participants, and the meeting record in order — finalized captions ' +
        'with their speaker, chat messages, files that participants shared (with the file ids download_file needs), and joins and ' +
        'leaves. Records are numbered in arrival order; pass the previous nextCursor as `after` to receive only what happened ' +
        'since. Records from before this participant joined are replayed by their authors and carry `replayed: true` with their ' +
        'original `at`, so sort by `at` for a timeline. Captions that are still being spoken are returned separately in `live`.',
      inputSchema: {
        type: 'object',
        properties: {
          after: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Return records with a sequence number greater than this. Omit or pass 0 to start from the beginning.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LOG_PAGE,
            default: DEFAULT_LOG_PAGE,
            description: 'Maximum number of records to return.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (input) => {
        const args = asRecord(input);
        const after = optionalInteger(args['after'], 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = optionalInteger(args['limit'], DEFAULT_LOG_PAGE, 1, MAX_LOG_PAGE);
        if (after === null) return failure('`after` must be a non-negative integer.');
        if (limit === null) return failure(`\`limit\` must be an integer between 1 and ${MAX_LOG_PAGE}.`);
        const snapshot = context.snapshot();
        const page = context.log().read(after, limit);
        return success({
          room: { code: snapshot.roomCode, captions: snapshot.captions },
          you: snapshot.you,
          participants: snapshot.participants,
          screenShare: snapshot.presentation ? { presenter: snapshot.presentation } : null,
          records: page.entries,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          live: snapshot.live,
          files: snapshot.files,
        });
      },
    },
    {
      name: MEETING_TOOL_NAMES.download,
      description:
        'Fetch a file shared in this meeting, by the file id from read_meeting, straight from the participant who shared it, and ' +
        'return its contents. Text is returned as UTF-8, anything else as base64. Large files are read in slices: pass `offset` ' +
        'and `length`, and continue from nextOffset until eof is true.',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Id of the file, from a file record or the files list of read_meeting.' },
          offset: { type: 'integer', minimum: 0, default: 0, description: 'Byte offset to start reading from.' },
          length: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_FILE_SLICE_BYTES,
            default: DEFAULT_FILE_SLICE_BYTES,
            description: 'Maximum number of bytes to return in this call.',
          },
        },
        required: ['fileId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: async (input) => {
        const args = asRecord(input);
        const fileId = typeof args['fileId'] === 'string' ? args['fileId'].trim() : '';
        const offset = optionalInteger(args['offset'], 0, 0, Number.MAX_SAFE_INTEGER);
        const length = optionalInteger(args['length'], DEFAULT_FILE_SLICE_BYTES, 1, MAX_FILE_SLICE_BYTES);
        if (!fileId) return failure('`fileId` is required.');
        if (offset === null) return failure('`offset` must be a non-negative integer.');
        if (length === null) return failure(`\`length\` must be an integer between 1 and ${MAX_FILE_SLICE_BYTES}.`);
        let file: SharedFile;
        let blob: Blob;
        try {
          ({ file, blob } = await context.download(fileId));
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'The file could not be fetched.');
        }
        if (offset > blob.size) return failure(`\`offset\` is past the end of the file (${blob.size} bytes).`);
        const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
        const text = decodeText(bytes, file.mime);
        return success({
          fileId: file.id,
          name: file.name,
          mime: file.mime,
          size: blob.size,
          offset,
          bytes: bytes.byteLength,
          nextOffset: offset + bytes.byteLength,
          eof: offset + bytes.byteLength >= blob.size,
          encoding: text === null ? 'base64' : 'utf-8',
          data: text ?? base64(bytes),
        });
      },
    },
    {
      name: MEETING_TOOL_NAMES.capture,
      description:
        'Capture a still image of the screen currently being shared in this meeting, whether by the participant using this ' +
        'browser or by someone else, exactly as the room sees it. Use it to read a slide, a document, code, or a whiteboard ' +
        'that is being presented. Returns the image together with who is presenting; when nobody is sharing a screen the ' +
        'result says so instead of an image.',
      inputSchema: {
        type: 'object',
        properties: {
          maxWidth: {
            type: 'integer',
            minimum: MIN_CAPTURE_WIDTH,
            maximum: MAX_CAPTURE_WIDTH,
            default: DEFAULT_CAPTURE_WIDTH,
            description: 'Scale the image down so it is at most this many pixels wide; the aspect ratio is kept.',
          },
          format: { type: 'string', enum: ['jpeg', 'png'], default: 'jpeg', description: 'jpeg is smaller; png keeps small text crisp.' },
          quality: {
            type: 'number',
            minimum: 0.1,
            maximum: 1,
            default: DEFAULT_CAPTURE_QUALITY,
            description: 'JPEG quality from 0.1 to 1.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: async (input) => {
        const args = asRecord(input);
        const maxWidth = optionalInteger(args['maxWidth'], DEFAULT_CAPTURE_WIDTH, MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH);
        const format = args['format'] === undefined || args['format'] === null ? 'jpeg' : args['format'];
        const quality = optionalNumber(args['quality'], DEFAULT_CAPTURE_QUALITY, 0.1, 1);
        if (maxWidth === null) return failure(`\`maxWidth\` must be an integer between ${MIN_CAPTURE_WIDTH} and ${MAX_CAPTURE_WIDTH}.`);
        if (format !== 'jpeg' && format !== 'png') return failure('`format` must be "jpeg" or "png".');
        if (quality === null) return failure('`quality` must be a number between 0.1 and 1.');
        let capture: ScreenCapture | null;
        try {
          capture = await context.captureScreen({ maxWidth, format, quality });
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'The shared screen could not be captured.');
        }
        if (!capture) return success({ sharing: false, message: 'Nobody is sharing a screen right now.' });
        const bytes = new Uint8Array(await capture.blob.arrayBuffer());
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sharing: true,
                presenter: capture.presenter,
                capturedAt: new Date().toISOString(),
                width: capture.width,
                height: capture.height,
                sourceWidth: capture.sourceWidth,
                sourceHeight: capture.sourceHeight,
                mimeType: capture.blob.type,
                bytes: bytes.byteLength,
              }),
            },
            { type: 'image', data: base64(bytes), mimeType: capture.blob.type },
          ],
        };
      },
    },
    {
      name: MEETING_TOOL_NAMES.captureWhiteboard,
      description:
        'Capture an image of the current shared whiteboard viewport, including shapes, their text, pen strokes and connectors, ' +
        'without the toolbars. Open the whiteboard using the meeting controls first. Pan or zoom the canvas to frame the area ' +
        'you want to inspect. This reads the board currently rendered in this browser and does not modify the shared board. ' +
        'Use after edit_whiteboard to visually verify the resulting layout and text; a successful edit alone does not verify appearance.',
      inputSchema: {
        type: 'object',
        properties: {
          maxWidth: { type: 'integer', minimum: MIN_CAPTURE_WIDTH, maximum: MAX_CAPTURE_WIDTH, default: DEFAULT_CAPTURE_WIDTH },
          format: { type: 'string', enum: ['jpeg', 'png'], default: 'png' },
          quality: { type: 'number', minimum: 0.1, maximum: 1, default: DEFAULT_CAPTURE_QUALITY },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('Expected an object.');
        const args = input as Record<string, unknown>;
        if (Object.keys(args).some(key => !['maxWidth', 'format', 'quality'].includes(key))) return failure('Unknown capture option.');
        const maxWidth = optionalInteger(args['maxWidth'], DEFAULT_CAPTURE_WIDTH, MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH);
        const format = args['format'] === undefined ? 'png' : args['format'];
        const quality = optionalNumber(args['quality'], DEFAULT_CAPTURE_QUALITY, 0.1, 1);
        if (maxWidth === null || args['maxWidth'] === null) return failure(`\`maxWidth\` must be an integer between ${MIN_CAPTURE_WIDTH} and ${MAX_CAPTURE_WIDTH}.`);
        if (format !== 'jpeg' && format !== 'png') return failure('`format` must be "jpeg" or "png".');
        if (quality === null || args['quality'] === null) return failure('`quality` must be a number between 0.1 and 1.');
        try {
          const capture = await context.captureWhiteboard({ maxWidth, format, quality });
          const bytes = new Uint8Array(await capture.blob.arrayBuffer());
          return { content: [
            { type: 'text', text: JSON.stringify({ shared: true, view: 'viewport', capturedAt: new Date().toISOString(), width: capture.width, height: capture.height, sourceWidth: capture.sourceWidth, sourceHeight: capture.sourceHeight, mimeType: capture.blob.type, bytes: bytes.byteLength }) },
            { type: 'image', data: base64(bytes), mimeType: capture.blob.type },
          ] };
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'The whiteboard could not be captured.');
        }
      },
    },
    {
      name: MEETING_TOOL_NAMES.editWhiteboard,
      description:
        'Read or edit the whiteboard shared by everyone in this meeting. Use action read to obtain object ids and board coordinates; ' +
        'read pages contain up to 100 native Excalidraw records (bound text points to its node through containerId). Use action edit with up to 50 create, update or delete operations, or action undo/redo ' +
        'for the local participant’s most recent undoable edit (including manual edits). Every modification is immediately shared ' +
        'with other participants. Text belongs to its node; update that same node’s text, x/y or width/height to edit, move or resize it. ' +
        'Create note, rectangle, diamond or text nodes, pen strokes with 2–256 relative points, or connectors using from/to node ids. ' +
        'Use action mermaid with a source string starting with flowchart TD or graph LR to import a complete Mermaid flowchart ' +
        'as native editable nodes, bound text and arrows. Optional x/y position its top-left corner; by default it is placed to the right ' +
        'of existing content. Source is limited to 12000 characters and imports to 300 native elements including labels. Other diagram ' +
        'types, initialization directives and image fallbacks are rejected. Existing content is preserved. ' +
        'Use unique create ids to connect nodes in one batch. Text is limited to 500 characters per node. Deleting a node removes ' +
        'its connectors. Undo avoids overwriting another participant’s newer changes. After editing, use capture_whiteboard to inspect the visible result.',
      inputSchema: WHITEBOARD_EDIT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      execute: async (input) => {
        try { return success(await context.editWhiteboard(input)); }
        catch (error) { return failure(error instanceof Error ? error.message : 'The whiteboard operation failed.'); }
      },
    },
    {
      name: MEETING_TOOL_NAMES.send,
      description:
        'Post a message to the meeting chat on behalf of the participant using this browser. Everyone in the room sees it ' +
        "labelled as that participant's agent, distinct from what they type themselves. Use it when the participant asks you " +
        'to share an answer, a summary, or a reference with the room.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_CHAT_CHARACTERS, description: 'The message to post.' },
          agent: {
            type: 'string',
            maxLength: MAX_AGENT_LABEL_CHARACTERS,
            description: 'Name of the assistant posting the message, shown next to it (for example the product name of the agent).',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: async (input) => {
        const args = asRecord(input);
        const text = typeof args['text'] === 'string' ? args['text'].replace(/\s+/gu, ' ').trim() : '';
        if (!text) return failure('`text` must be a non-empty string.');
        if (text.length > MAX_CHAT_CHARACTERS) return failure(`\`text\` must be at most ${MAX_CHAT_CHARACTERS} characters.`);
        const rawAgent = args['agent'];
        if (rawAgent !== undefined && rawAgent !== null && typeof rawAgent !== 'string') return failure('`agent` must be a string.');
        const agent = typeof rawAgent === 'string' ? rawAgent.replace(/\s+/gu, ' ').trim().slice(0, MAX_AGENT_LABEL_CHARACTERS) : '';
        const posted = context.sendAgentMessage(text, agent || null);
        const you = context.snapshot().you;
        return success({ ok: true, id: posted.id, at: posted.at, shownAs: `${you.name}'s agent${agent ? ` · ${agent}` : ''}` });
      },
    },
  ];
}

/** Finds the page's model context, whichever host object the browser exposes it on. */
export function findModelContext(scope: { navigator?: unknown; document?: unknown } = globalThis as typeof globalThis): ModelContextLike | null {
  for (const host of [scope.navigator, scope.document]) {
    const candidate = (host as { modelContext?: unknown } | undefined)?.modelContext;
    if (candidate && typeof candidate === 'object') return candidate as ModelContextLike;
  }
  return null;
}

/**
 * Registers the meeting tools and returns a function that removes them again.
 * Returns null when the browser exposes no model context.
 */
export function registerMeetingTools(
  context: MeetingToolsContext,
  modelContext: ModelContextLike | null = findModelContext(),
): (() => void) | null {
  if (!modelContext) return null;
  const tools = createMeetingTools(context);
  const controller = new AbortController();
  if (typeof modelContext.registerTool === 'function') {
    const registered: string[] = [];
    for (const tool of tools) {
      try {
        const result = modelContext.registerTool(tool, { signal: controller.signal });
        if (isPromiseLike(result)) result.then(undefined, (error: unknown) => console.warn(`[Weave In] WebMCP tool ${tool.name} was rejected.`, error));
        registered.push(tool.name);
      } catch (error) {
        console.warn(`[Weave In] WebMCP tool ${tool.name} could not be registered.`, error);
      }
    }
    return () => {
      controller.abort();
      for (const name of registered) {
        try {
          modelContext.unregisterTool?.(name);
        } catch {
          // The abort signal already removed it.
        }
      }
    };
  }
  if (typeof modelContext.provideContext === 'function') {
    try {
      modelContext.provideContext({ tools });
    } catch (error) {
      console.warn('[Weave In] WebMCP tools could not be provided.', error);
      return null;
    }
    return () => {
      try {
        if (typeof modelContext.clearContext === 'function') modelContext.clearContext();
        else modelContext.provideContext?.({ tools: [] });
      } catch {
        // Nothing left to clear.
      }
    };
  }
  return null;
}

function success(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function optionalNumber(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|x-yaml|yaml|toml|sql|x-sh|x-httpd-php|ld\+json|x-ndjson)$)|[+.](?:json|xml)$/u;

/** Decodes the slice as UTF-8 when the file is text; returns null for binary content. */
function decodeText(bytes: Uint8Array, mime: string): string | null {
  if (TEXT_MIME.test(mime)) return new TextDecoder('utf-8').decode(bytes);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
