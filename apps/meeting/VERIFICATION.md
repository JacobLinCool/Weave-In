# Agent verification — 2026-09-12

## Muse tool and Room permission revision

Revises the voice extension deployed from main `20ebf3a` after PR #15. Muse no longer receives `search_meeting` or `download_file`. `read_meeting` defaults to and allows 500 complete records per page; the initial read starts at cursor zero, and subsequent pages use the last successfully consumed cursor. `read_shared_file` downloads each complete source file internally before extracting readable content. Native browser WebMCP remains separate.

Personal Room posting now requires `roomMessages: true`, with an unchecked setting and an explicit description that Room is visible to everyone. Missing legacy values deny posting. The client removes the tool by default and rechecks permission at execution; the Worker also rejects unauthorized tool declarations. An enabled permission still requires a direct owner request. Integrated main `8bd60d7`, retaining inline Muse settings, epoch-based cancellation when settings change, system-signal delivery, the sidebar width correction, no fixed Muse conversation timeout and automatic Omni initialization. Omni's existing publication permissions are unchanged.

Final integrated `pnpm check` passed with exit code 0: 77 transcription + 385 meeting tests (462 total), type checking, production builds, asset validation and Worker deployment dry-run. Regressions include 1,002 full records returned in 500/500/2 pages, legacy config defaults, Worker posting rejection, cancellation of an asynchronous board commit and captured posting tool after revocation, and visible refusal to save/remove during disconnection or recovery. Local check log: `/private/tmp/weave-muse-release-check.log`.

The 500-record tool limit is separate from the application's conservative cumulative 30,000-byte / 120-item Live event budget. Oversized results produce an explicit error, not silent truncation. This revision does not establish complete large-transcript delivery to the model or add a server transcript archive.

Two independent Chrome participants passed the revised six-call harness against the integrated production build: meeting read, complete text-file download/reading, image download/vision input, board read, Mermaid edit and rendered board capture. The guest received the diagram; no Muse message appeared in public Room and private voice text remained isolated. Default tool declarations excluded search, raw download and Room posting, and the meeting schema allowed 500 records. The harness simulated GPT-Live and ICE provisioning while using real local room signaling, peer file transfer, whiteboard rendering and synchronization. It does not certify model tool choice or TURN relay connectivity.

The preceding production release was checked with one real GPT-Live typed request in an isolated test room: initialization returned 201, meeting reading succeeded, the three-node Mermaid workflow was created, and a rendered whiteboard image was delivered to the model. The old requested Room-post step did not complete within 120 seconds and room coordination showed reconnect/lost alerts, so that run was not a full end-to-end pass. The test left its room and closed its browser. It did not verify speech recognition or physical listening.

## Current main recheck — `002e524`

Local Chromium recheck of the merged Chat / text-only Omni implementation passed on 2026-09-12. The historical browser matrix below is not a new cross-browser certification.

- `pnpm check` passed: **304 tests** (77 transcription, 227 meeting), type checking, production builds, bundle verification and Worker deployment dry-run. No deployment was performed.
- Two independent Clients passed automatic Chat creation, no Live session on entry, private isolation, approved public speech, owner attribution, microphone interruption without resume, refresh/reconnection recovery, silent Omni delivery, replay deduplication and 390px layout.
- Real OpenAI Chat returned a relevant Traditional Chinese answer and produced measured audio (peak 0.4185). Real Omni posted a relevant public question; measured audio peak was zero.
- Real Gemini analysis passed five synthetic cases: unresolved objection notified; resolved objection, ordinary agreement, unclear transcription and prompt injection did not notify.
- Browser checks using injected finalized speech plus the real monitor timer and Gemini verified popup appearance, no public Room message, Later/history recovery and Hide/Show. Resolved objections and ordinary agreement produced no popup. The positive case took 11.5 seconds from record injection through response and UI actions.
- The complete microphone-to-popup path also passed with two Clients: macOS synthesized Mandarin entered stable microphone tracks, real captions finalized and crossed the peer connection, and real Gemini notified only Alice after Bob bypassed her data-loss objection to approve launch. Bob received `notice: null`. This check did not inject transcript records or call the notice tool.

One test-harness defect was corrected: the reconnection test selected the first open WebSocket, which could be Vite HMR. It now explicitly closes the room `/connect` socket. The corrected browser run passed. Application behavior was not changed.

Evidence is retained locally under repository-root `output/playwright/`: `agent-verification-results.json`, `agent-check-pnpm.log`, `agent-check-browser.log`, `agent-check-gemini.log`, `auto-live-result.log`, `openai-live-result.log`, `speech-live-result.log`, and the corresponding browser scripts/screenshots. Provider credentials are only in ignored local configuration.

