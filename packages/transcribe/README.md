# @weave-in/transcribe

Headless browser audio transcription for Gemini and OpenAI. The package mixes caller-supplied audio tracks in one Web Audio graph, converts them to mono PCM16 in an AudioWorklet, and streams them directly from the page to the selected provider over WebSocket. It keeps transcript state in memory and does not write browser storage or provide a credential server, meeting transport, or UI.

This is a private workspace package. Its public entry point is `@weave-in/transcribe`; `@weave-in/transcribe/adapter` exposes lower-level sessions, provider clients, the mixer, store, and dependency injection interfaces for integrations and tests. The [meeting app](../../apps/meeting/README.md) supplies the credential service and meeting experience.

## Browser usage

Call audio setup from a user gesture in a secure browser context with Web Audio, AudioWorklet, MediaStream, and WebSocket support. The caller obtains permission and supplies live audio tracks; the library does not call `getUserMedia()`.

```ts
import { createTranscription, type TranscriptState } from '@weave-in/transcribe';

// fetchToken mints a new Gemini token through your app's credential service.
export async function startCaptions(
  fetchToken: () => Promise<string>,
  render: (state: TranscriptState) => void,
) {
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
  const transcription = createTranscription({
    credential: async () => ({ type: 'ephemeral-token', value: await fetchToken() }),
    options: { provider: 'gemini', languageCodes: ['en-US', 'cmn-Hant-TW'] },
  });
  transcription.addAudioSource(microphone, { owned: true });
  const unsubscribe = transcription.subscribe(render);
  const started = await transcription.start();
  if (!started.ok) {
    await transcription.destroy();
    throw new Error(`${started.code}: ${started.message}`);
  }

  // Call when the user finishes. Consume stop's result before disposing state.
  return async () => {
    const stopped = await transcription.stop();
    const finalState = transcription.getState();
    unsubscribe();
    await transcription.destroy();
    return { stopped, finalState };
  };
}
```

The build emits `audio-worklet.js` beside the ESM entry points. `createTranscription()` resolves it with `new URL('./audio-worklet.js?no-inline', import.meta.url)` so Vite emits a separate same-origin asset. Other bundlers must preserve or emit that asset too. It is also exported as `@weave-in/transcribe/audio-worklet.js`; integrations using `TranscriptionSession` from `/adapter` supply their own `workletUrl`. The worklet requires no blob script or inline script, so it is compatible with `script-src 'self'`. The host must allow the selected provider in its connection policy.

## Options and credentials

| Option | Default | Implemented behavior |
| --- | --- | --- |
| `provider` | `'gemini'` | `'gemini'` or `'openai'`. There is no provider fallback. |
| `languageCodes` | `[]` | An empty list requests automatic detection. Up to five trimmed, distinct language tags matching the package's BCP-47-style syntax are accepted. |
| `mode` | `'VERBATIM'` | `'VERBATIM'` or `'SMART'`; sent as Gemini's mode or an OpenAI transcription prompt. |
| `customVocabulary` | `[]` | Up to 100 input strings, each at most 100 UTF-16 code units after trimming. Empty entries and duplicates are removed. OpenAI also rejects angle brackets and line breaks. |

Constructor options are the base for each run. `start(overrides)` merges that run's overrides with the constructor options; overrides do not become defaults for later runs. Invalid constructor options throw `TranscribeError`; invalid start overrides return a failed `CommandResult`.

Both providers accept `{ type: 'api-key', value }`, `{ type: 'ephemeral-token', value }`, or an async credential provider receiving `{ reason, connection, provider }`. `reason` is `'initial'` on the first connection and `'rotation'` for later connections, including Gemini recovery attempts. `connection` is the next one-based successful connection number, so failed attempts may reuse the same number. Use a credential function to obtain fresh tokens; a literal credential is reused unchanged on every connection. `setCredential()` and `clearCredential()` affect the next `start()`, while an active provider client retains the credential input it was created with.

## Session API and ownership

