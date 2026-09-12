import { calculateVoiceLevel } from '../voice-activity';

export class AgentAudio {
  readonly context = new AudioContext({ latencyHint: 'interactive' });
  #stops = new Set<() => void>();
  async enable(): Promise<void> {
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('Allow audio playback on this device, then try again.');
  }
  silence(): { track: MediaStreamTrack; stop(): void } {
    // GPT-Live needs a running audio clock even for typed requests and after the owner stops talking.
    const source = this.context.createConstantSource();
    source.offset.value = 0;
    const destination = this.context.createMediaStreamDestination();
    source.connect(destination); source.start();
    const track = destination.stream.getAudioTracks()[0]!;
    return { track, stop: () => { source.stop(); source.disconnect(); track.stop(); } };
  }
  attach(stream: MediaStream, allowed: () => boolean, onLevel: (level: number, playing: boolean) => void = () => undefined, onError: (message: string) => void = () => undefined): { output: MediaStream; stop(): void } {
    // Chromium may leave incoming RTP queued until a media element starts its receiver.
    // This element is always muted; only the permission-gated Web Audio graph is audible.
    const receiver = new Audio(); receiver.muted = true; receiver.srcObject = stream;
    const source = this.context.createMediaStreamSource(stream);
    const gate = this.context.createGain();
    gate.gain.value = 0;
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 256;
    const destination = this.context.createMediaStreamDestination();
    source.connect(analyser);
    source.connect(gate);
    gate.connect(this.context.destination);
    gate.connect(destination);
    const samples = new Uint8Array(analyser.fftSize);
    let level = 0;
    let stopped = false;
    void receiver.play().catch(() => { if (!stopped) onError('Audio playback was blocked. Enable assistant audio and retry.'); });
    const timer = setInterval(() => {
      const playing = allowed() && this.context.state === 'running';
      gate.gain.value = playing ? 1 : 0;
      analyser.getByteTimeDomainData(samples);
      level = calculateVoiceLevel(samples, level);
      onLevel(level, playing);
    }, 50);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      gate.gain.value = 0;
      clearInterval(timer);
      receiver.pause(); receiver.srcObject = null;
      source.disconnect(); gate.disconnect(); analyser.disconnect();
      destination.stream.getTracks().forEach((track) => track.stop());
      this.#stops.delete(stop);
    };
    this.#stops.add(stop);
    return { output: destination.stream, stop };
  }
  close(): void { for (const stop of this.#stops) stop(); void this.context.close(); }
}
