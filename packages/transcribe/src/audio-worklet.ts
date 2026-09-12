declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

interface ProcessorOptions {
  targetSampleRate?: number;
  framesPerChunk?: number;
}

class Pcm16Resampler extends AudioWorkletProcessor {
  readonly #targetSampleRate: number;
  readonly #chunkFrames: number;
  #phase = 0;
  #bucketTotal = 0;
  #bucketCount = 0;
  #chunk: Int16Array;
  #chunkOffset = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const processorOptions = (options.processorOptions ?? {}) as ProcessorOptions;
    this.#targetSampleRate = processorOptions.targetSampleRate ?? 16_000;
    this.#chunkFrames = processorOptions.framesPerChunk ?? 1_600;
    this.#chunk = new Int16Array(this.#chunkFrames);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    outputs[0]?.[0]?.fill(0);
    if (!channels || channels.length === 0) return true;
    const frameCount = channels[0]?.length ?? 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] ?? 0;
      mono /= channels.length;
      this.#bucketTotal += mono;
      this.#bucketCount += 1;
      this.#phase += this.#targetSampleRate;
      while (this.#phase >= sampleRate) {
        this.#emitSample(this.#bucketTotal / this.#bucketCount);
        this.#phase -= sampleRate;
        this.#bucketTotal = 0;
        this.#bucketCount = 0;
      }
    }
    return true;
  }

  #emitSample(value: number): void {
    const clamped = Math.max(-1, Math.min(1, value));
    this.#chunk[this.#chunkOffset] =
      clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    this.#chunkOffset += 1;
    if (this.#chunkOffset !== this.#chunkFrames) return;
    const completeChunk = this.#chunk;
    this.#chunk = new Int16Array(this.#chunkFrames);
    this.#chunkOffset = 0;
    this.port.postMessage(completeChunk.buffer, [completeChunk.buffer]);
  }
}

registerProcessor('weave-in-pcm16', Pcm16Resampler);
