# Verification

The current implementation has private Muse text, dictation and continuous Live voice, owner-approved public read-aloud, and automatic Omni review followed by explicit approval before public speech. [ARCHITECTURE.md](ARCHITECTURE.md) describes these paths. This document separates checks available in the repository from historical observations; a recorded pass on an earlier policy or commit is not a pass for the current application.

## Automated gate

Run from the repository root:

```bash
pnpm check
```

This runs workspace type checks, transcription and meeting tests, production builds, asset/bundle validation and a Worker deployment dry-run. It does not deploy or make real-provider/relay checks. Use `pnpm --filter @weave-in/meeting test` for the meeting suite alone. Record the tested revision, command exit status and test totals with each validation run instead of treating historical totals as the current suite size.

| Area | Tracked regression coverage |
| --- | --- |
| Room lifecycle and peer protocol | `meeting-room.test.ts`, `meeting-controller.test.ts`, `protocol.test.ts`, `history.test.ts`, `meeting-timer.test.ts`: admission, duplicate/stale identity, reconnect, capacity, timer, bounded messages and replay |
| TURN provisioning and recovery | `ice-servers.test.ts`, `ice-configuration.test.ts`: response validation, rate limits, deadlines, credential reuse/renewal and cancellation; provider responses are simulated |
| Assistant authority and tools | `agents.test.ts`, `agent-runtime.test.ts`, `agent-live.test.ts`: owner controls, epoch/lease/floor fencing, settings revocation, private/public isolation, interruption, input budgets and session lifecycle |
| Omni review | `group.test.ts`, `agents.test.ts`, `agent-runtime.test.ts`: policy fixtures, abstention, evidence, quiet/freshness checks, review limits, approval, expiry and takeover |
| Dictation and public caption isolation | `dictation.test.ts`, `caption-session.test.ts`, `voice-activity.test.ts`, plus transcription-package tests: stop/drain, cancellation and microphone routing |
| Reminders and recovery | `auto-reminders.test.ts`, `private-analysis.test.ts`, `private-notices.test.ts`, `meeting-session.test.ts`: evidence, recipient, recurrence, stale results, provider errors and checkpoint validation |
| Meeting/file/board tools | `webmcp.test.ts`, `agent-attachments.test.ts`, `file-share.test.ts`, `screen-capture.test.ts`, `whiteboard-webmcp.test.ts`, `excalidraw-store.test.ts` and related preview/board tests: permissions, peer transfers, parsing, cancellation, scene validation and edits |

These tests verify deterministic application behavior and fixtures. They do not establish model accuracy, real speech understanding, device interoperability or production reliability.

## Omni trigger and approval repair — 2026-09-15

The following pre-rebase checks covered changes based on `6867b07` that separate Omni monitoring readiness from Muse audio readiness. Hidden or unmonitored runners yield, fresh discussion remains reviewable on return, and repeated foreground updates no longer cancel approved speech. Already published speech keeps its valid floor until completion or expiry. Omni now glows only while awaiting approval, shows the initial finalized-discussion count, and provides a full-width approval button. Muse Live uses the surrounding voice-control styling.

`pnpm check` passed with exit code 0: **77 transcription + 435 meeting tests (512 total)**, type checking, production builds, asset validation and Worker deployment dry-run. Desktop and 390px mobile UI checks covered six Omni states, approval by Enter, visible 44px approval targets and no document overflow.

The local Chromium microphone-to-approval-to-audio flow passed using synthetic Mandarin microphone input, real captions and real GPT-Live. Four separately finalized public captions led to automatic preparation and a ready glow; clicking **Allow Omni to speak** produced one relevant Mandarin question, measured audio peak 0.526 and a finished public transcript. No model response or caption record was injected. This was a single-participant room with mocked ICE provisioning; cross-device delivery, physical microphones/speakers and production behavior were not verified. No deployment was performed.

Local evidence under repository-root `output/playwright/`: `omni-trigger-check.log`, `omni-trigger-results.json`, `omni-voice-check.js`, `omni-voice-ready.png`, `omni-approval-desktop.png`, `omni-approval-mobile.png`, and `muse-live-style-desktop.png` / `muse-live-style-mobile.png`.

Click affordance follow-up: the glow now belongs to the approval button itself. A provider-free Chrome check of the real AgentPanel confirmed click, Enter and Space each approve once, only the ready/unapproved button glows, and the button stays visible at 44px high on desktop and 390px mobile without document overflow. Type checking and browser-script syntax checks passed. Evidence: `output/playwright/omni-ready-button-results.log`, `verify-omni-ready-button.js`, and `omni-ready-button-desktop.png` / `omni-ready-button-mobile.png`. This follow-up did not repeat provider or cross-device tests.

