import { scopedTools } from '../src/agents/tools';
import { afterEach, expect, it, vi } from 'vitest';
import type { RoomAgent } from '../src/agents/contracts';
import { type MeetingToolsContext } from '../src/webmcp';
import { AgentLive, liveSettings } from '../src/agents/live';

class Channel extends EventTarget {
  readyState = 'open';
  send = vi.fn();
  close() { this.readyState = 'closed'; }
  event(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
class Connection extends EventTarget {
  channel = new Channel();
  createDataChannel() { return this.channel; }
  close() {}
}
afterEach(() => vi.unstubAllGlobals());
it('processes delayed transcription and session.closed while a tool is still pending', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const execute = vi.fn(async () => { await pending; return { content: [{ type: 'text' as const, text: 'file' }] }; });
  const transcript = vi.fn(); const closed = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript, prepared: vi.fn(), error: vi.fn(), closed }, [
    { name: 'download_file', description: '', inputSchema: {}, annotations: { readOnlyHint: true }, execute },
  ], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const response = (event: unknown) => channel.event({ type: 'response.event', delegation_id: 'd1', event });
  response({ type: 'response.created' });
  response({ type: 'response.output_item.done', item: { type: 'function_call', name: 'download_file', call_id: 'call', arguments: '{}' } });
  response({ type: 'response.completed' });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  live.close();
  channel.event({ type: 'session.output_transcript.delta', delta: 'final', start_ms: 1, end_ms: 2 });
  channel.event({ type: 'session.closed' });
  expect(transcript).toHaveBeenCalledWith('assistant', 'final', 1, 2);
  expect(closed).toHaveBeenCalledOnce();
  release();
  await pending;
  expect(channel.send.mock.calls.filter(([raw]) => String(raw).includes('function_call_output'))).toHaveLength(0);
});

it('hands typed backend results to speech and waits for audio after the result, not its prelude', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error: vi.fn(), closed: vi.fn() }, [], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  live.request('{}', 'Help me');
  const context = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).find((event) => event.type === 'session.thinking.append');
  expect(context).toMatchObject({ delegation_id: null, content: 'The user typed: \"Help me\". The backend is handling this request.' });
  expect(live.canFinish(Date.now())).toBe(false);
  const response = (event: unknown) => channel.event({ type: 'response.event', event });
  response({ type: 'response.created' });
  const text = '會議建議🙂'.repeat(100);
  response({ type: 'response.output_text.delta', delta: text });
  response({ type: 'response.completed' });
  await vi.waitFor(() => expect(live.canFinish(Date.now())).toBe(true));
  const appends = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter((event) => event.type === 'session.commentary.append');
  expect(appends.map((event) => event.content).join('')).toBe(text);
  expect(appends.every((event) => event.delegation_id === null && new TextEncoder().encode(event.content).length <= 450)).toBe(true);
  expect(live.canFinish(1)).toBe(false);
  live.close(); channel.event({ type: 'session.closed' });
});


it('does not finish on a voice prelude while awaiting the final answer audio', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error: vi.fn(), closed: vi.fn() }, [], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const preludeAt = Date.now() - 3000;
  channel.event({ type: 'response.event', event: { type: 'response.created' } });
  await vi.waitFor(() => expect(live.canFinish(preludeAt)).toBe(false));
  channel.event({ type: 'response.event', event: { type: 'response.completed' } });
  await vi.waitFor(() => expect(live.canFinish(Date.now())).toBe(true));
  expect(live.canFinish(preludeAt)).toBe(false);
  live.close(); channel.event({ type: 'session.closed' });
});


it('keeps an input audio track for typed requests and after microphone input ends', async () => {
  const replaceTrack = vi.fn(async () => undefined);
  const addTrack = vi.fn((_track: MediaStreamTrack, _stream: MediaStream) => ({ replaceTrack }));
  class StartedConnection extends Connection {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    addTrack = addTrack;
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.channel.event({ type: 'session.started' }); }
  }
  vi.stubGlobal('RTCPeerConnection', StartedConnection);
  vi.stubGlobal('MediaStream', class { constructor(readonly tracks: unknown[]) {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transport: { sdp: 'answer' } }))));
  const agent = { id: 'a', epoch: 1, request: 0, config: { language: 'auto', instructions: 'Help' } } as RoomAgent;
  const track = {} as MediaStreamTrack; const stop = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error: vi.fn(), closed: vi.fn() }, [], false, () => true);
  await live.start({ room: 'ABC123', token: 'token', agent, microphone: null, silence: { track, stop } });
  expect(addTrack.mock.calls[0]?.[0]).toBe(track);
  await live.muteMicrophone();
  expect(replaceTrack).toHaveBeenCalledWith(track);
  live.close(); (live.channel as unknown as Channel).event({ type: 'session.closed' });
  expect(stop).toHaveBeenCalledOnce();
});


