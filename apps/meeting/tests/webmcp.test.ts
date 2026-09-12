import { describe, expect, it } from 'vitest';
import type { SharedFile } from '../src/file-share';
import type { CaptureOptions } from '../src/screen-capture';
import { MeetingLog } from '../src/meeting-log';
import {
  createMeetingTools,
  findModelContext,
  MEETING_TOOL_NAMES,
  registerMeetingTools,
  type MeetingSnapshot,
  type MeetingToolsContext,
  type ToolDefinition,
  type ToolResult,
} from '../src/webmcp';

const alice = { peerId: 'peer_alice_0001', name: 'Alice' };
const bob = { peerId: 'peer_bob_000001', name: 'Bob' };

function fixture(): {
  context: MeetingToolsContext;
  log: MeetingLog;
  posted: Array<{ text: string; agent: string | null }>;
  captures: CaptureOptions[];
  sharing: { current: boolean };
} {
  const log = new MeetingLog();
  const posted: Array<{ text: string; agent: string | null }> = [];
  const captures: CaptureOptions[] = [];
  const sharing = { current: true };
  const notes: SharedFile = {
    id: 'file-notes', name: 'notes.txt', size: 11, mime: 'text/plain', at: 'a', owner: bob.peerId, own: false, status: 'available', received: 0, blob: null, error: null,
  };
  const photo: SharedFile = {
    id: 'file-photo', name: 'photo.png', size: 4, mime: 'image/png', at: 'b', owner: bob.peerId, own: false, status: 'available', received: 0, blob: null, error: null,
  };
  const snapshot: MeetingSnapshot = {
    roomCode: 'ABC234',
    you: alice,
    participants: [
      { ...alice, you: true, isHost: true, micOn: true, cameraOn: false, sharingScreen: false },
      { ...bob, you: false, isHost: false, micOn: null, cameraOn: null, sharingScreen: true },
    ],
    captions: 'transcribing',
    presentation: { ...bob, you: false },
    live: [{ ...bob, text: 'so what I was' }],
    files: [notes, photo].map((file) => ({ id: file.id, name: file.name, size: file.size, mime: file.mime, at: file.at, sharedBy: bob, status: file.status })),
  };
  const context: MeetingToolsContext = {
    snapshot: () => snapshot,
    log: () => log,
    download: async (fileId) => {
      if (fileId === notes.id) return { file: notes, blob: new Blob(['hello world'], { type: 'text/plain' }) };
      if (fileId === photo.id) return { file: photo, blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }) };
      throw new Error('That file is not part of this meeting.');
    },
    captureScreen: async (options) => {
      captures.push(options);
      if (!sharing.current) return null;
      return {
        presenter: { ...bob, you: false },
        blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: options.format === 'png' ? 'image/png' : 'image/jpeg' }),
        width: Math.min(options.maxWidth, 1920),
        height: 1080,
        sourceWidth: 1920,
        sourceHeight: 1080,
      };
    },
    sendAgentMessage: (text, agent) => {
      posted.push({ text, agent });
      return { id: `m${posted.length}`, at: '2026-09-12T00:00:00.000Z' };
    },
  };
  return { context, log, posted, captures, sharing };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

async function payload(result: Promise<ToolResult>): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const resolved = await result;
  const first = resolved.content[0];
  return { body: JSON.parse(first?.type === 'text' ? first.text : '{}') as Record<string, unknown>, isError: resolved.isError === true };
}

