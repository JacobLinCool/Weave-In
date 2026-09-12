# @weave-in/transcribe

OpenAI uses native WebSocket PCM streaming and manual commits because `gpt-live-transcribe` does not support server VAD. All PCM, including low-volume audio, is sent; commits occur after an 800 ms pause detected at RMS 0.005. Continuous speech is not cut at fixed intervals, so a quoted phrase cannot become an independent approval command just because it crosses a timer boundary. Transcription uses `minimal` delay. Stop and connection rotation wait for outstanding final transcripts for up to 5 seconds; failures or a finalization timeout are reported visibly instead of silently discarding the last turn. Duplicate completion events are ignored, and parallel stop calls share the same drain. These boundaries should be evaluated with representative microphones and speech, including quiet speech and approval phrases.

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

When `languageCodes` selects Traditional Chinese (for example, `cmn-Hant-TW`) without Simplified Chinese (for example, `cmn-Hans-CN`), both providers' interim and finalized transcripts receive character-only Simplified-to-Traditional conversion before subscribers or queries see them. Chinese `Hant`/`Hans` script subtags take precedence over regional defaults (`TW`/`HK`/`MO` for Traditional, `CN`/`SG` for Simplified). Automatic detection, language selections without a Traditional Chinese preference, and selections containing both scripts leave the provider's script unchanged.

Conversion uses only the [OpenCC character dictionary](https://github.com/nk2028/opencc-js), bundled locally through `opencc-js`. Regional vocabulary is preserved: `软件` becomes `軟件`, not `軟體`. Ambiguous characters use the dictionary's first candidate without context; for example, `头发` becomes `頭發`. Phrase disambiguation and regional word replacement are intentionally excluded.

Sources are borrowed by default (`stop()` never ends WebRTC tracks); pass `owned: true` to have the session stop a track on stop. `start()`, `getTranscript()`, `waitForTranscript()`, and `stop()` return a `CommandResult` with stable codes instead of hidden fallbacks. The AudioWorklet ships as a same-origin asset so adopters can keep `script-src 'self'`.

OpenAI rotation and stop commit any remaining audio and wait for all outstanding transcription completions before closing the connection, including commits whose item IDs have not arrived yet. Rotation reports `starting` while new audio is buffered. Finalized text waiting for an earlier segment remains visible in the interim transcript until it can be published in order. Finalization is bounded to five seconds: a timeout or a transcription failure reports an explicit error and stops the session instead of silently discarding a segment or blocking later text indefinitely. A finalization error during `stop()` is also returned as a failed `CommandResult`; already published segments remain available.

After an established Gemini connection closes or encounters a transport error, the client reconnects with exponential backoff (2 seconds, capped at 30 seconds). Each attempt calls the credential provider with `reason: 'rotation'` to obtain a fresh single-use token. Scheduled rotation and server `goAway` notices also reconnect. Initial setup errors still reject `start()`.

During recovery the session reports `starting`, retains finalized transcripts and microphone sources, and buffers the latest 100 unsent PCM chunks (10 seconds at the default format). Older buffered audio is dropped during longer outages; audio already sent but not finalized by the old server session is not replayed. Recovery starts a fresh provider session, not a server-side context resume. Calling `stop()` cancels retries and prevents late credential responses from reopening the connection.
