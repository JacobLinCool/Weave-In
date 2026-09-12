# Architecture

The browser runs a personal **Muse**, a shared **Omni**, and automatic private reminder monitoring. Muse normally replies privately and can speak publicly only for a specific owner-approved reminder. Omni publishes brief public text, without audio or an approval prompt. Automatic four-scenario Group review is described in `GROUPTHINK.md`.

## Data and authority

```mermaid
sequenceDiagram
    participant C as Browser
    participant R as Worker / Room DO
    participant O as OpenAI Live
    participant G as Gemini
    participant P as Other participants
    C->>R: Join room; configure personal Muse
    R-->>C: Agent identity, runner, epoch and room token
    C->>R: Authorized Live settings and SDP
    R->>O: Initialize session using server key
    O-->>C: Direct session via SDP answer relayed by Worker
    C->>O: Permitted private context or approved public text
    O-->>C: Response and tool requests
    C->>P: Approved Muse speech or Omni public text
    C->>R: Bounded human transcript and reminder evidence
    R->>G: Embeddings and structured private analysis
    G-->>R: Evidence-linked decision
    R-->>C: Private reminder only for concern author
```

The Worker receives assistant settings, connection descriptions and room coordination. Conversation context and allowed screen/file tool results for Live go directly from the browser to OpenAI. Automatic analysis is a separate path: its bounded transcript and reminder evidence pass through the Worker to Gemini, without Worker persistence. Private conversations and reminders never enter shared room transports unless the owner explicitly approves the selected reminder for a public turn. API keys remain Worker secrets.

`POST /api/rooms/:room/agents/:id/live` accepts `{ epoch, request, session, sdp }`, requires the current socket's `X-Room-Token`, and returns `{ session: { id }, transport: { type: "webrtc", sdp } }`. It validates runner, lease, phase and allowed models/tools, bounds the request to 64 KiB, and limits each connection to six initializations per minute. Provider initialization times out after 20 seconds. Room tokens never appear in peer lists.

## Code ownership

| File | Responsibility |
| --- | --- |
| `src/agents/contracts.ts`, `config.ts` | Settings, defaults, wire validation, models, epochs and floor checks |
| `src/agents/room.ts` | Identity, runner leases, public-turn coordination and takeover |
| `worker/index.ts`, `worker/live.ts` | Socket identity, durable coordination and provider initialization |
| `src/agents/live.ts`, `tools.ts` | Live transport, Responses delegation and scoped meeting tools |
| `src/agents/audio.ts`, `runtime.ts` | Context, personal approval, transcript routing, microphone and playback gates |
| `src/agents/panel.tsx`, `private-notice-ui.tsx` | Unified Muse discussion/reminders, Omni and floating reminder cards |
| `src/auto-reminders.ts`, `worker/private-analysis.ts` | Automatic monitoring, semantic retrieval and recurrence validation |
| `src/private-notices.ts`, `meeting-session.ts` | Reminder lifecycle and same-tab room checkpoints |

## Configuration and private Muse

Joining a room automatically configures one personal Muse for that participant. This does not start a continuously running Live session or make a spoken announcement. Public sources default to all participants, public chat is included, and shared files are enabled by default, while shared-screen capture requires opt-in. Direct owner requests are always included. The owner can edit sources and tools through the settings button; saving preserves identity and conversation history while stopping old sessions. Markdown instructions cannot grant permissions.

Background records update an active private session without requesting a reply. A direct text question, reminder discussion action, or **Talk** starts a bounded private interaction with permitted public context and personal conversation. Private records stay in the runtime and are excluded from WebMCP's meeting log and peer replay. Agent transcript fragments update stable IDs and receive fresh cursors; permission-filtered logs may contain sequence gaps.

New Muse configurations receive system signals by default; existing configurations retain their saved permission. Signals come from validated automatic Omni review results (convergence, drift, float or echo). The latest signal is included when a permitted session starts, and new signals update active Muse private sessions and Omni preparation as background context without requesting another response. Automatic private reminders do not generate room system signals. Owner-approved public Muse speech excludes these signals along with other background context.