After integration with main `857e6f2`, `pnpm check` passed with exit code 0: **83 transcription + 436 meeting tests (519 total)**, type checking, production builds, asset validation and Worker deployment dry-run. Main's newer Muse interface and Live controls are preserved. Evidence: `output/playwright/omni-pr-integrated-check.log`. The real-provider observations above precede this integration; no deployment was performed.

## Reconciliation validation — 2026-09-13

The working tree based on `6867b07`, including the documentation reconciliation and bounded code fixes, was checked locally with Node.js 24.2.0 and pnpm 11.24.0. Dependencies were synchronized with `pnpm install --frozen-lockfile` before validation.

| Check | Result and boundary |
| --- | --- |
| `pnpm check` | Exit 0: 83 transcription tests and 425 meeting tests, workspace type checks, production builds, asset validation and Worker deployment dry-run. No deployment. |
| `pnpm dev --host 127.0.0.1 --port 5179` | Built the transcription dependency and started Vite successfully. The dev command now supplies the previously missing workspace-build prerequisite. |
| `verify-chat-tools-browser.js` | Passed in two Chromium contexts against the built local Worker: six actual meeting/file/board tool calls, peer file/image transfer, rendered Mermaid capture and board synchronization, with no private content or default Room post leaking to the peer. AI responses and ICE provisioning were simulated. |
| `verify-agents-browser.js` | Passed in two Chromium contexts: private dictation, Live remaining open after an answer, End restoring microphone/input, selected-message public speech, interruption, settings/recovery, and Omni silence before approval followed by public audio/transcript and deduplicated replay. AI responses and ICE provisioning were simulated. |
| Landing privacy section | Checked at 1440px and 390px widths, captured and visually inspected, with no document overflow. |
| Documentation and scripts | Local Markdown links/anchors and JSON examples resolved; browser harness syntax and `git diff --check` passed. |

The harness required updated Dictate/Live/Send and transcript attribution selectors. Its simulator now selects canned responses from the explicit request rather than matching text in background conversation history. Application assertions were retained, and the new Live check exercises one simulated exchange; it is not a multi-turn or physical-audio soak test.

Local evidence is retained in the ignored repository-root `output/playwright/alignment/` directory. This run did not call real AI providers, verify external TURN relaying, test additional browser engines or deploy production.

## Reproducible browser checks

