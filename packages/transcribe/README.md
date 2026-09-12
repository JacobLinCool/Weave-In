# @weave-in/transcribe

OpenAI uses manual turn commits because `gpt-live-transcribe` does not support server VAD. The PCM stream ends a turn after 800 ms below an RMS level of 0.005, skips leading silence, and flushes remaining speech on stop or connection rotation. A final transcript that misses the bounded stop/rotation drain window is discarded; unfinished text is never marked final and cannot block the next connection. Calibrate these constants against representative microphones and background noise before production use.

Headless, framework-agnostic live browser audio transcription. Audio tracks are mixed locally in one Web Audio graph, resampled to PCM16 in an AudioWorklet, and sent directly from the page to the selected provider: Gemini transcribe-live (16 kHz over WebSocket) or OpenAI live transcribe (24 kHz over WebSocket). Both accept a direct API key or a short-lived ephemeral token.

```ts
import { createTranscription } from '@weave-in/transcribe';

const transcription = createTranscription({
  credential: async () => ({ type: 'ephemeral-token', value: await fetchToken() }),
  options: { provider: 'gemini', languageCodes: ['en-US', 'cmn-Hant-TW'], mode: 'VERBATIM' },
});
transcription.addAudioSource(microphoneTrack);
transcription.subscribe((state) => render(state.segments, state.interim));
await transcription.start();
await transcription.stop();
await transcription.destroy();
```

Sources are borrowed by default (`stop()` never ends WebRTC tracks); pass `owned: true` to have the session stop a track on stop. `start()`, `getTranscript()`, `waitForTranscript()`, and `stop()` return a `CommandResult` with stable codes instead of hidden fallbacks. The AudioWorklet ships as a same-origin asset so adopters can keep `script-src 'self'`.