Private voice input temporarily disables the public microphone track and public captioning. A separate microphone clone feeds Live. Ending private voice restores the previous meeting microphone state. Output uses separate Web Audio nodes and peer tracks; it never feeds human transcription input. Audio activation can require a user gesture.

## Speaking for the owner

**Speak for me** grants one turn for the selected reminder. The runtime starts a fresh session with only that approved text and a constrained speaking instruction; personal history, background context and tools are excluded. Modest elaboration is allowed without new positions, promises or private information. Public transcripts identify the owner's Muse. No persistent public audience selector is available.

The owner's meeting microphone remains in its existing state. Local voice activity on an enabled microphone revokes queued public permission and stops the current Muse turn; it never resumes without a new approval. Detection is level-based, so noisy rooms still require listening evaluation. A Stop action remains available. Speech targets 15–20 seconds, with a 20-second runtime limit after audible output starts. Approval is also invalidated by stop, disconnect or removal; it is not carried into a replacement session.

## Public Omni

There is one shared Omni per room, created automatically when the room starts. Its persistent status card sits at the top of Room chat; after removal, the plus button can add it again. Every participant can configure it; the creator or host can remove it. `src/agents/group.ts` defines the four intervention policies, evidence validation and shared limits. The runtime watches finalized public captions/chat and current human voice activity. New records after warm-up and a quiet interval send a fenced `agent-review` from the elected runner. No manual-trigger command exists. GPT-Live's reasoning backend evaluates context and returns a structured decision and question in one pass. Invalid, low-confidence or stale decisions are discarded. It can retrieve older public context through existing read tools; public posting and whiteboard mutation tools are unavailable during review.

The state machine is `idle → preparing → raised → speaking → idle`: preparing means review, raised means waiting for quiet, and speaking is the existing public text grant. `agent-raised` carries only the validated scenario and public evidence identifiers; `agent-publish` is restricted to the current runner and advances publication automatically. The Durable Object persists 30-second review throttling, 120-second intervention cooldown, a five-intervention room cap, and duplicate-event evidence keys. Configuration changes/removal cannot reset room limits. A public floor occupied by Muse is not preempted. Results overtaken by new discussion or waiting more than 30 seconds are discarded. Public text is capped at 240 characters, labelled Omni, shared over the existing peer channel and replayed with grant proofs. No Group audio or human approval parsing remains.

## Takeover, reconnection and cleanup

The Durable Object stores assistant configuration and coordination, not meeting content. Ready browsers heartbeat every 10 seconds; a 30-second lease expiry or disconnect can transfer Omni to another ready browser. The replacement uses its own public record and may lack earlier history. No interrupted audio is replayed. Epochs, current grants, and bounded recently closed grants constrain delayed transcript handling and replay.

A lost signaling connection retries the same room and participant identity with 1–10 second backoff. The page preserves media and local history, stops assistant operations and monitoring while disconnected, then resumes room coordination and monitoring after reconnecting. Peers replay their own history with duplicate suppression. Closing a socket does not invoke Leave or clear the meeting UI.

`meeting-session.ts` checkpoints the current room in sessionStorage: up to 1,000 text messages, 1,000 finalized transcript rows, 2,000 log entries, 50 reminders, and up to 200 private Muse lines, plus identity, local timer and monitoring state. Reminders preserve evidence, read/collapse/dismiss state and visibility. Refresh/rejoin and deliberate Leave/rejoin can restore the same room within 12 hours of its last save. Different rooms replace the checkpoint. Private Muse text restores into the personal runtime after refresh/rejoin; the optional checkpoint field also accepts older saves without it. Active Live sessions, queued approvals, file bodies and screen sharing are not checkpointed. Restoring text never restarts speech. Storage failures preserve live memory and show a recovery warning.

Leave/remove immediately stops input, playback and pending tool work. The final participant leaving clears room coordination. A returning browser's checkpoint is separate from that server lifecycle and is not a durable room archive.

## Automatic private reminder delivery

