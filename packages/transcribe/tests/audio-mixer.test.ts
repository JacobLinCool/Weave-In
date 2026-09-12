import { describe, expect, it, vi } from 'vitest';

import { AudioMixer, type AudioMixerDependencies } from '../src/audio-mixer';

class FakeTrack extends EventTarget {
  readonly kind = 'audio';
  readyState: MediaStreamTrackState = 'live';
  stopCount = 0;

  stop(): void {
    this.stopCount += 1;
    this.readyState = 'ended';
  }

  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  disconnectCount = 0;

  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node);
    return node;
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.connections.length = 0;
  }
}

class FakeGainNode extends FakeNode {
  readonly gain = { value: 1 };
}

class FakeWorkletNode extends FakeNode {
  readonly port = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null };
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  readonly destination = new FakeNode();
  readonly moduleUrls: string[] = [];
  readonly mediaSources: FakeNode[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly audioWorklet = {
    addModule: async (url: string) => {
      this.moduleUrls.push(url);
    },
  };

  createGain(): GainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node as unknown as GainNode;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    const node = new FakeNode();
    this.mediaSources.push(node);
    return node as unknown as MediaStreamAudioSourceNode;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

describe('AudioMixer', () => {
  it('mixes sources added before and during a session and preserves borrowed tracks', async () => {
    const graph = graphDependencies();
    const sourceCounts: number[] = [];
    const pcm = vi.fn();
    const mixer = new AudioMixer({
      workletUrl: 'https://site.example/audio-worklet.js',
      dependencies: graph.dependencies,
      onSourcesChanged: (count) => sourceCounts.push(count),
    });
    const first = new FakeTrack();
    const second = new FakeTrack();
    const third = new FakeTrack();
    mixer.addSource(first as unknown as MediaStreamTrack, { id: 'first', gain: 0.5 });
    mixer.addSource(second as unknown as MediaStreamTrack, { id: 'second' });
    await mixer.startPcm(pcm, { sampleRate: 24_000, framesPerChunk: 2_400 });

    expect(graph.context.moduleUrls).toEqual(['https://site.example/audio-worklet.js']);
    expect(graph.context.mediaSources).toHaveLength(2);
    expect(graph.context.gains.some((gain) => gain.gain.value === 0.5)).toBe(true);
    mixer.addSource(third as unknown as MediaStreamTrack, { id: 'third', gain: 1.5 });
    expect(graph.context.mediaSources).toHaveLength(3);
    expect(graph.context.gains.some((gain) => gain.gain.value === 1.5)).toBe(true);

    const chunk = new Uint8Array([1, 2, 3]).buffer;
    graph.worklet.port.onmessage?.(new MessageEvent('message', { data: chunk }));
    expect(pcm).toHaveBeenCalledWith(chunk);
    expect(mixer.removeSource('second')).toBe(true);
    expect(second.stopCount).toBe(0);
    await mixer.stop();
    expect(first.stopCount).toBe(0);
    expect(third.stopCount).toBe(0);
    expect(mixer.sourceCount).toBe(2);
    expect(sourceCounts).toContain(3);
    await mixer.destroy();
    expect(first.stopCount).toBe(0);
    expect(third.stopCount).toBe(0);
    expect(mixer.sourceCount).toBe(0);
  });

  it('stops owned tracks and reports when every live source ends', async () => {
    const graph = graphDependencies();
    const onEmpty = vi.fn();
    const mixer = new AudioMixer({
      workletUrl: 'worklet.js',
      dependencies: graph.dependencies,
      onEmptyWhileRunning: onEmpty,
    });
    const owned = new FakeTrack();
    const borrowed = new FakeTrack();
    mixer.addSource(owned as unknown as MediaStreamTrack, { id: 'owned', owned: true });
    mixer.addSource(borrowed as unknown as MediaStreamTrack, { id: 'borrowed' });
    await mixer.startPcm(() => undefined, { sampleRate: 16_000, framesPerChunk: 1_600 });
    expect(mixer.removeSource('owned')).toBe(true);
    expect(owned.stopCount).toBe(1);
    expect(onEmpty).not.toHaveBeenCalled();
    borrowed.end();
    expect(onEmpty).toHaveBeenCalledOnce();
    expect(mixer.sourceCount).toBe(0);
  });
});

function graphDependencies(): {
  context: FakeAudioContext;
  worklet: FakeWorkletNode;
  dependencies: AudioMixerDependencies;
} {
  const context = new FakeAudioContext();
  const worklet = new FakeWorkletNode();
  let sourceId = 0;
  return {
    context,
    worklet,
    dependencies: {
      createAudioContext: () => context as unknown as AudioContext,
      createMediaStream: (tracks) => ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
      createWorkletNode: () => worklet as unknown as AudioWorkletNode,
      randomUUID: () => `source-${++sourceId}`,
    },
  };
}