Scope: local Chromium, synthetic conversations and microphone input, real provider calls. Physical microphones/speakers, human listening, current Safari/Firefox behavior, production deployment, noisy conversations and long-session reliability were not verified by this recheck.

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

- Voice approval initially failed because transcription rendered “Weave” as “Wave”, then inserted a period: “Weave. Go ahead.” Product vocabulary hints now include Weave and 團隊Assistant, and the full-command matcher accepts sentence punctuation between the name and command. It remains anchored and rejects quoted or surrounding text.
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
# Muse and Room Omni (2026-09-12)

- Muse opens private chat directly. Omni is a persistent card above Room messages. Settings replace the panel, with Back to Muse or Back to Room at the top; Back discards unsaved edits.
- Omni adds immediately using the plus aligned with its heading. Its trash icon is to the right of settings. All participants may configure it; creator/host removal and personal-owner restrictions remain enforced.
- Removed the empty Omni description, idle listening text, private-chat privacy subtitle, manual review button, and reminder pause/hide controls and persisted state.
- The Omni border glows for preparing, raised and speaking, then clears when idle, cancelled or waiting. Reduced-motion preference disables the transition.
- Historical state at this checkpoint: the signal receiver existed without an automatic producer. Superseded by the automatic Group review implementation documented in GROUPTHINK.md.
- Local typecheck, 229 meeting tests and production build passed. Two-browser checks passed Muse chat/settings, one-click Omni creation/removal, cross-participant settings, top Back navigation, button alignment, removed controls, border glow/reset, private recovery and mobile overflow. GPT-Live is simulated; these checks do not establish real-provider behavior or deployment.
- Evidence under repository-root output/playwright/: assistant-browser.log, assistant-tests.log, assistant-build.log, assistant-desktop.png, assistant-mobile.png, group-add-right.png, group-settings-page.png, personal-settings-page.png, group-room-active.png, group-room-mobile.png.

- Merge validation: integrated main through 4e6ed7b, preserving TURN, identity recovery, creation cancellation and bounded reminder scrolling. Plus and settings use the same 18px icon and button sizing. Full pnpm check passed (77 transcription tests + 338 meeting tests), including build and deployment dry run; the two-browser harness passed exact button-size equality. Evidence: output/playwright/merge-check.log and merge-browser.log. Browser provisioning is mocked for local peer connectivity; this is not a TURN relay test.

- Final integration includes main 20ebf3a (Muse voice/whiteboard tools). `pnpm check` passed with 77 transcription + 366 meeting tests (443 total). Both browser harnesses passed: agent controls/sizing and voice-driven meeting retrieval, peer file/image transfer, shared-whiteboard edits/capture and attributed Room posting. GPT-Live and TURN provisioning were simulated; room/tool execution was real. Evidence: merge-check.log, merge-browser.log and merge-tools-browser.log under output/playwright/.

## Automatic Group review (2026-09-12)

Integrated main through `55d70d7`; source verification at `3c79f5c`. Omni is created by the room and automatically reviews fresh finalized public discussion. Manual signal/approval commands are removed.

`pnpm check` passed: 77 transcription tests + 418 meeting tests (495 total), type checks, production builds, bundle checks and Worker deployment dry-run. No deployment was performed.

The complete two-browser harness passed against the built Worker served by Miniflare: automatic Group review from ordinary chat input, private Muse isolation, dictation/response controls, silent Omni publication, settings/removal, room recovery and public replay deduplication. The harness simulates GPT-Live for this broad integration test.

The focused scenarios below used real GPT-Live and its reasoning backend, normal Room UI chat and actual peer delivery. Each case used a new local room; the invitation case had three participants. No review control command or model response was injected. Every intervention was received by the other browser, and measured assistant audio remained zero.

| Scenario | Observed public output |
| --- | --- |
| convergence | Before approving, how will we address the unresolved duplicate-charge failure and the risk that customers could be charged twice? |
| drift | Our stated goal was to choose PostgreSQL or MySQL for the billing database. Shall we return to that decision now? |
| float | Bob, what is your view on the proposed Friday launch date? |
| echo | Before adopting Vendor X, what concrete evidence on its cost or reliability supports this choice? |
| none | No publication; kind=none. |

These are behavioral samples, not a general detection-accuracy estimate. Human microphones, noisy rooms, cross-device TURN and production deployment were not part of this check.

Local evidence: `output/playwright/integrated-group-check.log`, `integrated-agents-browser.log`, and `integrated-real-group.log`. The harness supports `{ groupOnly: true, scenario, realProvider: true }` to repeat each real-provider case.