| Method | Result and lifecycle |
| --- | --- |
| `addAudioSource(streamOrTrack, options?)` | Returns a source ID. A stream contributes its live audio tracks at registration time. `gain` is 0–4, default 1; `owned` defaults to false. |
| `removeAudioSource(id)` | Returns whether the source existed. Removing an owned source stops its tracks. |
| `subscribe(listener)` | Calls the listener immediately with a snapshot, then on state changes; returns an unsubscribe function. |
| `getState()` | Returns a copied `TranscriptState`, including interim text, retained segments, effective run options, and lifecycle/error metadata. |
| `start(overrides?, signal?)` | Returns `Promise<CommandResult<SessionSummary>>`; requires a credential and at least one live audio source. |
| `getTranscript(query?)` | Returns `CommandResult<TranscriptQueryResult>` with cursor-based finalized text and optional interim text. |
| `waitForTranscript(query?, signal?)` | Returns the same query shape asynchronously, with an optional bounded wait for finalized text or lifecycle changes. |
| `stop()` | Returns `Promise<CommandResult<SessionSummary>>`. Concurrent stop calls share the operation. Retained transcript remains readable. |
| `destroy()` | Returns `Promise<void>`; stops the session, releases sources/listeners/credentials, and ends the instance's usable lifecycle. Repeated calls through the public facade share the operation. |

Sources are borrowed by default: stopping an active session closes the audio graph but leaves borrowed tracks live and registered for a later start. `owned: true` stops and removes the source when the active session releases audio resources, or on source removal or destruction. `stop()` with no active session returns `ALREADY_STOPPED`; use `removeAudioSource()` or `destroy()` to release owned sources registered before a start. Destroying also unregisters borrowed sources without stopping their tracks. Sources can be added or removed while running. If the final source ends or is removed during transcription, the session reports `NO_ACTIVE_AUDIO` and stops its active resources.

A new run clears the previous transcript, resets segment IDs to 1, and assigns a new `sessionId`. Provider reconnections preserve the current session ID, retained segments, and sources. Normal status transitions are `idle` → `starting` → `transcribing` → `stopping` → `stopped`; reconnection returns to `starting`, and fatal failures enter `error`. Calling `start()` while starting or transcribing returns `ALREADY_RUNNING` without changing options. Await lifecycle operations before starting another run.

`start()`, `getTranscript()`, `waitForTranscript()`, and `stop()` report operational outcomes through `{ ok, code, message, data? }`. Check `ok` before using `data`; query results also carry session errors in `data.error`. Codes include `MISSING_CREDENTIAL`, `NO_ACTIVE_AUDIO`, `ABORTED`, and `DESTROYED`, plus provider-specific setup, connection, and finalization failures. Synchronous configuration/source methods can throw `TranscribeError`. Subscribers receive error state so the host can display failures.

## Transcript queries

Segments carry `{ id, text, receivedAt, connection }`. `receivedAt` is the local receipt time, not an audio timestamp. Provider output is whitespace-normalized and split into segments of at most 256 UTF-16 code units, preserving surrogate pairs. A segment is a storage unit, not a speaker turn or approval boundary.

| Query field | Behavior |
| --- | --- |
| `afterSegmentId` | Return IDs strictly greater than this cursor; defaults to 0. |
| `maxChars` | Finalized-text budget, clamped to 256–50,000 UTF-16 code units; defaults to 50,000. Only whole segments are returned. |
| `includeInterim` | Defaults to true. Interim text is returned separately and is outside the finalized-text budget. |
| `waitMs` | Only for `waitForTranscript()`: 0–30,000 ms, default 0. |

Advance with the returned `cursor` until `hasMore` is false; `latestSegmentId` identifies the most recent finalized segment even if the current page does not reach it. Keep the cursor with its `sessionId`, since a new run resets IDs. The store retains at most 500,000 finalized UTF-16 code units and evicts oldest segments. `droppedSegments` counts evictions; `historyTruncated` indicates the requested cursor predates retained history.

Waiting returns immediately when matching finalized segments already exist or the session is no longer starting/transcribing. Otherwise it wakes on a new finalized segment, relevant lifecycle change, timeout, or cancellation. Interim-only updates do not wake a waiting query; use `subscribe()` for live interim rendering. A timeout returns the current query result, and cancellation returns `ABORTED`.

## Provider behavior

