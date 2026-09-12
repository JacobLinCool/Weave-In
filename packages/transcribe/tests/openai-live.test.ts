import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPTIONS } from '../src/contracts';
import {
  OPENAI_ROTATION_INTERVAL_MS,
  OpenAiLiveTranscriber,
  type OpenAiLiveDependencies,
} from '../src/openai-live';

class MockDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  message(value: object): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class MockPeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  readonly channel = new MockDataChannel();
  readonly localDescriptions: RTCSessionDescriptionInit[] = [];
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'test-offer' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescriptions.push(description);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptions.push(description);
    this.connectionState = 'connected';
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

describe('OpenAiLiveTranscriber', () => {
  it('accepts direct API keys and redacts credentials from setup failures', async () => {
    const apiKeyPeer = new MockPeerConnection();
    const apiKeyRequests: RequestInit[] = [];
    const apiKeyClient = new OpenAiLiveTranscriber({
      credential: { type: 'api-key', value: 'standard-secret-key' },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies: dependenciesFor(apiKeyPeer, async (_input, init) => {
        apiKeyRequests.push(init);
        return new Response('answer', { status: 200 });
      }),
    });
    const apiKeyStarting = apiKeyClient.start();
    await vi.waitFor(() => expect(apiKeyRequests).toHaveLength(1));
    apiKeyPeer.channel.open();
    apiKeyPeer.channel.message({ type: 'session.updated' });
    await apiKeyStarting;
    expect(apiKeyRequests[0]?.headers).toMatchObject({
      Authorization: 'Bearer standard-secret-key',
    });
    await apiKeyClient.stop();

    const peer = new MockPeerConnection();
    const token = 'ephemeral-private-token';
    const client = new OpenAiLiveTranscriber({
      credential: { type: 'ephemeral-token', value: token },
      options: { ...DEFAULT_OPTIONS, provider: 'openai', customVocabulary: [] },
      callbacks: callbacks(),
      dependencies: dependenciesFor(peer, async () =>
        new Response(`Rejected ${token}`, { status: 401 }),
      ),
    });
    await expect(client.start()).rejects.not.toThrow(new RegExp(token, 'u'));
  });

  it('streams 24 kHz PCM and reconciles delta and completion events by item order', async () => {
    const peer = new MockPeerConnection();
    const observedRequests: RequestInit[] = [];
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
      dependencies: dependenciesFor(peer, async (_input, init) => {
        observedRequests.push(init);
        return new Response('test-answer', { status: 200 });
      }),
    });

    expect(client.audioFormat).toEqual({ sampleRate: 24_000, framesPerChunk: 2_400 });
    const starting = client.start();
    await vi.waitFor(() => expect(observedRequests).toHaveLength(1));
    expect(observedRequests[0]?.headers).toEqual({
      Authorization: 'Bearer ephemeral-token',
      'Content-Type': 'application/sdp',
    });
    peer.channel.open();
    const update = JSON.parse(peer.channel.sent[0] ?? '{}');
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
            turn_detection: { type: 'server_vad' },
          },
        },
      },
    });
    peer.channel.message({ type: 'session.updated' });
    await starting;

    client.sendAudio(new Uint8Array([0, 1, 255]).buffer);
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}')).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAH/',
    });

    peer.channel.message({ type: 'conversation.item.created', item: { id: 'first' } });
    peer.channel.message({ type: 'conversation.item.created', item: { id: 'second' } });
    peer.channel.message({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'first',
      delta: 'First partial',
    });
    peer.channel.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'second',
      transcript: 'Second final.',
    });
    expect(observed.onFinal).not.toHaveBeenCalled();
    peer.channel.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'First final.',
    });
    expect(observed.onFinal.mock.calls.map(([text]) => text)).toEqual([
      'First final.',
      'Second final.',
    ]);
    await client.stop();
    expect(peer.connectionState).toBe('closed');
  });

  it('requests a fresh ephemeral token during scheduled rotation', async () => {
    const peers = [new MockPeerConnection(), new MockPeerConnection()];
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const tokens: string[] = [];
    let peerIndex = 0;
    let timerId = 0;
    const credential = vi.fn(async ({ connection }: { connection: number }) => ({
      type: 'ephemeral-token' as const,
      value: `token-${connection}`,
    }));
    const dependencies: OpenAiLiveDependencies = {
      createPeerConnection: () => peers[peerIndex++] as unknown as RTCPeerConnection,
      fetch: async (_input, init) => {
        tokens.push(String((init.headers as Record<string, string>).Authorization));
        return new Response('answer', { status: 200 });
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
    peers[0]?.channel.open();
    peers[0]?.channel.message({ type: 'session.updated' });
    await starting;

    const rotation = [...scheduled.values()].find(
      (entry) => entry.delay === OPENAI_ROTATION_INTERVAL_MS,
    );
    rotation?.callback();
    await vi.waitFor(() => expect(tokens).toHaveLength(2));
    peers[1]?.channel.open();
    peers[1]?.channel.message({ type: 'session.updated' });
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(2));
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2']);
    await client.stop();
  });
});

function dependenciesFor(
  peer: MockPeerConnection,
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
): OpenAiLiveDependencies {
  return {
    createPeerConnection: () => peer as unknown as RTCPeerConnection,
    fetch: fetcher,
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