Launch/configuration instructions are in [README.md](README.md#browser-verification). All harnesses require a running development or built-Worker origin; pass it explicitly. The two app harnesses use independent browser contexts with real room WebSockets and local peer connections. Their default GPT-Live and ICE provisioning responses are simulated.

| Script | What the current harness checks |
| --- | --- |
| `scripts/verify-agents-browser.js` | Automatic Muse/Omni setup without a Live connection on entry; private isolation; dictation stop/send; a bounded simulated Live start/answer/End cycle; selected-reply reading; settings and permission changes; owner attribution, microphone interruption and no automatic resume; silent Omni preparation, approval-before-audio, public delivery/replay; room recovery and mobile layout |
| `scripts/verify-chat-tools-browser.js` | Actual meeting read; another peer's text/image transfer and readable/vision result; shared-board read, Mermaid edit and rendered capture; receiving peer's board; default file access, screen opt-in, 500-record tool schema, and no private-response publication or default Room-posting tool |
| `scripts/verify-turn-relay.js` | Real credential provisioning and two peers with relay-only policy for all transports, TCP-only and TLS/443-only; bidirectional data/media and selected relay candidate pairs via `getStats()` |
| `scripts/evaluate-private-analysis.mjs` | Opt-in real Gemini checks using synthetic unresolved/resolved objections, ordinary agreement, unclear transcription and prompt-injection fixtures |

The agent harness accepts a third argument:

```js
{
  groupOnly: true,
  scenario: 'convergence', // also drift, float, echo, none
  realProvider: true
}
```

Each scenario uses normal Room chat in a new room; `float` uses three participants. Intervention cases wait for a raised draft, check silence before approval, approve it, then check one public intervention and audio delivery. `none` checks abstention. Omit `realProvider` for deterministic classification/output simulation. Even with a real provider, this harness mocks ICE provisioning and therefore does not test TURN. The live Gemini evaluator and real-provider/relay modes make external provider calls.

The current agent harness covers dictation, one-turn read-aloud and one simulated Live exchange that stays open until End. It does not constitute a continuous Muse Live conversation soak test. Model-chosen tool sequences, physical microphone input and human listening need their own recorded observations.

## Historical observations retained from 2026-09-12

The entries below summarize previously recorded results, not checks rerun during documentation reconciliation. Local evidence files were recorded under the repository-root ignored `output/playwright/` directory and may be unavailable in a fresh checkout. Git history retains the full earlier verification diary and test totals.

| Checkpoint | Recorded result | Boundary for the current code |
| --- | --- | --- |
| Initial personal/group agent work, before main integration `b5442a6` | Three Chromium contexts passed private/public media and tool flows with simulated and real OpenAI sessions. Firefox and WebKit could use local OpenAI sessions; Chromium → WebKit public delivery passed. | Older agent permissions and manual approval vocabulary; this predates current Omni automation, Muse tools and TURN. |
| Initial cross-browser peer investigation | Firefox peer paths and WebKit ↔ WebKit failed with zero peer data/media. Native `RTCPeerConnection` controls reproduced failures; a VPN interface appeared among candidates. | No proven root cause. The then-current transport had no TURN. Current code provisions TURN, but these results neither verify nor disprove its relay behavior. |
| Main recheck `002e524` | Two Chromium clients passed the then-current Muse/private-reminder/silent-Omni flow. Real Gemini fixtures passed; a synthetic Mandarin microphone → real captions → peer delivery → private-reminder test notified only the concern author. | Supports the tested reminder path and synthetic conditions. Omni was text-only then; Hide/Show reminder controls and other old UI behavior are superseded. |
| Shared-file/whiteboard work, through `20ebf3a` | Simulated-provider browser flows exercised peer file/image transfer, native board edits/capture and attributed posting. Separate browser parsing checks exercised two-page PDF and Unicode DOCX content. | This preceded the current default-denied Room posting permission and removal of Muse search/raw-download tools. |
| Muse tool/permission integration through `8bd60d7` | Revised two-browser six-call harness passed with real local file/board execution, simulated GPT-Live/ICE, 500-record schema and no public Room message. | Confirms the recorded integration mechanics; it does not prove real model tool choice or complete large-transcript delivery within the Live input budget. |
| Earlier production typed Muse sample | A real Live session read the meeting, created a three-node Mermaid workflow and received a rendered board image. Requested Room posting timed out amid reconnect/lost alerts. | Partial result, not an end-to-end pass; no physical voice/listening check. |
| Automatic Group integration through `1bbd3bc` | Two-browser simulated-provider checks passed. Real-provider cases produced relevant counterpoint, refocus, invitation and deepening questions; an answered-concern case abstained. | These samples used automatic text publication with zero assistant audio. They establish sampled preparation/classification, not the subsequently corrected approval-to-audio flow. |
| Final approval correction | Meeting tests passed before the final freshness/clock changes. The browser harness was updated to require approval and audio. | The prior record explicitly states the revised browser harness was not run and there was no additional verification after the final fixes. Do not reuse the text-only results as an approved-speech pass. |

Representative historical evidence names are `final-pnpm-check.log`, `four-tools-result.log`, `firefox-verification.md`, `webkit-verification.md`, `agent-check-browser.log`, `speech-live-result.log`, `merge-tools-browser.log`, `integrated-real-group.log` and `final-integrated-browser.log`. The permission revision also recorded `/private/tmp/weave-muse-release-check.log`. Their names describe the earlier checkpoints, not the latest source.

## Remaining runtime verification

1. Extend the current two-browser pass with actual English/Chinese voice approval, verifying no output before approval and revocation after changed discussion, cancel, expiry or runner takeover. The recorded browser pass uses button approval; voice-command matching and revocation also have deterministic test coverage.
2. Exercise continuous Muse Live with multiple turns, interruption, tools, End, settings changes and signaling loss. Verify that private input stays out of Room/captions and that the meeting microphone restores correctly.
3. Run current real-provider Group scenarios and model-chosen file/board workflows. Record classification, prepared text, actual read-aloud output and receiving-peer behavior separately; deterministic simulator success cannot establish model behavior.
4. Run relay-only checks and normal-room camera/microphone/screen/chat/file/board flows on the supported cross-device networks. Verify renewed credentials, signaling reconnect and late participants. A successful ICE endpoint response or same-network direct connection is insufficient relay evidence.
5. Verify native Safari, Firefox, Windows and mobile devices with physical microphones/speakers, permission prompts, autoplay restrictions and real screen selection. Evaluate noisy conversations, long-session caption rotation, device sleep and recovery.

No all-browser, physical-audio, long-session or current production-deployment pass is established by the historical evidence above.