describe('WebMCP meeting tools', () => {
  it('exposes exactly four tools with object input schemas', () => {
    const tools = createMeetingTools(fixture().context);
    expect(tools.map((item) => item.name)).toEqual([MEETING_TOOL_NAMES.read, MEETING_TOOL_NAMES.download, MEETING_TOOL_NAMES.capture, MEETING_TOOL_NAMES.send]);
    for (const item of tools) {
      expect(item.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(item.description.length).toBeGreaterThan(40);
    }
  });

  it('reads the meeting record incrementally with a cursor', async () => {
    const { context, log } = fixture();
    log.append({ kind: 'presence', at: 'a', participant: alice, event: 'joined' });
    log.append({ kind: 'transcript', at: 'b', speaker: bob, text: 'Let us start.' });
    log.append({ kind: 'file', at: 'c', sender: bob, file: { id: 'file-notes', name: 'notes.txt', size: 11, mime: 'text/plain' } });
    const read = tool(createMeetingTools(context), MEETING_TOOL_NAMES.read);

    const first = await payload(read.execute({ limit: 2 }));
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({
      room: { code: 'ABC234', captions: 'transcribing' },
      you: alice,
      nextCursor: 2,
      hasMore: true,
      live: [{ ...bob, text: 'so what I was' }],
      screenShare: { presenter: { ...bob, you: false } },
    });
    expect((first.body['records'] as unknown[]).map((entry) => (entry as { seq: number }).seq)).toEqual([1, 2]);
    expect((first.body['files'] as unknown[]).map((entry) => (entry as { id: string }).id)).toEqual(['file-notes', 'file-photo']);

    const second = await payload(read.execute({ after: 2 }));
    expect(second.body).toMatchObject({ nextCursor: 3, hasMore: false });
    expect(second.body['records']).toEqual([
      { seq: 3, kind: 'file', at: 'c', sender: bob, file: { id: 'file-notes', name: 'notes.txt', size: 11, mime: 'text/plain' } },
    ]);
    expect((await payload(read.execute({ after: -1 }))).isError).toBe(true);
    expect((await payload(read.execute({ limit: 0 }))).isError).toBe(true);
  });

  it('downloads text as UTF-8 and binary as base64, in slices', async () => {
    const download = tool(createMeetingTools(fixture().context), MEETING_TOOL_NAMES.download);
    const text = await payload(download.execute({ fileId: 'file-notes' }));
    expect(text.body).toMatchObject({ fileId: 'file-notes', name: 'notes.txt', size: 11, offset: 0, bytes: 11, nextOffset: 11, eof: true, encoding: 'utf-8', data: 'hello world' });

    const slice = await payload(download.execute({ fileId: 'file-notes', offset: 6, length: 3 }));
    expect(slice.body).toMatchObject({ offset: 6, bytes: 3, nextOffset: 9, eof: false, data: 'wor' });

    const binary = await payload(download.execute({ fileId: 'file-photo' }));
    expect(binary.body).toMatchObject({ encoding: 'base64', data: btoa('\x89PNG'), eof: true });

    expect((await payload(download.execute({}))).isError).toBe(true);
    expect((await payload(download.execute({ fileId: 'file-notes', offset: 12 }))).isError).toBe(true);
    const missing = await payload(download.execute({ fileId: 'nope' }));
    expect(missing.isError).toBe(true);
    expect(missing.body['error']).toContain('not part of this meeting');
  });

  it('captures the shared screen as an image with presenter metadata', async () => {
    const { context, captures, sharing } = fixture();
    const capture = tool(createMeetingTools(context), MEETING_TOOL_NAMES.capture);
    const result = await capture.execute({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      sharing: true, presenter: { ...bob, you: false }, width: 1280, height: 1080, sourceWidth: 1920, mimeType: 'image/jpeg', bytes: 4,
    });
    expect(result.content[1]).toEqual({ type: 'image', data: btoa('\xff\xd8\xff\xd9'), mimeType: 'image/jpeg' });
    expect(captures[0]).toEqual({ maxWidth: 1280, format: 'jpeg', quality: 0.8 });

    const png = await capture.execute({ maxWidth: 640, format: 'png', quality: 1 });
    expect(png.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(captures[1]).toEqual({ maxWidth: 640, format: 'png', quality: 1 });

    sharing.current = false;
    const idle = await payload(capture.execute({}));
    expect(idle.isError).toBe(false);
    expect(idle.body).toMatchObject({ sharing: false });

    expect((await payload(capture.execute({ maxWidth: 100 }))).isError).toBe(true);
    expect((await payload(capture.execute({ format: 'gif' }))).isError).toBe(true);
    expect((await payload(capture.execute({ quality: 0 }))).isError).toBe(true);
  });

  it('posts chat messages as the participant agent, with an optional agent name', async () => {
    const { context, posted } = fixture();
    const send = tool(createMeetingTools(context), MEETING_TOOL_NAMES.send);
    const plain = await payload(send.execute({ text: '  The  answer is 42. ' }));
    expect(plain.body).toEqual({ ok: true, id: 'm1', at: '2026-09-12T00:00:00.000Z', shownAs: "Alice's agent" });
    const named = await payload(send.execute({ text: 'Sources attached.', agent: 'ChatGPT' }));
    expect(named.body).toMatchObject({ shownAs: "Alice's agent · ChatGPT" });
    expect(posted).toEqual([{ text: 'The answer is 42.', agent: null }, { text: 'Sources attached.', agent: 'ChatGPT' }]);
    expect((await payload(send.execute({ text: '   ' }))).isError).toBe(true);
    expect((await payload(send.execute({ text: 'x'.repeat(2_001) }))).isError).toBe(true);
    expect((await payload(send.execute({ text: 'hi', agent: 3 }))).isError).toBe(true);
  });

  it('registers with the browser model context and removes the tools again', () => {
    const registry = new Map<string, ToolDefinition>();
    const unregistered: string[] = [];
    const modelContext = {
      registerTool(definition: ToolDefinition, options?: { signal?: AbortSignal }) {
        registry.set(definition.name, definition);
        options?.signal?.addEventListener('abort', () => registry.delete(definition.name), { once: true });
      },
      unregisterTool(name: string) {
        unregistered.push(name);
      },
    };
    const unregister = registerMeetingTools(fixture().context, modelContext);
    expect(registry.size).toBe(4);
    unregister?.();
    expect(registry.size).toBe(0);
    expect(unregistered).toEqual([MEETING_TOOL_NAMES.read, MEETING_TOOL_NAMES.download, MEETING_TOOL_NAMES.capture, MEETING_TOOL_NAMES.send]);
    expect(registerMeetingTools(fixture().context, null)).toBeNull();
  });

  it('falls back to provideContext and finds the context on navigator or document', () => {
    const provided: ToolDefinition[][] = [];
    const modelContext = { provideContext: (context: { tools: ToolDefinition[] }) => provided.push(context.tools) };
    const unregister = registerMeetingTools(fixture().context, modelContext);
    expect(provided[0]).toHaveLength(4);
    unregister?.();
    expect(provided[1]).toEqual([]);
    expect(findModelContext({ navigator: { modelContext } })).toBe(modelContext);
    expect(findModelContext({ navigator: {}, document: { modelContext } })).toBe(modelContext);
    expect(findModelContext({})).toBeNull();
  });
});
