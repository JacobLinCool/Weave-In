import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPTIONS } from '../src/contracts';
import {
  GeminiLiveTranscriber,
  GEMINI_ROTATION_INTERVAL_MS,
  type GeminiLiveDependencies,
} from '../src/gemini-live';

class MockWebSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  closeCode: number | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.closeCode = code;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  message(value: object): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}

describe('GeminiLiveTranscriber', () => {
  it('uses API-key and ephemeral-token endpoints without exposing secrets in errors', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSING: 2 });
    for (const [credential, expected] of [
      [{ type: 'api-key', value: 'private-api-key' }, '?key=private-api-key'],
      [{ type: 'ephemeral-token', value: 'private-token' }, 'Constrained?access_token=private-token'],
    ] as const) {
      const socket = new MockWebSocket();
      const urls: string[] = [];
      const dependencies = dependenciesFor(socket, urls);
      const client = new GeminiLiveTranscriber({
        credential,
        options: { ...DEFAULT_OPTIONS, customVocabulary: [] },
        callbacks: callbacks(),
        dependencies,
      });
      const starting = client.start();
      await vi.waitFor(() => expect(urls).toHaveLength(1));
      socket.open();
      socket.message({ error: { message: `Rejected ${credential.value} ${urls[0]}` } });
      await expect(starting).rejects.not.toThrow(new RegExp(credential.value, 'u'));
      expect(urls[0]).toContain(expected);
    }
  });

  it('streams 16 kHz PCM and requests a new provider credential on rotation', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSING: 2 });
    const sockets = [new MockWebSocket(), new MockWebSocket()];
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const urls: string[] = [];
    let nextSocket = 0;
    let timerId = 0;
    const provider = vi.fn(async ({ connection }: { connection: number }) => ({
      type: 'ephemeral-token' as const,
      value: `token-${connection}`,
    }));
    const dependencies: GeminiLiveDependencies = {
      createWebSocket: (url) => {
        urls.push(url);
        return sockets[nextSocket++] as unknown as WebSocket;
      },
      setTimeout: (callback, delay) => {
        timerId += 1;
        if (delay < 1_000) queueMicrotask(callback);
        else scheduled.set(timerId, { callback, delay });
        return timerId;
      },
      clearTimeout: (id) => scheduled.delete(id as number),
    };
    const client = new GeminiLiveTranscriber({
      credential: provider,
      options: { ...DEFAULT_OPTIONS, customVocabulary: ['WebMCP'] },
      callbacks: callbacks(),
      dependencies,
    });
    const starting = client.start();
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    sockets[0]?.open();
    sockets[0]?.message({ setupComplete: {} });
    await starting;
    client.sendAudio(new Uint8Array([0, 1, 255]).buffer);
    expect(JSON.parse(sockets[0]?.sent.at(-1) ?? '{}')).toEqual({
      realtimeInput: { audio: { data: 'AAH/', mimeType: 'audio/pcm;rate=16000' } },
    });

    const rotation = [...scheduled.values()].find(
      (entry) => entry.delay === GEMINI_ROTATION_INTERVAL_MS,
    );
    expect(rotation).toBeDefined();
    rotation?.callback();
    await vi.waitFor(() => expect(urls).toHaveLength(2));
    sockets[1]?.open();
    sockets[1]?.message({ setupComplete: {} });
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain('access_token=token-2');
    await client.stop();
  });
});

