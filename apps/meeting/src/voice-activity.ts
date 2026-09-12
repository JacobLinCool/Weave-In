const ANALYSIS_SIZE = 256;
const NOISE_FLOOR = 0.018;
const SPEECH_CEILING = 0.16;
const ATTACK = 0.42;
const RELEASE = 0.14;

interface SharedAudioContext {
  context: AudioContext;
  observers: number;
}

let sharedAudioContext: SharedAudioContext | null = null;

export function calculateVoiceLevel(samples: Uint8Array, previousLevel: number): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const normalized = clamp((rms - NOISE_FLOOR) / (SPEECH_CEILING - NOISE_FLOOR), 0, 1);
  const response = normalized > previousLevel ? ATTACK : RELEASE;
  const next = previousLevel + (normalized - previousLevel) * response;
  return next < 0.005 ? 0 : next;
}

export function observeVoiceActivity(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  if (track.kind !== 'audio') throw new TypeError('Voice activity requires an audio track.');
  const context = acquireAudioContext();
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(new MediaStream([track]));
    analyser = context.createAnalyser();
    analyser.fftSize = ANALYSIS_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
  } catch (cause) {
    releaseAudioContext(context);
    throw cause;
  }

  if (context.state === 'suspended') {
    void context.resume().catch((cause: unknown) => {
      console.warn('[Weave In] Voice activity monitor could not resume.', cause);
    });
  }

  const samples = new Uint8Array(analyser.fftSize);
  let animationFrame = 0;
  let level = 0;
  let stopped = false;

  const sample = (): void => {
    analyser.getByteTimeDomainData(samples);
    level = calculateVoiceLevel(samples, level);
    onLevel(level);
    animationFrame = window.requestAnimationFrame(sample);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    window.cancelAnimationFrame(animationFrame);
    track.removeEventListener('ended', stop);
    source.disconnect();
    analyser.disconnect();
    onLevel(0);
    releaseAudioContext(context);
  };

  track.addEventListener('ended', stop, { once: true });
  animationFrame = window.requestAnimationFrame(sample);
  return stop;
}

function acquireAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.context.state === 'closed') {
    sharedAudioContext = {
      context: new AudioContext({ latencyHint: 'interactive' }),
      observers: 0,
    };
  }
  sharedAudioContext.observers += 1;
  return sharedAudioContext.context;
}

function releaseAudioContext(context: AudioContext): void {
  if (!sharedAudioContext || sharedAudioContext.context !== context) return;
  sharedAudioContext.observers = Math.max(0, sharedAudioContext.observers - 1);
  if (sharedAudioContext.observers !== 0) return;
  sharedAudioContext = null;
  void context.close().catch((cause: unknown) => {
    console.warn('[Weave In] Voice activity monitor could not close cleanly.', cause);
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
