import { describe, expect, it, vi } from 'vitest';

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
  it('opens a transcription WebSocket with a credential protocol and redacts provider errors', async () => {
    const socket = new MockSocket();
    const connect = vi.fn(() => socket as unknown as WebSocket);
    const token = 'ephemeral-private-token';
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'ephemeral-token', value: token },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies: { ...dependenciesFor(socket), createWebSocket: connect },
    });
    const starting = client.start();
    const rejected = expect(starting).rejects.not.toThrow(new RegExp(token, 'u'));
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
    const socket = new MockSocket();
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
      dependencies: dependenciesFor(socket),
    });

    expect(client.audioFormat).toEqual({ sampleRate: 24_000, framesPerChunk: 2_400 });
    const starting = client.start();
    client.sendAudio(new Uint8Array([0, 1, 255, 0]).buffer);
    await Promise.resolve();
    await Promise.resolve();
    socket.open();
    const update = JSON.parse(socket.sent[0] ?? '{}');
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
              delay: 'low',
            },
            turn_detection: null,
          },
        },
      },
    });
    socket.message({ type: 'session.updated' });
    await starting;

    expect(socket.sent).toHaveLength(2);
    client.sendAudio(new Uint8Array([0, 1, 255, 0]).buffer);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAH/AA==',
    });

    socket.message({ type: 'conversation.item.created', item: { id: 'first' } });
    socket.message({ type: 'conversation.item.created', item: { id: 'second' } });
    socket.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'first',
      delta: 'First partial',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'second',
      transcript: 'Second final.',
    });
    expect(observed.onFinal).not.toHaveBeenCalled();
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'First final.',
    });
    expect(observed.onFinal.mock.calls.map(([text]) => text)).toEqual([
      'First final.',
      'Second final.',
    ]);
    await client.stop();
    expect(socket.readyState).toBe(3);
  });

  it('commits a complete spoken turn after trailing silence and flushes speech on stop', async () => {
    const socket = new MockSocket();
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'api-key', value: 'test-key' },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(), dependencies: dependenciesFor(socket),
    });
    const starting = client.start();
    await Promise.resolve(); await Promise.resolve();
    socket.open(); socket.message({ type: 'session.updated' }); await starting;
    const speech = new Int16Array(2400).fill(1000).buffer;
    const silence = new Int16Array(2400).buffer;
    const commits = () => socket.sent.filter(raw => JSON.parse(raw).type === 'input_audio_buffer.commit');
    for (let i = 0; i < 20; i++) client.sendAudio(silence);
    expect(socket.sent).toHaveLength(1);
    // A phrase spanning many chunks must not be cut by a fixed timer.
    for (let i = 0; i < 40; i++) client.sendAudio(speech);
    for (let i = 0; i < 7; i++) client.sendAudio(silence);
    expect(commits()).toHaveLength(0);
    client.sendAudio(silence);
    expect(commits()).toHaveLength(1);
    for (let i = 0; i < 20; i++) client.sendAudio(silence);
    expect(commits()).toHaveLength(1);
    client.sendAudio(speech);
    // A delayed acknowledgment for the prior turn must not erase the new buffer.
    socket.message({ type: 'input_audio_buffer.committed', item_id: 'previous-turn' });
    await client.stop();
    expect(commits()).toHaveLength(2);
    expect(socket.readyState).toBe(3);
  });

  it('keeps an auto-committed turn alive until its final transcript arrives during stop', async () => {
    const socket = new MockSocket();
    const observed = callbacks();
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    let timerId = 0;
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'ephemeral-token', value: 'test-token' },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: observed,
      dependencies: {
        ...dependenciesFor(socket),
        setTimeout: (callback, delay) => { scheduled.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: (id) => { scheduled.delete(id as number); },
      },
    });
    const starting = client.start();
    await Promise.resolve(); await Promise.resolve();
    socket.open(); socket.message({ type: 'session.updated' }); await starting;
    client.sendAudio(new Int16Array(2400).fill(1000).buffer);
    for (let i = 0; i < 8; i++) client.sendAudio(new Int16Array(2400).buffer);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'input_audio_buffer.commit' });
    const stopping = client.stop();
    await Promise.resolve();
    expect(socket.readyState).toBe(1);
    expect([...scheduled.values()].some(timer => timer.delay === 900)).toBe(true);
    socket.message({ type: 'input_audio_buffer.committed', item_id: 'last-turn' });
    socket.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'last-turn', transcript: 'Weave, go ahead.' });
    await stopping;
    expect(observed.onFinal).toHaveBeenCalledWith('Weave, go ahead.', 1);
    expect(socket.readyState).toBe(3);
    expect(scheduled.size).toBe(0);
  });

  it('rotates credentials and discards an unfinished old turn after the finalization deadline', async () => {
    const observed = callbacks();
    const sockets = [new MockSocket(), new MockSocket()];
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const tokens: string[] = [];
    let socketIndex = 0;
    let timerId = 0;
    const credential = vi.fn(async ({ connection }: { connection: number }) => ({
      type: 'ephemeral-token' as const,
      value: `token-${connection}`,
    }));
    const dependencies: OpenAiLiveDependencies = {
      createWebSocket: (_url, protocols) => {
        tokens.push(protocols[1]!);
        return sockets[socketIndex++] as unknown as WebSocket;
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
      callbacks: observed,
      dependencies,
    });
    const starting = client.start();
    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    sockets[0]!.open();
    sockets[0]!.message({ type: 'session.updated' });
    await starting;
    client.sendAudio(new Int16Array(2400).fill(1000).buffer);
    sockets[0]!.message({ type: 'input_audio_buffer.committed', item_id: 'unfinished' });
    sockets[0]!.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'unfinished', delta: 'Never finalized' });

    const rotation = [...scheduled.values()].find(
      (entry) => entry.delay === OPENAI_ROTATION_INTERVAL_MS,
    );
    rotation?.callback();
    await vi.waitFor(() => expect(tokens).toHaveLength(2));
    sockets[1]!.open();
    sockets[1]!.message({ type: 'session.updated' });
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(2));
    expect(tokens).toEqual(['openai-insecure-api-key.token-1', 'openai-insecure-api-key.token-2']);
    sockets[1]!.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-turn', transcript: 'Weave, go ahead.' });
    expect(observed.onFinal).toHaveBeenCalledExactlyOnceWith('Weave, go ahead.', 2);
    expect(observed.onInterim).toHaveBeenCalledWith('');
    await client.stop();
  });
});

function dependenciesFor(socket: MockSocket): OpenAiLiveDependencies {
  return {
    createWebSocket: () => socket as unknown as WebSocket,
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
