import type { AudioSourceOptions } from './contracts';
import { TranscribeError } from './errors';

const WORKLET_NAME = 'weave-in-pcm16';

type AudioInput = MediaStream | MediaStreamTrack;

export interface PcmAudioFormat {
  sampleRate: number;
  framesPerChunk: number;
}

interface AttachedTrack {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
}

interface SourceRecord {
  id: string;
  gain: number;
  owned: boolean;
  tracks: Map<MediaStreamTrack, AttachedTrack | null>;
  endedListeners: Map<MediaStreamTrack, () => void>;
}

export interface AudioMixerDependencies {
  createAudioContext(): AudioContext;
  createMediaStream(tracks: MediaStreamTrack[]): MediaStream;
  createWorkletNode(
    context: AudioContext,
    name: string,
    format: PcmAudioFormat,
  ): AudioWorkletNode;
  randomUUID(): string;
}

const DEFAULT_DEPENDENCIES: AudioMixerDependencies = {
  createAudioContext: () => new AudioContext({ latencyHint: 'interactive' }),
  createMediaStream: (tracks) => new MediaStream(tracks),
  createWorkletNode: (context, name, format) =>
    new AudioWorkletNode(context, name, {
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        targetSampleRate: format.sampleRate,
        framesPerChunk: format.framesPerChunk,
      },
    }),
  randomUUID: () => crypto.randomUUID(),
};

export class AudioMixer {
  readonly #workletUrl: string;
  readonly #dependencies: AudioMixerDependencies;
  readonly #sources = new Map<string, SourceRecord>();
  readonly #onSourcesChanged: (count: number) => void;
  readonly #onEmptyWhileRunning: () => void;
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #worklet: AudioWorkletNode | null = null;
  #mutedOutput: GainNode | null = null;
  #running = false;

  constructor(args: {
    workletUrl: string;
    dependencies?: AudioMixerDependencies;
    onSourcesChanged?: (count: number) => void;
    onEmptyWhileRunning?: () => void;
  }) {
    this.#workletUrl = args.workletUrl;
    this.#dependencies = args.dependencies ?? DEFAULT_DEPENDENCIES;
    this.#onSourcesChanged = args.onSourcesChanged ?? (() => undefined);
    this.#onEmptyWhileRunning = args.onEmptyWhileRunning ?? (() => undefined);
  }

