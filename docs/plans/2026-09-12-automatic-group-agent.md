# Automatic Group Agent Implementation Plan

**Goal:** Remove manual Group triggers and complete automatic public-discussion review for counterpoint, refocus, invite, and deepen interventions.

**Architecture:** The elected ready browser checks new finalized public discussion and requests a fenced review from the room authority. The existing GPT-Live backend reads public context and returns a validated structured decision and tailored question in one pass; the application speaks only after explicit participant approval and a quiet period. Room state owns review throttling, intervention cooldown, count, and evidence deduplication across runner changes. No private reminders or personal conversations enter Group context.

**Tech Stack:** Existing TypeScript, React, Durable Object, GPT-Live, Vitest, Playwright. No new dependencies.

1. Add the four-scenario policy, bounded evidence window, strict structured decision validation and focused tests for all scenarios and abstention.
2. Remove manual review signals; retain button and explicit voice approval of an already prepared intervention. Fence automatic reviews and publications to the elected runner; enforce shared 30-second review spacing, 120-second intervention cooldown and five interventions per room.
3. Connect the runtime timer to fresh public final transcript/chat, quiet detection and the existing preparation/approval/speech lifecycle. Discard results overtaken by new discussion; preserve takeover and replay behavior.
4. Update the Omni prompt and visible status; remove obsolete manual-trigger documentation and describe actual behavior.
5. Run unit tests, typecheck/build and two-browser automatic-trigger scenarios with simulated provider responses. Verify real provider behavior if usable local credentials are available; report that evidence separately.

Scope is the Group Agent features reviewed in this task. Numerical embedding detectors, participant personality profiles, and unrelated Muse changes are outside this implementation.

User clarification: removing manual triggering does not remove approval. Raised Omni waits for Allow Omni to speak or a fresh local finalized “Omni, go ahead” / “Omni，請發言” caption. Approval is fenced to the current agent/epoch/request; no output is allowed before approval. Reuse the existing approved read-aloud session and peer audio transport. No tools or background context enter the approved speaking session. Cancel, changed discussion, expiry (120 seconds) or takeover requires a new review and approval.
