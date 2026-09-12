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

When `languageCodes` selects Traditional Chinese (for example, `cmn-Hant-TW`) without Simplified Chinese (for example, `cmn-Hans-CN`), both providers' interim and finalized transcripts receive character-only Simplified-to-Traditional conversion before subscribers or queries see them. Chinese `Hant`/`Hans` script subtags take precedence over regional defaults (`TW`/`HK`/`MO` for Traditional, `CN`/`SG` for Simplified). Automatic detection, language selections without a Traditional Chinese preference, and selections containing both scripts leave the provider's script unchanged.

Conversion uses only the [OpenCC character dictionary](https://github.com/nk2028/opencc-js), bundled locally through `opencc-js`. Regional vocabulary is preserved: `软件` becomes `軟件`, not `軟體`. Ambiguous characters use the dictionary's first candidate without context; for example, `头发` becomes `頭發`. Phrase disambiguation and regional word replacement are intentionally excluded.

Sources are borrowed by default (`stop()` never ends WebRTC tracks); pass `owned: true` to have the session stop a track on stop. `start()`, `getTranscript()`, `waitForTranscript()`, and `stop()` return a `CommandResult` with stable codes instead of hidden fallbacks. The AudioWorklet ships as a same-origin asset so adopters can keep `script-src 'self'`.
