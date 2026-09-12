# Architecture

How the groupthink analysis attaches to the existing meeting. `PRODUCT.md` says why, `GROUPTHINK.md` says what is measured, this file says where the code goes.

## The decision that shapes everything

Analysis runs **server-side, in the room's Durable Object**. Finalized utterances leave the browser.

This was a deliberate trade. The alternative — analysing in the host's browser — would have preserved the original "nothing touches our server" claim, but it puts the whole engine behind one participant's network, loses all state when they refresh, and gives every peer a slightly different answer. Server-side analysis gives one consistent view, survives reconnection, and makes the post-meeting report possible at all.

What it costs: the privacy claim narrows from "nothing" to "no media". `PRODUCT.md` § Brand Commitments defines the exact wording, and every surface making the old claim is now carrying a false statement that must be fixed.

What it does **not** cost, contrary to first assumption: **the CSP does not change.** Browsers only ever talk to the same origin for analysis — utterances go out over the signaling WebSocket that already exists, results come back over the same socket. The embedding and generation calls are made from the Durable Object, server to server. `connect-src 'self'` already covers it.

## Data flow

```
speaker's browser
  ├─ local STT (unchanged)          → interim + final text
  ├─ voice-activity.ts (extended)   → speaking start/stop/overlap events
  ├─ data channel  → peers          → captions, transcript, chat   [unchanged, P2P]
  └─ signaling WS  → MeetingRoom    → utterance + activity          [NEW]

MeetingRoom (Durable Object)
  ├─ persist utterance to ctx.storage.sql
  ├─ batch → embedding API (server-side fetch)
  ├─ feed packages/groupthink → derived state → detectors
  ├─ on fire + policy pass → generation API → intervention text
  └─ broadcast `analysis` / `intervention` to every socket in the room   [NEW]

every browser
  ├─ Insights panel   (new SidePanelTab)
  ├─ stage card       (intervention)
  ├─ The Hand         (radar, per participant)
  └─ The Trace        (semantic path over time)
```

Media, chat, and live captions never enter this path. They stay peer-to-peer exactly as they are today.

## Why the signaling socket and not a new endpoint

The Durable Object already holds an open, authenticated, origin-checked WebSocket to every participant, with hibernation handled. Utterances are a few hundred bytes. Adding message types to the existing socket costs one `switch` arm; adding an HTTP endpoint costs auth, rate limiting, and room-membership checks that the socket already solved.

`MAX_SIGNAL_FRAME_BYTES` (64 KiB) is far above what an utterance needs, and `MAX_TRANSCRIPT_CHARACTERS` (4 000) already bounds the text.

## Protocol additions

All in `src/protocol.ts`. Note that `parseClientMessage` currently hard-rejects anything whose `type` is not `'signal'` — it needs to become a switch, and every new arm needs the same defensive validation the existing one has. Untrusted input from a peer reaches this function directly.

```ts
// client → server (added to ClientMessage union)
| { type: 'utterance'; id: string; text: string; at: string; durationMs: number }
| { type: 'activity'; startedAt: string; endedAt: string; overlapped: string[] }
| { type: 'agenda'; text: string }   // host only; DO must verify isHost

// server → client (added to ServerMessage union)
| { type: 'analysis'; state: AnalysisSnapshot }       // throttled, ~every 5s
| { type: 'intervention'; intervention: Intervention }
```

```ts
interface AnalysisSnapshot {
  dispersion: number;            // D(W)
  entropy: number;               // H, airtime distribution
  driftDistance: number;
  hands: Record<string, number[]>;   // peerId → six axes
  trace: Array<{ peerId: string; at: string; xyz: [number, number, number] }>;
  active: Array<{ signal: SignalKind; severity: number; at: string }>;
}

interface Intervention {
  id: string;
  signal: 'convergence' | 'drift' | 'float' | 'echo';
  kind: 'counterpoint' | 'refocus' | 'invite' | 'deepen';
  text: string;
  evidenceUtteranceIds: string[];
  at: string;
}
```

`PeerMessage` is **not** extended. Analysis is not peer-to-peer — it comes from the room, to everyone, identically. Keeping that boundary clean is what makes "the group sees what the room sees" true rather than aspirational.

