import { describe, expect, it, vi } from 'vitest';

import type { AudioSourceOptions, CredentialInput } from '../src/contracts';
import {
  TranscriptionSession,
  type SessionAudioMixer,
} from '../src/session';
import type { LiveTranscriber, LiveTranscriptionCallbacks } from '../src/transcriber';

class FakeMixer implements SessionAudioMixer {
  sourceCount = 0;
  readonly owned = new Set<string>();
  readonly removed: string[] = [];
  started = false;
  destroyed = false;
  audioFormat: { sampleRate: number; framesPerChunk: number } | null = null;
  #next = 0;

  addSource(_input: MediaStream | MediaStreamTrack, options: AudioSourceOptions = {}): string {
    const id = options.id ?? `source-${++this.#next}`;
    this.sourceCount += 1;
    if (options.owned) this.owned.add(id);
    return id;
  }

  removeSource(id: string): boolean {
    if (this.sourceCount === 0) return false;
    this.sourceCount -= 1;
    this.removed.push(id);
    this.owned.delete(id);
    return true;
  }

  async startPcm(
    _onPcm: (chunk: ArrayBuffer) => void,
    format: { sampleRate: number; framesPerChunk: number },
  ): Promise<void> {
    this.started = true;
    this.audioFormat = format;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.sourceCount -= this.owned.size;
    this.owned.clear();
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.sourceCount = 0;
    this.destroyed = true;
  }
}

describe('TranscriptionSession', () => {
  it('shares idempotent state between start, transcript reads, and stop', async () => {
    const mixer = new FakeMixer();
    let callbacks: LiveTranscriptionCallbacks | undefined;
    const transport: LiveTranscriber = {
      audioFormat: { sampleRate: 24_000, framesPerChunk: 2_400 },
      start: vi.fn(async () => callbacks?.onConnectionReady(1)),
      sendAudio: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const session = new TranscriptionSession({
      workletUrl: 'worklet.js',
      credential: { type: 'api-key', value: 'key' },
      mixer,
      dependencies: {
        randomUUID: () => 'session-1',
        createTranscriber: (args) => {
          callbacks = args.callbacks;
          return transport;
        },
      },
    });
    session.addAudioSource(fakeTrack(), { id: 'borrowed' });
    expect((await session.start({ provider: 'openai' })).code).toBe('TRANSCRIPTION_STARTED');
    expect(mixer.audioFormat).toEqual({ sampleRate: 24_000, framesPerChunk: 2_400 });
    expect(session.getState().options.provider).toBe('openai');
    expect((await session.start()).code).toBe('ALREADY_RUNNING');
    callbacks?.onFinal('A retained thought.', 1);
    expect(session.getTranscript().data?.segments[0]?.text).toBe('A retained thought.');
    callbacks?.onReconnecting?.();
    expect(session.getState().status).toBe('starting');
    expect(mixer.started).toBe(true);
    expect(transport.stop).not.toHaveBeenCalled();
    expect(session.getTranscript().data?.segments[0]?.text).toBe('A retained thought.');
    callbacks?.onConnectionReady(2);
    expect(session.getState().status).toBe('transcribing');
    expect(session.getState().sessionId).toBe('session-1');
    expect(session.getState().connectionCount).toBe(2);
    expect((await session.stop()).code).toBe('TRANSCRIPTION_STOPPED');
    expect(session.getTranscript().data?.segments).toHaveLength(1);
    expect(mixer.sourceCount).toBe(1);
  });

  it('reports missing credentials/audio, honors AbortSignal, and destroys owned resources', async () => {
    const mixer = new FakeMixer();
    const session = new TranscriptionSession({ workletUrl: 'worklet.js', mixer });
    expect((await session.start()).code).toBe('MISSING_CREDENTIAL');
    session.setCredential(async () => ({ type: 'ephemeral-token', value: 'token' }));
    expect((await session.start()).code).toBe('NO_ACTIVE_AUDIO');
    session.addAudioSource(fakeTrack(), { id: 'owned', owned: true });
    const controller = new AbortController();
    controller.abort();
    expect((await session.start(undefined, controller.signal)).code).toBe('ABORTED');
    await session.destroy();
    expect(mixer.destroyed).toBe(true);
    expect(() => session.setCredential({ type: 'api-key', value: 'key' })).toThrow(/destroyed/u);
  });

  it('waits for the next finalized segment and supports cancellation', async () => {
    const mixer = new FakeMixer();
    let callbacks: LiveTranscriptionCallbacks | undefined;
    const session = new TranscriptionSession({
      workletUrl: 'worklet.js',
      credential: { type: 'api-key', value: 'key' },
      mixer,
      dependencies: {
        randomUUID: () => 'session-wait',
        createTranscriber: (args) => {
          callbacks = args.callbacks;
          return {
            audioFormat: { sampleRate: 16_000, framesPerChunk: 1_600 },
            async start() { callbacks?.onConnectionReady(1); },
            sendAudio() {},
            async stop() {},
          };
        },
      },
    });
    session.addAudioSource(fakeTrack());
    await session.start();

    const nextSegment = session.waitForTranscript({ afterSegmentId: 0, waitMs: 1_000 });
    callbacks?.onFinal('An immediate meeting thought.', 1);
    await expect(nextSegment).resolves.toMatchObject({
      ok: true,
      data: { cursor: 1, segments: [{ text: 'An immediate meeting thought.' }] },
    });

    const controller = new AbortController();
    const cancelled = session.waitForTranscript(
      { afterSegmentId: 1, waitMs: 1_000 },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false, code: 'ABORTED' });
    await session.destroy();
  });
});

function fakeTrack(): MediaStreamTrack {
  return {} as MediaStreamTrack;
}

void (null as CredentialInput | null);
