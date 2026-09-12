# Agent verification — 2026-09-12

## Voice whiteboard and shared-file extension

Implemented on `feat/voice-whiteboard-context` after fetching and fast-forward checking main at `73fd6c3`. The following checks cover this extension; the older agent/browser matrix below does not establish real-provider coverage for the new tools.

- Two independent Chrome participants passed `scripts/verify-chat-tools-browser.js`: read and search the meeting, transfer another participant's text and image, supply that image to the reasoning input, read and edit the shared whiteboard, capture the rendered diagram, and post an attributed Room message received by the other participant. The board opened automatically, the diagram fit the viewport, and private input/reply text stayed out of the other participant's room state. The GPT-Live WebRTC endpoint was simulated; room signaling, peer transfers, whiteboard rendering/synchronization, and tool execution were real. This verifies integration mechanics, not actual speech understanding or model tool choice.
- Actual browser PDF.js and Mammoth parsing passed separately: a two-page PDF supported text continuation, rendered text and image-only pages contained nonblank pixels, and 4,802 characters of Unicode DOCX text reconstructed exactly across three pages. No browser errors or failed asset requests were observed.
- Regression coverage includes source/file permissions, history search and cursor coverage, stale snapshot removal/reappearance, cancellation during asynchronous edits/downloads, image budgets across reference → edit → capture, and background-budget saturation without interrupting foreground tool work. When continuous context updates pause, the UI and backend receive a status notification; the backend is instructed to fetch current records before the next meeting-based request.
- Final automated gate: 77 transcription and 260 meeting tests passed (337 total), along with type checking, production builds, bundle asset checks and Worker deployment dry-run. The two-participant harness also passed against the resulting production build.
- Before release, integrated main `4e6ed7b`, retaining Muse's compact panel and settings dialogs, room-join recovery, and TURN support. The integrated `pnpm check` passed with 77 transcription + 364 meeting tests (441 total). The two-participant tool harness passed against the integrated production build using the existing production endpoint for short-lived ICE settings; GPT-Live remained simulated.
- Before deployment, no new real GPT-Live session was performed for this extension. A new test room is recommended after deployment to pick up default file permissions and updated Muse instructions. Real spoken requests, model-chosen tool sequences, complex uploads, and longer meetings remain deployment-environment checks.

Context means the public record and file inventory available in the current browser, including connected authors' replay. This extension adds retrieval over that record; it does not introduce a server archive or guarantee access to uncached files after their owner leaves.

## Verdict

**Not an all-browser pass.** Three verification agents and the primary task exercised the implementation locally on macOS, using three independent Clients and real OpenAI sessions as well as a deterministic provider simulator. Chromium flows and Chromium → WebKit delivery passed. Firefox peer links and WebKit → WebKit peer links failed in this environment. Native Safari, Windows, physical-device microphones and human listening have not been verified.

All changes and tests are local on `codex/personal-group-agents`; no deployment was performed. Browser evidence below was collected before integrating main at `b5442a6`; the post-integration checks are distinguished below. Credentials stayed in ignored Worker configuration.

## Browser matrix

| Path | Result | Evidence / limitation |
| --- | --- | --- |
| Chromium 153.0.8010.12, three contexts | Passed tested flows | Private/public text and audio, separate microphone routing, late transcripts, Group silent preparation, approval with fresh context, remote audio, takeover, 390px layout |
| Chromium real four-tool chain | Passed | Read meeting → download `decision.txt` → identify `DECISION B` from screen → post summary received by third Client; owner Carol correctly read; output waveform peak 0.4615, no provider errors |
| Firefox 153.0 direct OpenAI | Passed tested local flows | Personal text, synthetic private voice, meaningful speech response; Group preparation/approval and runner reassignment |
| Firefox ↔ Firefox / Chromium / WebKit peers | Failed | ICE failed, zero remote bytes/audio; public delivery could not pass |
| WebKit 26.5 direct OpenAI | Passed latest local retries | Personal typed and stable-track synthetic voice; Group prepare/approve/speech; meaningful voice answer, peak 0.4415 |
| Chromium → WebKit peers | Passed tested direction | Public transcript/audio, private isolation, WebKit approval, Group fresh-context response; peak 0.4162 |
| WebKit ↔ WebKit peers | Failed | Native peer pair remained checking with zero responses/data |
| Mixed-browser takeover | Partial | Chromium → Firefox → WebKit runner epochs and re-preparation passed. First WebKit takeover speech timed out; a fresh WebKit Group retry passed. The original silent session's root cause is unproven |
| Live voice approval, Chromium | Passed | Real caption service finalized “Weave Go ahead.”, Group entered speaking and produced waveform peak 0.0615. Identical typed chat did not approve |
| Native Safari / iOS / Windows / physical devices | Not tested | Bundled Playwright WebKit is not Safari certification |

Independent controls using only two native `RTCPeerConnection` instances reproduced Firefox/WebKit peer failures without application signaling or Agent code. Candidates included the machine's VPN interface. This narrows investigation to browser/network connectivity, but does **not** prove a VPN root cause or establish product-wide compatibility. Current room transport uses STUN and has no TURN relay.

Synthetic audio uses a prerecorded sentence injected into a media track. Actual provider responses and WebAudio/RTP measurements were observed; no person listened to physical speakers. WebKit understood the benefit question but transcribed “meeting” as “me” and omitted “Please”; exact transcription is not guaranteed. Earlier replaceTrack-based fixture input was clipped, so the final voice check installed a stable track before negotiation.

## Coverage by requirement

