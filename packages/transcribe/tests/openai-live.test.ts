import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPTIONS } from '../src/contracts';
import {
  OPENAI_ROTATION_INTERVAL_MS,
  OpenAiLiveTranscriber,
  type OpenAiLiveDependencies,
} from '../src/openai-live';

class MockSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: object): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

describe('OpenAiLiveTranscriber', () => {
  it.each(['api-key', 'ephemeral-token'] as const)('uses a credential protocol for %s and redacts provider errors', async (type) => {
    const socket = new MockSocket();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const token = 'private-token';
    const client = new OpenAiLiveTranscriber({
      credential: { type, value: token },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies: { ...dependenciesFor(socket), createWebSocket: connect },
    });
    const starting = client.start();
    const rejected = expect(starting).rejects.toThrow('Rejected [redacted]');
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith(
      'wss://api.openai.com/v1/realtime?intent=transcription',
      ['realtime', `openai-insecure-api-key.${token}`],
    ));
    socket.open();
    socket.message({ type: 'error', error: { message: `Rejected ${token}` } });
    await rejected;
    expect(socket.readyState).toBe(3);
  });

  it('redacts a credential if native WebSocket construction throws', async () => {
    const socket = new MockSocket();
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'api-key', value: 'private-key' },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies: { ...dependenciesFor(socket), createWebSocket: () => { throw new Error('Invalid protocol private-key'); } },
    });
    await expect(client.start()).rejects.toThrow('Invalid protocol [redacted]');
  });

  it('streams 24 kHz PCM and reconciles delta and completion events by item order', async () => {
    const peer = new MockSocket();
    const observed = callbacks();
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'ephemeral-token', value: 'ephemeral-token' },
      options: {
        ...DEFAULT_OPTIONS,
        provider: 'openai',
        languageCodes: ['cmn-Hant-TW', 'en-US'],
        mode: 'VERBATIM',
        customVocabulary: ['WebMCP'],
      },
      callbacks: observed,
      dependencies: dependenciesFor(peer),
    });

    expect(client.audioFormat).toEqual({ sampleRate: 24_000, framesPerChunk: 2_400 });
    const starting = client.start();
    await Promise.resolve(); await Promise.resolve();
    peer.open();
    const update = JSON.parse(peer.sent[0] ?? '{}');
    expect(update).toMatchObject({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: {
              model: 'gpt-live-transcribe',
              languages: ['zh-tw', 'en'],
              keywords: ['WebMCP'],
              delay: 'minimal',
            },
          },
        },
      },
    });
    expect(update.session.audio.input.turn_detection).toBeNull();
    peer.message({ type: 'session.updated' });
    await starting;

    client.sendAudio(new Uint8Array([0, 1, 255]).buffer);
    expect(JSON.parse(peer.sent.at(-1) ?? '{}')).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAH/',
    });
    // Quiet speech is still sent even below the endpoint detector threshold.
    client.sendAudio(new Int16Array(2_400).fill(100).buffer);
    expect(JSON.parse(peer.sent.at(-1) ?? '{}').type).toBe('input_audio_buffer.append');
    for (let index = 0; index < 40; index += 1) client.sendAudio(new Int16Array(2_400).fill(4_000).buffer);
    expect(peer.sent.filter(raw => JSON.parse(raw).type === 'input_audio_buffer.commit')).toHaveLength(0);
    for (let index = 0; index < 7; index += 1) client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.sent.at(-1) ?? '{}').type).toBe('input_audio_buffer.append');
    client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.sent.at(-1) ?? '{}')).toEqual({ type: 'input_audio_buffer.commit' });
    sendTurn(client);

    peer.message({ type: 'input_audio_buffer.committed', item_id: 'first' });
    peer.message({ type: 'input_audio_buffer.committed', item_id: 'second' });
    peer.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'first',
      delta: 'First partial',
    });
    peer.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'second',
      transcript: 'Second final.',
    });
    expect(observed.onFinal).not.toHaveBeenCalled();
    expect(observed.onInterim).toHaveBeenLastCalledWith('First partial\nSecond final.');
    peer.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'First final.',
    });
    expect(observed.onFinal.mock.calls.map(([text]) => text)).toEqual([
      'First final.',
      'Second final.',
    ]);
    await client.stop();
    expect(peer.readyState).toBe(3);
  });

  it('requests a fresh ephemeral token during scheduled rotation', async () => {
    const peers = [new MockSocket(), new MockSocket()];
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const tokens: string[] = [];
    let peerIndex = 0;
    let timerId = 0;
    const credential = vi.fn(async ({ connection }: { connection: number }) => ({
      type: 'ephemeral-token' as const,
      value: `token-${connection}`,
    }));
    const dependencies: OpenAiLiveDependencies = {
      createWebSocket: (_url, protocols) => {
        tokens.push(protocols[1]!);
        return peers[peerIndex++] as unknown as WebSocket;
      },
      setTimeout: (callback, delay) => {
        timerId += 1;
        if (delay < 1_000) queueMicrotask(callback);
        else scheduled.set(timerId, { callback, delay });
        return timerId;
      },
      clearTimeout: (id) => scheduled.delete(id as number),
    };
    const client = new OpenAiLiveTranscriber({
      credential,
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies,
    });
    const starting = client.start();
    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    peers[0]?.open();
    peers[0]?.message({ type: 'session.updated' });
    await starting;

    const rotation = [...scheduled.values()].find(
      (entry) => entry.delay === OPENAI_ROTATION_INTERVAL_MS,
    );
    rotation?.callback();
    await vi.waitFor(() => expect(tokens).toHaveLength(2));
    peers[1]?.open();
    peers[1]?.message({ type: 'session.updated' });
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(2));
    expect(tokens).toEqual(['openai-insecure-api-key.token-1', 'openai-insecure-api-key.token-2']);
    await client.stop();
  });
});

