import { describe, expect, it, vi } from 'vitest';

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