it('keeps meeting and whiteboard tool schemas compatible with Live initialization', () => {
  const tools = scopedTools({} as MeetingToolsContext, { kind: 'personal', source: 'all', chat: true, screen: true, files: true } as RoomAgent['config'], 'owner', () => true, () => true);
  const agent = { config: { language: 'auto', instructions: 'Help' } } as RoomAgent;
  const settings = liveSettings(agent, tools, false);
  const serialized = JSON.stringify(settings);
  JSON.parse(serialized, (_key, value: unknown) => {
    if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true);
    return value;
  });
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['read_meeting', 'search_meeting', 'read_shared_file', 'edit_whiteboard', 'capture_whiteboard', 'send_chat_message']));
});

it('sends only new background records and reserves input bytes for foreground work', () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const error = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn() }, [], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const first = { seq: 1, text: 'Already seeded' };
  live.request(JSON.stringify({ meeting: [first], conversation: [] }), 'Question');
  live.context(JSON.stringify({ meeting: [first], conversation: [] }));
  live.context(JSON.stringify({ meeting: [first, { seq: 2, text: 'New record' }], conversation: [] }));
  live.context(JSON.stringify({ meeting: [{ seq: 3, text: '中'.repeat(6000) }], conversation: [] }));
  const items = () => channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter((event) => event.type === 'response.item.create');
  expect(items()).toHaveLength(3);
  expect(items()[1].item.content[0].text).toContain('New record');
  expect(items()[1].item.content[0].text).not.toContain('Already seeded');
  expect(live.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'file', output: '中'.repeat(5000) } })).toBe(true);
  expect(error).not.toHaveBeenCalled();
  expect(items()).toHaveLength(4);
  live.close(); channel.event({ type: 'session.closed' });
});

it('reports a saturated background stream once and keeps foreground tool work available', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const error = vi.fn(), contextPaused = vi.fn();
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ current: 'Latest meeting state', details: 'x'.repeat(7000) }) }] }));
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn(), contextPaused }, [
    { name: 'read_meeting', description: '', inputSchema: {}, annotations: {}, execute },
  ], false, () => true);
  const channel = live.channel as unknown as Channel;
  // Startup retries must not mark the context stale before the channel is ready.
  live.context('{"live":[{"text":"before startup"}]}');
  expect(contextPaused).not.toHaveBeenCalled();
  channel.event({ type: 'session.started' });
  live.context('{"meeting":[],"live":[]}');
  for (let i = 0; i < 30; i++) live.context(JSON.stringify({ live: [{ text: `${i}: ${'討論'.repeat(200)}` }], files: [] }));
  const events = () => channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
  const items = () => events().filter((event) => event.type === 'response.item.create');
  expect(contextPaused).toHaveBeenCalledOnce();
  expect(items().filter((event) => event.item.content?.[0]?.text?.includes('Application context status:'))).toHaveLength(1);
  expect(events().filter((event) => event.type === 'response.create')).toHaveLength(0);
  const before = items().length;
  live.context('{"live":[],"files":[]}');
  expect(items()).toHaveLength(before);
  const bytes = () => items().reduce((total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength, 0);
  expect(bytes()).toBeLessThanOrEqual(14_000);

  const response = (event: unknown) => channel.event({ type: 'response.event', event });
  response({ type: 'response.created' });
  response({ type: 'response.output_item.done', item: { type: 'function_call', name: 'read_meeting', call_id: 'current-context', arguments: '{}' } });
  response({ type: 'response.completed' });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(events().filter((event) => event.type === 'response.create')).toHaveLength(1));
  expect(items().find((event) => event.item.call_id === 'current-context')?.item.output).toContain('Latest meeting state');
  expect(bytes()).toBeLessThanOrEqual(30_000);
  expect(error).not.toHaveBeenCalled();
  live.close(); channel.event({ type: 'session.closed' });
});

it('does not terminate foreground work to insert a pause marker when capacity is nearly exhausted', () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const error = vi.fn(), contextPaused = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn(), contextPaused }, [], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  expect(live.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'large', output: 'x'.repeat(29_000) } })).toBe(true);
  const before = channel.send.mock.calls.length;
  live.context('{"live":[{"text":"changed"}]}');
  live.context('{"live":[]}');
  expect(contextPaused).toHaveBeenCalledOnce();
  expect(channel.send.mock.calls).toHaveLength(before);
  expect(error).not.toHaveBeenCalled();
  expect(live.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'final', output: 'Done' } })).toBe(true);
  live.close(); channel.event({ type: 'session.closed' });
});