describe('OpenAI finalization', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for an already committed item without an ID before rotating, then publishes new finals', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    sendTurn(client);
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(peers).toHaveLength(1);

    // Audio arriving while the old connection drains is sent on the new one.
    sendTurn(client);
    complete(peers[0]!, 'old', 'Old final.');
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(2);
    expect(observed.onFinal).toHaveBeenCalledWith('Old final.', 1);
    ready(peers[1]!);
    expect(peers[1]!.sent.map((raw) => JSON.parse(raw).type))
      .toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.append', 'input_audio_buffer.commit']);

    // Late old-connection events must not reintroduce items or fail the new one.
    peers[0]!.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'stale', delta: 'stale' });
    peers[0]!.dispatchEvent(new Event('error'));
    complete(peers[1]!, 'new', 'New final.');
    expect(observed.onFinal.mock.calls).toEqual([['Old final.', 1], ['New final.', 2]]);
    expect(observed.onFatalError).not.toHaveBeenCalled();
    await client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('commits a trailing buffer once and waits for an empty completion', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(4_800));
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(peers[0]!.sent.filter((raw) => JSON.parse(raw).type === 'input_audio_buffer.commit')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(peers).toHaveLength(1);
    complete(peers[0]!, 'silent', '');
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(2);
    ready(peers[1]!);
    expect(observed.onFinal).not.toHaveBeenCalled();
    await client.stop();
  });

  it('keeps stop idempotent and waits for the final committed audio', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    sendTurn(client);
    const stopping = client.stop();
    expect(client.stop()).toBe(stopping);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(peers[0]!.readyState).toBe(1);
    complete(peers[0]!, 'last', 'Last final.');
    await stopping;
    expect(observed.onFinal).toHaveBeenCalledWith('Last final.', 1);
    expect(peers[0]!.readyState).toBe(3);
    expect(observed.onFatalError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reopen when stop interrupts rotation finalization', async () => {
    const { client, peers, credential } = await startFinalizationTest();
    sendTurn(client);
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    const stopping = client.stop();
    complete(peers[0]!, 'last', 'Last final.');
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(1);
    expect(credential).toHaveBeenCalledTimes(1);
    expect(peers[0]!.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late credential result after stop', async () => {
    const token = Promise.withResolvers<{ type: 'ephemeral-token'; value: string }>();
    const { client, peers, credential } = await startFinalizationTest();
    credential.mockImplementationOnce(() => token.promise);
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(credential).toHaveBeenCalledTimes(2);
    await client.stop();
    token.resolve({ type: 'ephemeral-token', value: 'late-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a connecting WebSocket when stop interrupts reconnection', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(peers).toHaveLength(2);
    expect(peers[1]!.readyState).toBe(0);
    await client.stop();
    expect(peers[1]!.readyState).toBe(3);
    peers[1]!.message({ type: 'session.updated' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.onConnectionReady).toHaveBeenCalledTimes(1);
    expect(observed.onFatalError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rotation', 'stop'])('reports a bounded finalization timeout during %s', async (operation) => {
    const { client, peers, observed } = await startFinalizationTest();
    sendTurn(client);
    let stopping: Promise<void> | undefined;
    if (operation === 'rotation') await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    else stopping = client.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;
    expect(observed.onFatalError).toHaveBeenCalledExactlyOnceWith(
      'OPENAI_FINALIZATION_TIMEOUT', expect.stringContaining('transcript may be incomplete'),
    );
    expect(observed.onFinal).not.toHaveBeenCalled();
    expect(peers).toHaveLength(1);
    await client.stop();
    expect(peers[0]!.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['error', 'OPENAI_API_ERROR'],
    ['conversation.item.input_audio_transcription.failed', 'OPENAI_TRANSCRIPTION_FAILED'],
  ])('handles %s while draining instead of waiting forever', async (type, code) => {
    const { client, peers, observed } = await startFinalizationTest();
    sendTurn(client);
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    peers[0]!.message({ type, item_id: 'failed', error: { message: 'Rejected test-token' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.onFatalError).toHaveBeenCalledExactlyOnceWith(code, 'Rejected [redacted]');
    expect(peers).toHaveLength(1);
    const sent = peers[0]!.sent.length;
    client.sendAudio(new ArrayBuffer(4_800));
    expect(peers[0]!.sent).toHaveLength(sent);
    await client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count duplicate completions toward other outstanding commits', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    sendTurn(client);
    sendTurn(client);
    complete(peers[0]!, 'first', 'First final.');
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    complete(peers[0]!, 'first', 'First final.');
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(1);
    expect(observed.onFinal).toHaveBeenCalledTimes(1);
    complete(peers[0]!, 'second', 'Second final.');
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(2);
    ready(peers[1]!);
    await client.stop();
    expect(observed.onFinal.mock.calls).toEqual([['First final.', 1], ['Second final.', 1]]);
  });
});

async function startFinalizationTest() {
  const peers: MockSocket[] = [];
  const observed = callbacks();
  const credential = vi.fn(async () => ({ type: 'ephemeral-token' as const, value: 'test-token' }));
  const client = new OpenAiLiveTranscriber({
    credential,
    options: { ...DEFAULT_OPTIONS, provider: 'openai' },
    callbacks: observed,
    dependencies: {
      createWebSocket: () => {
        const peer = new MockSocket();
        peers.push(peer);
        return peer as unknown as WebSocket;
      },
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  const starting = client.start();
  await vi.advanceTimersByTimeAsync(0);
  ready(peers[0]!);
  await starting;
  return { client, peers, observed, credential };
}

function sendTurn(client: OpenAiLiveTranscriber): void {
  client.sendAudio(new Int16Array(2_400).fill(4_000).buffer);
  client.sendAudio(new ArrayBuffer(38_400));
}

function ready(peer: MockSocket): void {
  peer.open();
  peer.message({ type: 'session.updated' });
}

function complete(peer: MockSocket, itemId: string, text: string): void {
  peer.message({ type: 'input_audio_buffer.committed', item_id: itemId });
  peer.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text });
}

function dependenciesFor(
  peer: MockSocket,
): OpenAiLiveDependencies {
  return {
    createWebSocket: () => peer as unknown as WebSocket,
    setTimeout: (callback, delay) => {
      if (delay < 1_000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => undefined,
  };
}

function callbacks() {
  return {
    onInterim: vi.fn(),
    onFinal: vi.fn(),
    onConnectionReady: vi.fn(),
    onFatalError: vi.fn(),
  };
}
