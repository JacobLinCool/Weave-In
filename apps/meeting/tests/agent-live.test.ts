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


it('keeps all four tool schemas compatible with Live initialization without weakening execution validation', () => {
  const tools = scopedTools({} as MeetingToolsContext, { source: 'all', chat: true, screen: true, files: true } as RoomAgent['config'], 'owner', () => true, () => true);
  const agent = { config: { language: 'auto', instructions: 'Help' } } as RoomAgent;
  const settings = liveSettings(agent, tools, false);
  const serialized = JSON.stringify(settings);
  JSON.parse(serialized, (_key, value: unknown) => {
    if (typeof value === 'number') expect(Number.isInteger(value)).toBe(true);
    return value;
  });
  expect(tools).toHaveLength(4);
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
  expect(items()).toHaveLength(2);
  expect(items()[1].item.content[0].text).toContain('New record');
  expect(items()[1].item.content[0].text).not.toContain('Already seeded');
  expect(live.send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'file', output: '中'.repeat(5000) } })).toBe(true);
  expect(error).not.toHaveBeenCalled();
  expect(items()).toHaveLength(3);
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
  const image = items.map((value) => JSON.parse(value)).find((event) => event.item.content?.[0]?.type === 'input_image');
  expect(image.item.content[0].image_url).toMatch(/^data:image\/jpeg;base64,/u);
  const result = items.map((value) => JSON.parse(value)).find((event) => event.item.type === 'function_call_output');
  expect(JSON.parse(JSON.parse(result.item.output).content[0].text)).toMatchObject({ width: 960, height: 540, bytes: 9216, mimeType: 'image/jpeg', sourceWidth: 1920 });
  expect(sizes).toEqual([1280, 960]);
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
