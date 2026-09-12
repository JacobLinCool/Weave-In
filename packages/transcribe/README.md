# @weave-in/transcribe

Headless, framework-agnostic live browser audio transcription. Audio tracks are mixed locally in one Web Audio graph, resampled to PCM16 in an AudioWorklet, and sent directly from the page to the selected provider: Gemini transcribe-live (16 kHz over WebSocket) or OpenAI live transcribe (24 kHz over WebRTC). Both accept a direct API key or a short-lived ephemeral token.

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

After an established Gemini connection closes or encounters a transport error, the client reconnects with exponential backoff (2 seconds, capped at 30 seconds). Each attempt calls the credential provider with `reason: 'rotation'` to obtain a fresh single-use token. Scheduled rotation and server `goAway` notices also reconnect. Initial setup errors still reject `start()`.

During recovery the session reports `starting`, retains finalized transcripts and microphone sources, and buffers the latest 100 unsent PCM chunks (10 seconds at the default format). Older buffered audio is dropped during longer outages; audio already sent but not finalized by the old server session is not replayed. Recovery starts a fresh provider session, not a server-side context resume. Calling `stop()` cancels retries and prevents late credential responses from reopening the connection.