it('replaces changing inventories including removals and a return to a previously seen state', () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error: vi.fn(), closed: vi.fn() }, [], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const files = [{ id: 'workflow', status: 'available' }];
  live.context(JSON.stringify({ files, live: [{ text: 'draft' }] }));
  live.context(JSON.stringify({ files, live: [{ text: 'draft' }] }));
  live.context(JSON.stringify({ files: [], live: [] }));
  live.context(JSON.stringify({ files, live: [] }));
  const items = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter(event => event.type === 'response.item.create');
  expect(items).toHaveLength(3);
  expect(items[1].item.content[0].text).toContain('"files":[]');
  expect(items[1].item.content[0].text).toContain('"live":[]');
  expect(items[2].item.content[0].text).toContain('"status":"available"');
  live.close(); channel.event({ type: 'session.closed' });
});

it('continues a voice image-to-whiteboard tool sequence and does not repeat a completed action', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const image = vi.fn(async () => ({ content: [
    { type: 'text' as const, text: '{"fileId":"diagram","name":"workflow.png"}' },
    { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' },
  ] }));
  const edit = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"ok":true,"changedIds":["draft","review"]}' }] }));
  const post = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"id":"shared-message"}' }] }));
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error: vi.fn(), closed: vi.fn() }, [
    { name: 'read_shared_file', description: '', inputSchema: {}, annotations: {}, execute: image },
    { name: 'edit_whiteboard', description: '', inputSchema: {}, annotations: {}, execute: edit },
    { name: 'send_chat_message', description: '', inputSchema: {}, annotations: {}, execute: post },
  ], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const response = (event: unknown) => channel.event({ type: 'response.event', delegation_id: 'spoken-request', event });
  const call = async (name: string, callId: string, args: unknown, expected: number) => {
    response({ type: 'response.created', response: { id: `response-${callId}` } });
    response({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } });
    response({ type: 'response.completed', response: { output: [] } });
    await vi.waitFor(() => expect(channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter(event => event.type === 'response.create')).toHaveLength(expected));
  };
  await call('read_shared_file', 'read-image', { fileId: 'diagram' }, 1);
  await call('edit_whiteboard', 'draw', { action: 'mermaid', source: 'flowchart LR\nA[Draft] --> B[Review]' }, 2);
  await call('send_chat_message', 'post', { text: 'I added the workflow.' }, 3);
  response({ type: 'response.completed', response: { output: [] } });
  expect(image).toHaveBeenCalledOnce(); expect(edit).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
  const events = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
  const visionIndex = events.findIndex(event => event.item?.content?.some((part: { type: string }) => part.type === 'input_image'));
  expect(visionIndex).toBeGreaterThan(0);
  expect(events[visionIndex].item.content[0].text).toContain('read-image');
  expect(events[visionIndex + 1].type).toBe('response.create');
  expect(events.filter(event => event.item?.type === 'function_call_output')).toHaveLength(3);
  live.close(); channel.event({ type: 'session.closed' });
});

it('rejects excess input bytes and items locally with a visible terminal error', () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  for (const overflow of ['bytes', 'items']) {
    const error = vi.fn();
    const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn() }, [], false, () => true);
    const channel = live.channel as unknown as Channel;
    channel.event({ type: 'session.started' });
    for (let i = 0; i < 130; i++) live.send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: overflow === 'bytes' ? '中'.repeat(1000) : 'x' }] } });
    const sent = channel.send.mock.calls.map(([raw]) => String(raw));
    expect(sent.length).toBeLessThanOrEqual(120);
    expect(sent.reduce((sum, raw) => sum + new TextEncoder().encode(raw).byteLength, 0)).toBeLessThanOrEqual(30000);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]![0]).toContain('context limit');
  }
});