  get sourceCount(): number {
    return [...this.#sources.values()].filter((source) => hasLiveTrack(source)).length;
  }

  addSource(input: AudioInput, options: AudioSourceOptions = {}): string {
    const tracks = audioTracks(input);
    if (tracks.length === 0) {
      throw new TranscribeError('NO_AUDIO_TRACK', 'The supplied source has no live audio track.');
    }
    const id = options.id?.trim() || this.#dependencies.randomUUID();
    if (this.#sources.has(id)) {
      throw new TranscribeError('DUPLICATE_AUDIO_SOURCE', `Audio source "${id}" already exists.`);
    }
    const gain = options.gain ?? 1;
    if (!Number.isFinite(gain) || gain < 0 || gain > 4) {
      throw new TranscribeError('INVALID_SOURCE_GAIN', 'Audio source gain must be between 0 and 4.');
    }
    const record: SourceRecord = {
      id,
      gain,
      owned: options.owned ?? false,
      tracks: new Map(),
      endedListeners: new Map(),
    };
    for (const track of tracks) {
      record.tracks.set(track, null);
      const ended = (): void => this.#handleTrackEnded(record, track);
      record.endedListeners.set(track, ended);
      track.addEventListener('ended', ended, { once: true });
    }
    this.#sources.set(id, record);
    if (this.#running) this.#attachRecord(record);
    this.#emitSourceCount();
    return id;
  }

  removeSource(id: string): boolean {
    const record = this.#sources.get(id);
    if (!record) return false;
    this.#releaseRecord(record, record.owned);
    this.#sources.delete(id);
    this.#emitSourceCount();
    if (this.#running && this.sourceCount === 0) this.#onEmptyWhileRunning();
    return true;
  }

  async startPcm(
    onPcm: (chunk: ArrayBuffer) => void,
    format: PcmAudioFormat,
  ): Promise<void> {
    if (this.#running) return;
    await this.#startGraph(async (context, master) => {
      validatePcmFormat(format);
      await context.audioWorklet.addModule(this.#workletUrl);
      const worklet = this.#dependencies.createWorkletNode(context, WORKLET_NAME, format);
      const mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      master.connect(worklet).connect(mutedOutput).connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) onPcm(event.data);
      };
      this.#worklet = worklet;
      this.#mutedOutput = mutedOutput;
    });
  }

  async stop(): Promise<void> {
    const context = this.#context;
    this.#running = false;
    for (const record of [...this.#sources.values()]) {
      if (record.owned) {
        this.#releaseRecord(record, true);
        this.#sources.delete(record.id);
      } else {
        this.#disconnectRecord(record);
      }
    }
    if (context) await this.#closeGraph(context);
    this.#emitSourceCount();
  }

  async destroy(): Promise<void> {
    await this.stop();
    for (const record of this.#sources.values()) this.#releaseRecord(record, false);
    this.#sources.clear();
    this.#emitSourceCount();
  }

  async #startGraph(
    configureOutput: (context: AudioContext, master: GainNode) => void | Promise<void>,
  ): Promise<void> {
    if (this.sourceCount === 0) {
      throw new TranscribeError('NO_ACTIVE_AUDIO', 'Add at least one live audio source before starting.');
    }
    const context = this.#dependencies.createAudioContext();
    const master = context.createGain();
    this.#context = context;
    this.#master = master;
    try {
      await configureOutput(context, master);
      this.#running = true;
      for (const record of this.#sources.values()) this.#attachRecord(record);
      if (context.state !== 'running') await context.resume();
      if (context.state !== 'running') {
        throw new TranscribeError(
          'USER_GESTURE_REQUIRED',
          'The browser requires a user gesture before audio processing can start.',
        );
      }
    } catch (error) {
      await this.#closeGraph(context);
      throw error;
    }
  }

  #attachRecord(record: SourceRecord): void {
    const context = this.#context;
    const master = this.#master;
    if (!context || !master) return;
    for (const [track, attached] of record.tracks) {
      if (attached || track.readyState !== 'live') continue;
      const media = this.#dependencies.createMediaStream([track]);
      const source = context.createMediaStreamSource(media);
      const gain = context.createGain();
      gain.gain.value = record.gain;
      source.connect(gain).connect(master);
      record.tracks.set(track, { source, gain });
    }
  }

  #disconnectRecord(record: SourceRecord): void {
    for (const [track, attached] of record.tracks) {
      attached?.source.disconnect();
      attached?.gain.disconnect();
      record.tracks.set(track, null);
    }
  }

  #releaseRecord(record: SourceRecord, stopTracks: boolean): void {
    this.#disconnectRecord(record);
    for (const track of record.tracks.keys()) {
      const listener = record.endedListeners.get(track);
      if (listener) track.removeEventListener('ended', listener);
      if (stopTracks && track.readyState === 'live') track.stop();
    }
    record.tracks.clear();
    record.endedListeners.clear();
  }

  #handleTrackEnded(record: SourceRecord, track: MediaStreamTrack): void {
    const attached = record.tracks.get(track);
    attached?.source.disconnect();
    attached?.gain.disconnect();
    record.tracks.delete(track);
    record.endedListeners.delete(track);
    if (record.tracks.size === 0) this.#sources.delete(record.id);
    this.#emitSourceCount();
    if (this.#running && this.sourceCount === 0) this.#onEmptyWhileRunning();
  }

  async #closeGraph(context: AudioContext): Promise<void> {
    for (const record of this.#sources.values()) this.#disconnectRecord(record);
    this.#worklet?.disconnect();
    this.#master?.disconnect();
    this.#mutedOutput?.disconnect();
    this.#worklet = null;
    this.#master = null;
    this.#mutedOutput = null;
    this.#context = null;
    this.#running = false;
    if (context.state !== 'closed') await context.close();
  }

  #emitSourceCount(): void {
    this.#onSourcesChanged(this.sourceCount);
  }
}

function validatePcmFormat(format: PcmAudioFormat): void {
  if (
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 48_000 ||
    !Number.isInteger(format.framesPerChunk) ||
    format.framesPerChunk < 80 ||
    format.framesPerChunk > format.sampleRate
  ) {
    throw new TranscribeError('INVALID_PCM_FORMAT', 'The transcription provider requested an invalid PCM format.');
  }
}

function audioTracks(input: AudioInput): MediaStreamTrack[] {
  if (isMediaStream(input)) return input.getAudioTracks().filter((track) => track.readyState === 'live');
  if (input.kind !== 'audio' || input.readyState !== 'live') return [];
  return [input];
}

function isMediaStream(input: AudioInput): input is MediaStream {
  return 'getAudioTracks' in input && typeof input.getAudioTracks === 'function';
}

function hasLiveTrack(source: SourceRecord): boolean {
  return [...source.tracks.keys()].some((track) => track.readyState === 'live');
}
