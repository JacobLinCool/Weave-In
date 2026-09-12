# Automatic Group Agent — implementation record

The automatic-review implementation is present in the meeting application. This file records the design decisions from 2026-09-12; it is not a pending build checklist. Current behavior is maintained in [ARCHITECTURE.md](../../apps/meeting/ARCHITECTURE.md#omni-automatic-review-and-approval), policy in [GROUPTHINK.md](../../apps/meeting/GROUPTHINK.md), and validation evidence in [VERIFICATION.md](../../apps/meeting/VERIFICATION.md).

## Implemented scope

The room creates a shared Omni and elects a ready browser to review fresh finalized public discussion automatically. Manual review triggering is removed. Review considers four categories: counterpoint for premature convergence, refocus for sustained drift, invitation for uneven participation, and deepening for repeated agreement without reasons. Uncertain or unsupported cases abstain.

The runtime checks fresh human captions/chat after quiet and warm-up, excludes replay and assistant output as triggers, and requests a review fenced to the current runner, epoch and request. The existing GPT-Live reasoning backend returns a structured decision and one question. Application validation checks public evidence, current participants, severity and text length. The room authority preserves review spacing, intervention cooldown, room count and evidence deduplication across settings changes and runner replacement.

**Automatic review does not grant permission to speak.** A raised draft waits for **Allow Omni to speak** or a fresh local finalized “Omni, go ahead” / “Omni，請發言” caption. Approval is bound to the exact agent/epoch/request. Typed chat and replay cannot approve. After approval, the runner still waits for quiet and an available public floor, then starts a fresh read-aloud session containing only its prepared question. No tools, private context or background updates enter this speaking session. Audio and transcripts use the existing public peer transport.

Changed discussion before output, cancellation, a 120-second draft expiry, changed settings or runner replacement requires new review and approval. There is no automatic text-only publication path in the current runtime. The earlier intermediate implementation that published silently without approval was superseded by this approval requirement.

## Code and checks

| Responsibility | Location |
| --- | --- |
| Category policy, evidence validation and timing constants | `apps/meeting/src/agents/group.ts` |
| Fenced commands, shared limits, approval and public floor | `apps/meeting/src/agents/contracts.ts`, `room.ts` |
| Freshness/quiet monitoring, review, approval and speaking lifecycle | `apps/meeting/src/agents/runtime.ts` |
| Provider context, tool restrictions and read-aloud session | `apps/meeting/src/agents/live.ts`, `worker/live.ts` |
| Omni status/settings and approval control | `apps/meeting/src/agents/panel.tsx` |
| Regression fixtures and coordination/runtime tests | `apps/meeting/tests/group.test.ts`, `agents.test.ts`, `agent-runtime.test.ts` |
| Two-browser simulated or real-provider scenarios | `apps/meeting/scripts/verify-agents-browser.js` |

The implementation uses the existing TypeScript, React, Durable Object and GPT-Live stack. Numerical embedding detectors, participant personality profiles, a server transcript corpus and post-meeting reports were outside this implementation. Current validation status must be read from `VERIFICATION.md`; older text-only browser samples do not establish the corrected approval-to-audio flow.