it('resizes a large screen image to the remaining input budget and releases its bitmap', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const closed = vi.fn(); const sizes: number[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1280, height: 720, close: closed })));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob(callback: (blob: Blob) => void, mime: string) {
    sizes.push(this.width); callback(new Blob([new Uint8Array(Math.floor(this.width * this.width / 100))], { type: mime }));
  } };
  vi.stubGlobal('document', { createElement: () => canvas });
  const error = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn() }, [{ name: 'capture_screen_share', description: '', inputSchema: {}, annotations: {}, execute: async () => ({ content: [{ type: 'text', text: JSON.stringify({ sharing: true, width: 1280, height: 720, bytes: 50000, mimeType: 'image/png', sourceWidth: 1920 }) }, { type: 'image', mimeType: 'image/png', data: btoa('x'.repeat(50_000)) }] }) }], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  live.request('{}', 'Inspect the shared screen');
  live.send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(10000) }] } });
  const response = (event: unknown) => channel.event({ type: 'response.event', delegation_id: 'd', event });
  response({ type: 'response.created' });
  response({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'screen', name: 'capture_screen_share', arguments: '{}' } });
  response({ type: 'response.completed' });
  await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
  const raw = channel.send.mock.calls.map(([value]) => String(value));
  const items = raw.filter((value) => JSON.parse(value).type === 'response.item.create');
  const image = items.map((value) => JSON.parse(value)).find((event) => event.item.content?.some((part: { type: string }) => part.type === 'input_image'));
  expect(image.item.content.find((part: { type: string }) => part.type === 'input_image').image_url).toMatch(/^data:image\/jpeg;base64,/u);
  expect(image.item.content[0].text).toContain('screen');
  const result = items.map((value) => JSON.parse(value)).find((event) => event.item.type === 'function_call_output');
  expect(JSON.parse(JSON.parse(result.item.output).content[0].text)).toMatchObject({ width: 720, height: 405, bytes: 5184, mimeType: 'image/jpeg', sourceWidth: 1920 });
  expect(sizes).toEqual([1280, 960, 720]);
  expect(items.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0)).toBeLessThanOrEqual(30000);
  expect(error).not.toHaveBeenCalled();
  live.close(); channel.event({ type: 'session.closed' });
});

it('returns a controlled tool error instead of sending an oversized tool payload', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  const error = vi.fn();
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn() }, [{ name: 'read_meeting', description: '', inputSchema: {}, annotations: {}, execute: async () => ({ content: [{ type: 'text', text: '會議'.repeat(15000) }] }) }], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  const response = (event: unknown) => channel.event({ type: 'response.event', event });
  response({ type: 'response.created' });
  response({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'read', name: 'read_meeting', arguments: '{}' } });
  response({ type: 'response.completed' });
  await vi.waitFor(() => expect(channel.send).toHaveBeenCalled());
  const events = channel.send.mock.calls.map(([value]) => JSON.parse(String(value)));
  const result = events.find((event) => event.item?.type === 'function_call_output');
  expect(JSON.parse(result.item.output)).toMatchObject({ isError: true });
  expect(result.item.output).toContain('smaller file page');
  expect(error).not.toHaveBeenCalled();
  live.close(); channel.event({ type: 'session.closed' });
});

it('reserves enough capacity to verify a drawing after a large reference image', async () => {
  vi.stubGlobal('RTCPeerConnection', Connection);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() })));
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob(callback: (blob: Blob) => void, mime: string) {
    callback(new Blob([new Uint8Array(Math.floor(this.width * this.width / 100))], { type: mime }));
  } };
  vi.stubGlobal('document', { createElement: () => canvas });
  const error = vi.fn();
  const tool = (name: string, data?: string) => ({ name, description: '', inputSchema: {}, annotations: {}, execute: async () => ({ content: [
    { type: 'text' as const, text: JSON.stringify({ ok: true, width: 1280, height: 720, changedIds: ['review'] }) },
    ...(data ? [{ type: 'image' as const, mimeType: 'image/jpeg', data }] : []),
  ] }) });
  const live = new AgentLive({ stream: vi.fn(), transcript: vi.fn(), prepared: vi.fn(), error, closed: vi.fn() }, [
    tool('read_shared_file', btoa('x'.repeat(12_000))), tool('edit_whiteboard'), tool('capture_whiteboard', btoa('x'.repeat(50_000))),
  ], false, () => true);
  const channel = live.channel as unknown as Channel;
  channel.event({ type: 'session.started' });
  live.context(JSON.stringify({ meeting: [{ seq: 1, text: 'x'.repeat(5800) }] }));
  for (const [index, name] of ['read_shared_file', 'edit_whiteboard', 'capture_whiteboard'].entries()) {
    const response = (event: unknown) => channel.event({ type: 'response.event', delegation_id: String(index), event });
    response({ type: 'response.created' });
    response({ type: 'response.output_item.done', item: { type: 'function_call', call_id: String(index), name, arguments: '{}' } });
    response({ type: 'response.completed' });
    await vi.waitFor(() => expect(channel.send.mock.calls.filter(([raw]) => JSON.parse(String(raw)).type === 'response.create')).toHaveLength(index + 1));
  }
  const items = channel.send.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter(event => event.type === 'response.item.create');
  expect(items.filter(event => event.item.content?.some((part: { type: string }) => part.type === 'input_image'))).toHaveLength(2);
  expect(items.filter(event => event.item.type === 'function_call_output').every(event => JSON.parse(event.item.output).isError === false)).toBe(true);
  expect(error).not.toHaveBeenCalled();
  live.close(); channel.event({ type: 'session.closed' });
});
