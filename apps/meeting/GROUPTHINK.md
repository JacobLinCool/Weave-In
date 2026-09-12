# Automatic Group review

Omni is a public-discussion facilitator, not a psychological diagnosis. Its four semantic review categories use the existing GPT-Live reasoning backend. The former embedding-threshold proposal is not the runtime algorithm; there is no separate detector package, participant personality score, or accuracy claim.

## Trigger and privacy

Omni is created automatically when the room starts. Removing it disables review for that room until someone explicitly adds it again. There is no manual review button or manual signal command. After automatic preparation, a participant must approve with Allow Omni to speak or a fresh local finalized “Omni, go ahead” / “Omni，請發言” caption. Chat, interim captions, replay and Agent output cannot approve. Only the elected ready browser may request review. A two-second timer waits for at least four finalized public human caption/chat records, new non-replayed discussion after Omni was added, and at least 1.5 seconds without human voice activity, interim captions or new finalized discussion. Agent output, presence, files and historical replay alone do not trigger a review. Captions must be enabled to analyze speech; Room text works without captions.

The browser supplies bounded public context and the opening discussion as goal evidence; existing read_meeting tool retrieve earlier public records when necessary. It never supplies private Muse conversations or private reminders. Files/screens remain opt-in read sources and cannot initiate review. Evidence must refer to finalized public discussion records, not files, screen guesses or assistant text.

## Decisions and actions

| Scenario | Action | Required behavior |
| --- | --- | --- |
| `convergence` | `counterpoint` | Ask a relevant counterargument when an imminent decision prematurely closes alternatives or bypasses an explicit unresolved objection. |
| `drift` | `refocus` | Reference the established public goal and current topic; ask whether to return after a sustained, unintended departure. |
| `float` | `invite` | Invite a least-heard current participant by name when one person dominates with at least five contributions in a room of at least three people. |
| `echo` | `deepen` | Ask for a concrete reason, evidence or unique information when several recent turns repeat agreement without adding information. |
| `none` | No publication | Default for insufficient evidence, uncertainty, resolved objections, substantive agreement, useful tangents or intentional topic changes. |

The backend returns one JSON decision: kind, severity, evidenceSeqs, targetPeerId and text. The client requires severity 0.5–1, two to eight distinct eligible evidence records, at least one in the latest four records, and one question of at most 240 characters. Invitations must name an actual least-heard participant; the application checks participant count and contribution counts. The model judges the semantic relationship, not application-provided keyword matching. Public language follows the meeting or the configured response language. No participant evaluation, private-position inference or Groupthink verdict is allowed.

All four actions prepare a short question silently. After participant approval, Omni reads that question aloud to everyone and records it in the public transcript. They do not modify a whiteboard or operate other users' controls. The kind-to-action mapping is fixed by the application policy.

## Coordination and safeguards

Review pauses while the runner tab is hidden because browser voice monitoring depends on visible-frame sampling. Returning to the tab requires a new quiet interval. If audio monitoring cannot initialize, automatic review pauses with a visible error.

The room authority enforces one review per 30 seconds, 120 seconds between confirmed publications, and at most five confirmed publications per room. It persists limits and accepted event evidence keys across runner changes, settings changes and Group removal/recreation. The limits reset only when the room becomes empty. These limits bound cost and interruptions; they are not detection confidence measurements.

A review result is discarded if new discussion arrives before publication, its evidence is invalid, or the prepared question waits longer than 120 seconds. Approval is fenced to the prepared agent, epoch and request. Button approval or an exact local finalized voice command authorizes only that question. Speech waits for quiet and never preempts another agent's public floor. Stop cancels the current review/question; later new discussion may qualify again. Removal disables review. Failed connections are visible; stale epochs cannot publish. A replacement runner can re-evaluate interrupted work against its available public history. Deduplication and room limits prevent retry storms and repeated accepted evidence events.

Public questions use the existing agent-history channel for late joiners and reconnects. No raw discussion archive is added to the signaling server; it stores control metadata, scenario and public evidence identifiers. Selected context goes directly to OpenAI after the existing authenticated initialization.

## Verification

`tests/group.test.ts` covers four-category output validation, abstention, invalid evidence, invitation eligibility, runner fencing and shared limits. Runtime tests cover quiet gating, fresh discussion, replay/agent exclusion, stale results and silent preparation and approval-gated speech. `scripts/verify-agents-browser.js` exercises actual room WebSockets and peer delivery, using normal UI chat to trigger reviews. Its focused scenario mode supports either simulated GPT-Live or real provider calls. Real-model samples show behavior for those examples only; they do not establish general detection accuracy or noisy-room voice performance.
