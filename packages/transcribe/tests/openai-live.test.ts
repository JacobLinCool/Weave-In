import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  readonly transceivers: { kind: string; direction: RTCRtpTransceiverDirection | undefined }[] = [];

  addTransceiver(kind: string, init: RTCRtpTransceiverInit): void {
    this.transceivers.push({ kind, direction: init.direction });
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const audio = this.transceivers.some((entry) => entry.kind === 'audio');
    return { type: 'offer', sdp: `v=0\r\n${audio ? 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' : ''}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` };
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
    expect(observedRequests[0]?.body).toMatch(/^m=audio /mu);
    expect(peer.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
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
              delay: 'minimal',
            },
          },
        },
      },
    });
    expect(update.session.audio.input.turn_detection).toBeNull();
    peer.channel.message({ type: 'session.updated' });
    await starting;

    client.sendAudio(new Uint8Array([0, 1, 255]).buffer);
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}')).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAH/',
    });
    for (let index = 0; index < 19; index += 1) client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}').type).toBe('input_audio_buffer.append');
    client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}')).toEqual({ type: 'input_audio_buffer.commit' });
    client.sendAudio(new Int16Array(2_400).fill(4_000).buffer);
    for (let index = 0; index < 3; index += 1) client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}').type).toBe('input_audio_buffer.append');
    client.sendAudio(new ArrayBuffer(4_800));
    expect(JSON.parse(peer.channel.sent.at(-1) ?? '{}')).toEqual({ type: 'input_audio_buffer.commit' });

    peer.channel.message({ type: 'input_audio_buffer.committed', item_id: 'first' });
    peer.channel.message({ type: 'input_audio_buffer.committed', item_id: 'second' });
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
    expect(observed.onInterim).toHaveBeenLastCalledWith('First partial\nSecond final.');
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
    for (const peer of peers) {
      expect(peer.localDescriptions[0]?.sdp).toMatch(/^m=audio /mu);
    }
    peers[1]?.channel.open();
    peers[1]?.channel.message({ type: 'session.updated' });
    await vi.waitFor(() => expect(credential).toHaveBeenCalledTimes(2));
    expect(tokens).toEqual(['Bearer token-1', 'Bearer token-2']);
    await client.stop();
  });
});

describe('OpenAI finalization', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for an already committed item without an ID before rotating, then publishes new finals', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(96_000));
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.channel.readyState).toBe('open');
    await vi.advanceTimersByTimeAsync(1_200);
    expect(peers).toHaveLength(1);

    // Audio arriving while the old connection drains is sent on the new one.
    client.sendAudio(new ArrayBuffer(96_000));
    complete(peers[0]!, 'old', 'Old final.');
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(2);
    expect(observed.onFinal).toHaveBeenCalledWith('Old final.', 1);
    ready(peers[1]!);
    expect(peers[1]!.channel.sent.map((raw) => JSON.parse(raw).type))
      .toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit']);

    // Late old-connection events must not reintroduce items or fail the new one.
    peers[0]!.channel.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'stale', delta: 'stale' });
    peers[0]!.channel.dispatchEvent(new Event('error'));
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
    expect(peers[0]!.channel.sent.filter((raw) => JSON.parse(raw).type === 'input_audio_buffer.commit')).toHaveLength(1);
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
    client.sendAudio(new ArrayBuffer(96_000));
    const stopping = client.stop();
    expect(client.stop()).toBe(stopping);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(peers[0]!.channel.readyState).toBe('open');
    complete(peers[0]!, 'last', 'Last final.');
    await stopping;
    expect(observed.onFinal).toHaveBeenCalledWith('Last final.', 1);
    expect(peers[0]!.channel.readyState).toBe('closed');
    expect(observed.onFatalError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reopen when stop interrupts rotation finalization', async () => {
    const { client, peers, credential } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(96_000));
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    const stopping = client.stop();
    complete(peers[0]!, 'last', 'Last final.');
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(peers).toHaveLength(1);
    expect(credential).toHaveBeenCalledTimes(1);
    expect(peers[0]!.channel.readyState).toBe('closed');
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

  it('aborts in-flight setup when stop interrupts reconnection', async () => {
    const answer = Promise.withResolvers<Response>();
    const { client, peers, fetcher, observed } = await startFinalizationTest();
    fetcher.mockImplementationOnce(() => answer.promise);
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    expect(peers).toHaveLength(2);
    const request = fetcher.mock.calls[1]![1];
    await client.stop();
    expect(request.signal?.aborted).toBe(true);
    answer.resolve(new Response('late-answer'));
    await vi.advanceTimersByTimeAsync(0);
    expect(peers[1]!.remoteDescriptions).toEqual([]);
    expect(observed.onConnectionReady).toHaveBeenCalledTimes(1);
    expect(observed.onFatalError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rotation', 'stop'])('reports a bounded finalization timeout during %s', async (operation) => {
    const { client, peers, observed } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(96_000));
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
    expect(peers[0]!.channel.readyState).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['error', 'OPENAI_API_ERROR'],
    ['conversation.item.input_audio_transcription.failed', 'OPENAI_TRANSCRIPTION_FAILED'],
  ])('handles %s while draining instead of waiting forever', async (type, code) => {
    const { client, peers, observed } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(96_000));
    await vi.advanceTimersByTimeAsync(OPENAI_ROTATION_INTERVAL_MS);
    peers[0]!.channel.message({ type, item_id: 'failed', error: { message: 'Rejected test-token' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.onFatalError).toHaveBeenCalledExactlyOnceWith(code, 'Rejected [redacted]');
    expect(peers).toHaveLength(1);
    const sent = peers[0]!.channel.sent.length;
    client.sendAudio(new ArrayBuffer(4_800));
    expect(peers[0]!.channel.sent).toHaveLength(sent);
    await client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count duplicate completions toward other outstanding commits', async () => {
    const { client, peers, observed } = await startFinalizationTest();
    client.sendAudio(new ArrayBuffer(96_000));
    client.sendAudio(new ArrayBuffer(96_000));
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
  const peers: MockPeerConnection[] = [];
  const observed = callbacks();
  const credential = vi.fn(async () => ({ type: 'ephemeral-token' as const, value: 'test-token' }));
  const fetcher = vi.fn(async (_input: string, _init: RequestInit) => new Response('answer'));
  const client = new OpenAiLiveTranscriber({
    credential,
    options: { ...DEFAULT_OPTIONS, provider: 'openai' },
    callbacks: observed,
    dependencies: {
      createPeerConnection: () => {
        const peer = new MockPeerConnection();
        peers.push(peer);
        return peer as unknown as RTCPeerConnection;
      },
      fetch: fetcher,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  const starting = client.start();
  await vi.advanceTimersByTimeAsync(0);
  ready(peers[0]!);
  await starting;
  return { client, peers, observed, credential, fetcher };
}

function ready(peer: MockPeerConnection): void {
  peer.channel.open();
  peer.channel.message({ type: 'session.updated' });
}

function complete(peer: MockPeerConnection, itemId: string, text: string): void {
  peer.channel.message({ type: 'input_audio_buffer.committed', item_id: itemId });
  peer.channel.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: text });
}

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