function dependenciesFor(socket: MockWebSocket, urls: string[]): GeminiLiveDependencies {
  return {
    createWebSocket: (url) => {
      urls.push(url);
      return socket as unknown as WebSocket;
    },
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


describe('Gemini connection recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([1000, 1006, 1011])('recovers from close %i with a fresh token and queued audio', async (code) => {
    const h = await recoveryHarness();
    h.sockets[0]!.close(code);
    h.client.sendAudio(new Uint8Array([1, 2]).buffer);
    expect(h.observed.onReconnecting).toHaveBeenCalledOnce();
    expect(h.observed.onFatalError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.provider).toHaveBeenCalledTimes(2);
    h.ready(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.urls[1]).toContain('token-2');
    expect(JSON.parse(h.sockets[1]!.sent.at(-1)!)).toMatchObject({
      realtimeInput: { audio: { data: 'AQI=' } },
    });
    h.sockets[1]!.message({ serverContent: { inputTranscription: { text: 'Recovered' } } });
    expect(h.observed.onFinal).toHaveBeenCalledWith('Recovered', 2);
    // Late events from a retired socket must not tear down the new one.
    h.sockets[0]!.dispatchEvent(new Event('error'));
    h.sockets[0]!.close(1011);
    expect(h.observed.onFatalError).not.toHaveBeenCalled();
    await h.stop();
  });

  it('backs off through token failures and setup timeouts without overflowing audio', async () => {
    const h = await recoveryHarness();
    h.provider.mockRejectedValueOnce(new Error('temporary token failure'));
    h.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.provider).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 120; i++) h.client.sendAudio(new Uint8Array([i, 0]).buffer);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.sockets[1]!.closeCode).toBe(1000);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    h.ready(2);
    await vi.advanceTimersByTimeAsync(0);
    const audio = h.sockets[2]!.sent.map(s => JSON.parse(s)).filter(m => m.realtimeInput?.audio);
    expect(audio).toHaveLength(100);
    expect(audio[0].realtimeInput.audio.data).toBe('FAA='); // oldest 20 chunks dropped
    expect(h.observed.onFatalError).not.toHaveBeenCalled();
    expect(h.observed.onConnectionReady).toHaveBeenLastCalledWith(2);
    await h.stop();
  });

  it('retries an established socket error even if no close event arrives', async () => {
    const h = await recoveryHarness();
    h.sockets[0]!.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(2_000);
    h.ready(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.connectionCount).toBe(2);
    await h.stop();
  });

  it('cancels a pending retry when stopped', async () => {
    const h = await recoveryHarness();
    h.sockets[0]!.close(1006);
    await h.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.provider).toHaveBeenCalledTimes(1);
  });

  it('does not reopen after stop while credential lookup is pending', async () => {
    const h = await recoveryHarness();
    let resolve!: (value: { type: 'ephemeral-token'; value: string }) => void;
    h.provider.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    h.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await h.stop();
    resolve({ type: 'ephemeral-token', value: 'late-token' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.observed.onFatalError).not.toHaveBeenCalled();
  });

  it('cancels in-progress setup immediately when stopped', async () => {
    const h = await recoveryHarness();
    h.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    await h.stop();
    h.sockets[1]!.open();
    h.sockets[1]!.message({ setupComplete: {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.connectionCount).toBe(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.observed.onFatalError).not.toHaveBeenCalled();
  });

  it('handles duplicate GoAway and close during graceful rotation only once', async () => {
    const h = await recoveryHarness();
    h.sockets[0]!.message({ goAway: { timeLeft: '5s' } });
    h.sockets[0]!.message({ goAway: { timeLeft: '5s' } });
    h.sockets[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(750);
    expect(h.sockets).toHaveLength(2);
    h.ready(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.connectionCount).toBe(2);
    await h.stop();
  });
});

async function recoveryHarness() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', { OPEN: 1, CLOSING: 2 });
  const sockets: MockWebSocket[] = [];
  const urls: string[] = [];
  let token = 0;
  const provider = vi.fn(async () => ({ type: 'ephemeral-token' as const, value: `token-${++token}` }));
  const observed = { ...callbacks(), onReconnecting: vi.fn() };
  const client = new GeminiLiveTranscriber({
    credential: provider,
    options: { ...DEFAULT_OPTIONS, customVocabulary: [] },
    callbacks: observed,
    dependencies: {
      createWebSocket: url => { const socket = new MockWebSocket(); sockets.push(socket); urls.push(url); return socket as unknown as WebSocket; },
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: timer => clearTimeout(timer),
    },
  });
  const ready = (index: number) => { sockets[index]!.open(); sockets[index]!.message({ setupComplete: {} }); };
  const starting = client.start();
  await vi.advanceTimersByTimeAsync(0);
  ready(0);
  await starting;
  return { client, sockets, urls, provider, observed, ready,
    stop: async () => { const stopping = client.stop(); await vi.advanceTimersByTimeAsync(900); await stopping; },
  };
}