| Requirement | Verification |
| --- | --- |
| Creation settings, source/chat combinations, one Personal per owner, one Group per room | Form browser flows, permission unit tests and Durable Object tests |
| Private history/tool isolation, audience frozen before asynchronous initialization, stale Personal replacement | Runtime regression tests; three-client private/public and late-fragment checks |
| Private microphone isolation and public microphone restoration | Browser track inspection, real synthetic speech and deterministic three-client flow |
| Four tools, permissions and no preparation-stage publishing | Real tool chain; permission tests, silent preparation with intentionally emitted simulated provider audio |
| Group signal coalescing, duplicate approval, current context | State tests; browser approval after new public chat |
| Public floor priority, stop and queued Personal input | State/runtime tests and browser preemption/failure flow |
| Disconnect, leases, stale epochs, failed runners, empty-room cleanup | Room tests; browser disconnect/reassignment and recovery UI |
| Generation versus playback, late fragments and privacy | Runtime tests plus waveform/transcript browser checks |
| Initialization failure, timeout and cleanup | Controlled provider failure browser flow, session tests, observed real timeout recovery |
| Browser audio and network interoperability | Matrix above; partial, not a release pass |

## Defects found and corrected during verification

- Voice approval initially failed because transcription rendered “Weave” as “Wave”, then inserted a period: “Weave. Go ahead.” Product vocabulary hints now include Weave and 團隊助理, and the full-command matcher accepts sentence punctuation between the name and command. It remains anchored and rejects quoted or surrounding text.
- Personal input audience was read after an asynchronous operation; it is now captured at input start and rejected if the Agent was replaced.
- Ended remote Agent streams retained runtime state; the controller now releases it.
- Typed backend requests were missing frontend question context and could produce unrelated speech preambles; quiet Live context now identifies the current request.
- Fractional numeric literals in the screen tool schema caused real Live initialization HTTP 400. The schema is provider-compatible while runtime validation preserves the quality range.
- Screen capture could wait forever on `video.play()` despite a frame timeout; both now participate in the bounded wait.
- Live's observed 32,768 UTF-8 byte / 128 item input ceiling was exceeded by repeated context and images. The Client now de-duplicates background records, seeds at most 6,000 bytes, reserves foreground capacity, pages Agent records/files, resizes images, and stops visibly before exceeding its budget. Accounting covers Client-sent `response.item.create` JSON; provider-added history may still reach its own limit, which also produces a visible controlled error. A new question uses a fresh session; no undocumented reset event is assumed.
- Caption rotation could leave an unfinished old item blocking all new finals, and the App unsubscribed before stop drained its last sentence. The App keeps the subscription through drain and only publishes the stopped public session’s final snapshot before private capture. After main integration, finalization uses its stronger five-second completion barrier and reports an explicit error on timeout instead of silently discarding unfinished text. Partials are never promoted to final captions.
- OpenAI captions used a media-less SDP path and unsupported server VAD. The existing PCM pipeline now uses the transcription WebSocket and explicit commits after speech/silence detection. Stop and rotation drain outstanding commits with main’s five-second finalization limit.

## Main integration before PR

Integrated main `b5442a6`, retaining the meeting timer, social metadata, Traditional Chinese normalization and Gemini recovery changes. OpenAI captions keep the verified WebSocket transport while adopting main’s idempotent stop, setup cancellation, completion de-duplication, five-second finalization errors and minimal transcription delay. All PCM is sent, including quiet audio. Commits use an 800ms natural pause instead of a fixed two-second cut, so an approval command is not split solely by elapsed time. Updated tests cover this deliberate difference. Post-integration `pnpm check` passed (exit 0): 77 transcription + 95 meeting tests, **172 total**, type checking, builds and Worker dry-run. Log: `output/playwright/pr-pnpm-check.log`. Real-browser evidence predates this integration; the integrated caption settings still need a new real-provider browser pass.

## Local automated gate

Before main integration, the final deterministic browser run used three independent Chromium Clients and passed every scripted assertion after the caption drain fix. **`pnpm check` passed with exit code 0:** type checking, 19 transcription + 79 meeting tests (98 total), production builds, bundle verification and Worker deployment dry-run. This was a dry-run, not a deployment. Full log: repository-root `output/playwright/final-pnpm-check.log`. `git diff --check` also passed. Named verification browsers and the temporary dev server were closed after testing.

## Reproducible artifacts

Tracked deterministic check: `scripts/verify-agents-browser.js` (launch instructions in README). It exercises three real Client peer connections while simulating only the GPT-Live endpoint.

Local artifacts are under repository-root `output/playwright/` (ignored, not bundled):

- `final-three-client-result.log`: final deterministic three-client assertions.
- `four-tools-result.log`, `verify-four-tools.js`: real provider tool results, request sizes, third-Client chat and audio measurement.
- `voice-approval-result.log`, `verify-voice-approval.js`: real human-caption path using synthetic speech, accepted floor and audible Group output; chat rejected.
- `typed-language-result.log`: real typed request meaning/language checks.
- `firefox-verification.md`: Firefox version/configs, native control, real local voice and mixed-peer failures.
- `webkit-verification.md`: mixed public delivery, original failed takeover, successful retry and stable-input voice evidence.
- `webkit-stable-voice-summary.json`, `webkit-retry-group-summary.json`: input/output, RTP and waveform evidence.

## Remaining release checks

1. Repeat failed peer paths on a supported non-VPN/cross-device network and decide whether TURN is required for the supported connectivity envelope.
2. Verify native Safari and Windows browsers with physical microphones/speakers, permission prompts, autoplay restrictions and actual screen selection.
3. Repeat voice approval with real speakers and both documented languages; speech recognition must match a complete command. Chat, quotations, history replay and Agent speech must never authorize a floor.
4. Soak-test longer noisy conversations, caption connection rotation, session expiry and device sleep. Unit tests for these boundaries do not establish production reliability.