`private-notices.ts` stores reminders separately from the meeting log. WebMCP's optional `show_private_notice` validates and copies cited evidence; `read_private_notices` reads local history. These tools remain available, but automatic monitoring does not require an external assistant or special browser.

`auto-reminders.ts` checks every five seconds for new finalized human speech, with at least 30 seconds between analyses. It excludes chat, interims, agent lines and replay-only changes. Requests contain up to 40 utterances and 20 historical automatic events, trimmed to byte budgets below the endpoint's 64 KiB limit. Gemini embeddings retrieve related speech and neighbors; structured Gemini generation evaluates the bounded context for an explicit, important unresolved concern bypassed by a later concrete decision. Only its author can receive the reminder. Answered or withdrawn concerns, unclear transcription, ordinary agreement, and missing topics do not qualify.

Event IDs combine concern and decision sequence numbers. Original evidence remains in reminder history after dismissal or collapse. A recurring concern requires a newer substantive commitment, execution starting, or changed scope, linked to its most recent previous decision. Validation rejects the same/older decision, normalized repeated text and invalid links. Semantic paraphrase detection still depends on Gemini's classification. A 120-second cooldown limits frequency; time passing never creates an event. New human speech while analysis runs makes the result stale. Leaving the meeting cancels/discards work. Provider errors back off for 60 seconds.

The silent card floats at the stage's lower left without resizing the video or controls. It collapses after 15 seconds of unattended display; hover, keyboard focus and insufficient space pause that timer. Muse combines its history/evidence and private discussion. Collapse is not dismissal or approval. No shared room corpus, embedding cache, all-detector package, or persistent report is introduced.

## Verification boundaries

Run `pnpm check` for type checking, tests, build and Worker dry-run. Focused tests cover permissions, recurrence, stale results, approval isolation, interruption and signaling recovery. Browser/provider observations in `VERIFICATION.md` include historical PR #6 behavior; earlier Group voice or persistent public-mode results do not certify this revised policy. Fresh browser checks must exercise silent Omni publication, owner-approved Muse speech, interruption without resume, and recovery. Human microphone/listening evaluation remains necessary for real-room voice behavior.

Input accounting uses UTF-8 bytes and item counts. Background context cannot consume the foreground reserve, and file pages/screens are bounded. No undocumented provider reset/delete events are used.

## Proposed room-wide analysis (not implemented)

The following analysis visualizations and build order are future design work, not the current reminder or assistant behavior. They do not imply a server-side meeting archive exists.

### Frontend additions

- `SidePanelTab` becomes `'chat' | 'transcript' | 'insights'`.
- The Trace needs **incremental PCA**, not t-SNE or UMAP. t-SNE and UMAP re-fit on every update and the points jump between frames, which destroys the one thing the visualisation is for — showing a *path*. PCA is stable, cheap, and incremental. Fit on the first window, then project.
- No charting library is needed or wanted. The radar is an SVG polygon over six axes; the Trace is projected points and a polyline. Both are a few dozen lines and both need to obey the design system exactly, which a chart library will fight. `DESIGN.md` § The Insight Surfaces specifies them.

### Proposed build order

The dependency chain is real; skipping ahead produces a demo with nothing to show.

1. **Activity events.** Turn `voice-activity.ts` RMS into start/stop/overlap events. Unlocks `float`, half the Hand, and every interruption measure. Cheapest, highest leverage, no AI required.
2. **Utterance transport + storage.** Protocol arms, DO persistence. Now the room has a corpus.
3. **`packages/groupthink` with fixture tests.** Write the detectors against a hand-written fake conversation that is *designed* to trip each one. This is also the regression suite and the demo script.
4. **Embeddings in the DO.** Now `convergence`, `drift`, and `echo` come alive.
5. **Insights panel + the Hand.** First thing a judge can actually see.
6. **Interventions.** The product thesis, and it needs everything above to exist.
7. **The Trace.** Highest visual impact per unit of risk once 4 is done — it is a projection of data you already have.
8. **Post-meeting report.** Reads `interventions` incl. the `_after` columns.

Whiteboard is not on this list. See `PRODUCT.md` § Explicitly deferred.