| Behavior | Gemini | OpenAI |
| --- | --- | --- |
| Configured model | `gemini-3.5-transcribe-live` | `gpt-live-transcribe` |
| Audio | 16 kHz PCM16, 1,600 frames per chunk | 24 kHz PCM16, 2,400 frames per chunk |
| Setup | `setup` / `setupComplete`, 15-second timeout | `session.update` / `session.updated`, 15-second timeout |
| Language/vocabulary hints | Original language tags and `customVocabulary` | Base language hints; Chinese variants map to `zh` or a supported regional hint. Vocabulary is sent as `keywords`. |
| Scheduled rotation | Every nine minutes; also on server `goAway` | Every nine minutes |
| Unsent audio queue | Latest 100 chunks; drops older chunks when full | Up to 100 chunks; overflow reports `AUDIO_BUFFER_OVERFLOW` and stops |

Both formats produce 100 ms chunks. The queue therefore holds up to ten seconds with the built-in mixer. During rotation or recovery, status is `starting` while new audio is buffered. Reconnection starts a fresh provider session; this implementation does not resume server-side context or replay audio already sent to the previous connection. Stop discards queued unsent audio. The worklet emits complete chunks only and does not flush a partial chunk at shutdown.

**Gemini.** After an established connection closes, encounters a transport error, or returns a retryable API error (429 or 5xx), the client retries with exponential backoff starting at two seconds and capped at 30 seconds. Each attempt invokes the credential function again. Non-retryable errors on an established connection are fatal; initial setup failures produce a failed `start()` result. Stop cancels retries and prevents late credential responses from reopening a socket. Graceful rotation sends `audioStreamEnd` and waits 750 ms for final text; stop waits 900 ms. These are fixed grace periods, without an acknowledgement that every transcript is complete.

**OpenAI.** The client disables server turn detection, requests `delay: 'minimal'`, and commits audio itself. All PCM chunks, including low-volume audio, are sent. After a chunk reaches RMS 0.005, 800 ms of subsequent below-threshold audio triggers a commit. Audio that remains below the threshold is still sent but may wait until stop or scheduled rotation for a commit. There is no short periodic commit timer; continuous speech can still cross a connection-rotation boundary. Pause detection and resulting speech boundaries need representative microphone testing.

OpenAI publishes finalized items in first-observed item order, ignores duplicate completions, and keeps completed text waiting behind an earlier item in the interim transcript. Stop and rotation commit remaining sent audio and wait for outstanding completions, including commits whose item IDs have not arrived. Finalization is bounded to five seconds. A transcription failure or finalization timeout reports an explicit error and preserves already published segments; a finalization error during `stop()` also produces a failed `CommandResult`. Unexpected connection failures are fatal; this client has no automatic transport retry loop.

## Traditional Chinese normalization

When `languageCodes` selects Traditional Chinese (for example, `cmn-Hant-TW`) without Simplified Chinese (for example, `cmn-Hans-CN`), both providers' interim and finalized transcripts receive character-only Simplified-to-Traditional conversion before subscribers or queries see them. Chinese script subtags take precedence over regional defaults (`TW`/`HK`/`MO` for Traditional, `CN`/`SG` for Simplified). Automatic detection, selections without a Traditional Chinese preference, and selections containing both scripts preserve the provider's script.

Conversion uses the `opencc-js` character dictionary, included in the browser bundle through the package dependency. Regional vocabulary is preserved: `软件` becomes `軟件`, not `軟體`. Ambiguous characters use the dictionary's first candidate without context; `头发` becomes `頭發`. Phrase disambiguation and regional word replacement are excluded.

## Development

From the repository root:

```sh
pnpm --filter @weave-in/transcribe test
pnpm --filter @weave-in/transcribe typecheck
pnpm --filter @weave-in/transcribe build
```

Unit tests use injected audio/WebSocket dependencies to cover ownership, option validation, query retention/pagination, script normalization, provider setup, reconnection, and finalization. They do not establish real-provider compatibility or physical microphone accuracy. The [meeting verification record](../../apps/meeting/VERIFICATION.md) tracks separate browser and provider evidence. Build emits browser ESM, declarations, and the standalone worklet; the repository's `pnpm check` also checks the consuming application and deployment bundle.