## Package layout

```
packages/transcribe   Live transcription core                        [exists, unchanged]
packages/groupthink   Detection engine — pure, no I/O, no network     [NEW]
apps/meeting          UI + Worker + Durable Object
```

`packages/groupthink` mirrors what `packages/transcribe` got right: a headless core with an explicit contract, no framework dependency, and tests that run without a browser or a network. It takes the event log and thresholds in, and returns derived state and fired signals out. Embedding vectors are passed *in* — the package never calls an API, which is what lets the whole detection model be tested deterministically with fixture conversations.

This split is also the honest answer to "what did you actually build" at judging: a detection engine, with a meeting app around it.

## Durable Object storage

`new_sqlite_classes: ["MeetingRoom"]` is already in `wrangler.jsonc`, so SQLite is available and currently unused — the DO persists nothing today.

```sql
utterances (id TEXT PRIMARY KEY, peer_id, text, at INTEGER, duration_ms, embedding BLOB)
activity   (peer_id, started_at INTEGER, ended_at INTEGER, overlapped TEXT)
signals    (id TEXT PRIMARY KEY, signal, severity REAL, at INTEGER, evidence TEXT)
interventions (id TEXT PRIMARY KEY, signal, kind, text, at INTEGER,
               dispersion_before REAL, entropy_before REAL,
               dispersion_after REAL, entropy_after REAL)
```

The `_before` / `_after` columns on `interventions` are the effect measurement from `GROUPTHINK.md` § 6. They are the most persuasive number in the demo. Write them from the first commit rather than retrofitting under time pressure.

Everything is deleted when the room closes, per `PRODUCT.md` § Operating Context.

## Server-side AI calls

Made from the Durable Object with `env.OPENAI_API_KEY`, which already exists for transcription tokens.

- **Embeddings.** Batch finalized utterances rather than calling per-utterance; the detectors run on window updates, not on every word. Cache by utterance id — an utterance is embedded exactly once. Verify the current embedding model and its dimension count against the provider docs before wiring it; do not hardcode a dimension the model does not return.
- **Generation.** Only on an intervention that has passed the full policy gate in `GROUPTHINK.md` § 6. At most five per meeting, so cost is negligible and latency is not on any hot path.
- Both are ordinary server-to-server `fetch` calls. No ephemeral tokens, no CSP entries, no browser involvement.

## Frontend additions

- `SidePanelTab` becomes `'chat' | 'transcript' | 'insights'`.
- The Trace needs **incremental PCA**, not t-SNE or UMAP. t-SNE and UMAP re-fit on every update and the points jump between frames, which destroys the one thing the visualisation is for — showing a *path*. PCA is stable, cheap, and incremental. Fit on the first window, then project.
- No charting library is needed or wanted. The radar is an SVG polygon over six axes; the Trace is projected points and a polyline. Both are a few dozen lines and both need to obey the design system exactly, which a chart library will fight. `DESIGN.md` § The Insight Surfaces specifies them.

## Build order

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

## Private reminder delivery and automatic prototype (implemented)

`private-notices.ts` holds one per-tab, in-memory store independent of `MeetingLog` and all transports. `show_private_notice` validates and copies evidence from the local log; `read_private_notices` exposes delivery status to the connected agent. `private-notice-ui.tsx` subscribes to this store for the compact dock and history panel. A local timer expires active reminders; room cleanup clears the store and invalidates registered tool handles.

PR #2 now also includes a scoped automatic detector, as requested for the private-reminder experiment. `auto-reminders.ts` polls new local finalized speech and calls the same-origin `/api/private-analysis` Worker endpoint. `worker/private-analysis.ts` embeds bounded speech context and uses structured Gemini generation to check for an unresolved explicit objection bypassed by a later decision. Only the objection author can receive the result. The controller handles cooldown, history, pausing, stale results and error backoff; no assistant session is needed.

This intentionally differs from the larger proposed build order above: no DO transcript persistence, room-wide detector package, global broadcast, reporting, or embedding cache is introduced. Analysis is stateless and per participant, with bounded context and repeated embedding costs. It does not implement all of the group-wide design. The current data flow and privacy copy are documented in README; the room-wide storage/deletion promises above describe the future design, not this implementation.
