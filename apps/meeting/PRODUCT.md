# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Small remote teams making decisions together, including product, research and strategy teams.
- Participants who want to preserve a question, examine an assumption, or contribute while someone else holds the floor.
- Facilitators and team leads who want grounded prompts when public discussion bypasses an objection, loses its goal, or repeats agreement without reasons.
- Teams that want participant media and shared work transported over encrypted WebRTC, with explicit information about the separate AI data paths.

## Product Purpose

Help participants think independently and bring their ideas into the shared discussion before a decision is made.

Weave In is an agent-native meeting app. Browser video, screen sharing, public chat, per-speaker captions and an editable shared whiteboard provide a common workspace. Three forms of assistance connect to it: personal **Muse**, shared **Omni**, and an external personal agent such as **Codex** through a WebMCP-capable browser.

Groupthink motivates the work: people can reach agreement before important doubts or alternatives receive attention. The implementation recognizes specific discussion patterns and asks grounded questions. It does not diagnose groupthink, read unexpressed opinions, or establish that a team has made a poor decision. Success means a participant can preserve, clarify and raise an overlooked concern while it can still affect the discussion.

## Positioning

**Weave In — Keep the thread. Weave everyone in.**

Private thinking, public conversation and asynchronous agent work belong in the same meeting workflow. A participant can discuss an idea with Muse, ask Codex to inspect code or research a question, and bring the result into Room or the shared whiteboard. Omni can prepare a public question when the discussion warrants one; a participant decides whether it may speak.

The meeting works in an ordinary supported browser. External-agent tool access requires a browser exposing WebMCP, such as Codex's in-app browser. Codex supplies its own research and coding capabilities; Weave In supplies the meeting context and shared workspace tools.

## Operating Context

- Browser meetings use full-mesh WebRTC for up to eight participants, six-character room codes, and invite links of the form `?room=CODE`. No account is required.
- Camera, microphone, screen share, public chat, files, whiteboard edits and captions travel over encrypted WebRTC between participants. Connections prefer a direct route; Cloudflare TURN can relay encrypted packets. TURN handles connection metadata and cannot decrypt WebRTC content.
- Each participant sends their own microphone audio directly to the configured caption provider, Gemini or OpenAI, using a short-lived credential issued by the Worker. The browser supplies speaker identity; caption wording and completeness remain dependent on recognition and connectivity. The meeting settings choose languages and caption style, not the provider.
- Muse and Omni use GPT-Live-1 with Responses delegation to `gpt-5.6-terra`. The Worker authorizes initialization and handles agent configuration, session settings and SDP. Selected meeting context, private conversation and permitted tool results subsequently travel directly between the browser and OpenAI.
- The room Durable Object coordinates membership, assistant identities, the elected Omni runner, leases, approval and public speaking turns. Public discussion and private conversations are not stored there. Room coordination is cleared when the room becomes empty.
- Automatic private reminder analysis is a separate browser-to-Worker-to-Gemini path. It sends bounded finalized human captions and prior automatic-reminder evidence for analysis without persisting those records in the Worker. It runs while the meeting page is open without an external agent session.
- Meeting text, reminders and up to 200 private Muse lines are checkpointed in same-tab `sessionStorage`, subject to size limits and a 12-hour expiry since the last save. Refresh/rejoin restores available text, not file bytes, the whiteboard, active audio or queued speaking approvals. Display name and caption settings use `localStorage`. Storage failures are surfaced as recovery limitations.

## Capabilities and Constraints

### Meeting and shared work

- Camera, microphone and screen sharing with live connection renegotiation; Room messages and shared files; per-speaker captions and a merged Transcript view.
- Captions default to enabled, automatic language detection and Verbatim style. Participants may select up to four supported BCP-47 languages or choose Smart captions.
- Files transfer on demand between browsers, up to 300 MiB each. Supported images, PDF, DOCX, Markdown and text have in-app previews with smaller format-specific size limits. Availability depends on a connected browser retaining the bytes.
- An Excalidraw-based shared whiteboard supports human drawing and structured agent reads and edits. Mermaid `flowchart` / `graph` imports, including subgraphs, become native editable nodes, bound text and arrows. Other Mermaid diagram families and image embedding are unsupported.
- WebMCP exposes available meeting records, shared-file download, screen capture, private reminders, public message posting, whiteboard capture, and structured whiteboard read/edit/import/undo/redo. Tool access belongs to the browser integration; Muse has its own scoped tool set and settings.
- Signaling reconnects automatically. Connected peers replay available public history and board state to late joiners. This is peer recovery, not a complete server archive.

### Muse

- One personal Muse is configured automatically on join and opens into private discussion. Text requests, microphone dictation into an editable draft, and continuous **Live** voice conversation are distinct controls.
- Live conversation and dictation pause the owner's public microphone and captions while capturing private input, then restore the meeting microphone state. Joining the room does not itself begin private voice capture.
- By default Muse may read everyone's public contributions, public chat, system signals, shared files and the whiteboard. Shared-screen access is off; Room posting is off. Owners can change public-source scope, chat/system inclusion, screen/file access, role instructions, language and Room-posting permission in Muse settings.
- Muse can inspect shared work during private requests and edit the whiteboard when asked. Posting to Room requires enabling that setting and requesting the specific public message. Tool availability and incoming meeting context do not themselves authorize shared actions.
- Automatic reminders identify an owner's explicit unresolved concern when later public speech moves toward a concrete decision that bypasses it. They use recent finalized human captions, not Room chat, silence or inferred private positions. The same concern may recur only on a substantive new commitment, execution or scope change, as judged by the model and checked against prior evidence.
- Private reminder cards appear silently at the lower left of the stage without reserving space or covering captions. They collapse after 15 visible seconds, pausing while hovered or focused; evidence and history remain in Muse. The history supports reading and dismissal, and reports analysis unavailability.
- **Discuss privately** asks Muse to help consider the reminder. **Speak for me**, or **Send** on a completed private Muse reply, authorizes one faithful public reading of only that selected text. A fresh session receives no private history or tools, omits Markdown marks, and does not elaborate or make new commitments. The owner's public microphone stays in its current state; owner speech cancels pending or active Muse speech without automatic resume. Every later spoken turn requires a new approval.
- Private conversations and reminders stay out of public replay and the meeting log. Selected shared content and approved speech are visible to the room with assistant attribution.

### Omni

- One shared Omni is enabled automatically for the room. A ready foreground browser with working speech monitoring runs it; another eligible browser can take over if the runner leaves, moves to the background or loses monitoring. Speech already being published keeps its valid turn until completion or expiry, and Omni handoff does not revoke personal Muse audio. Any participant may edit its settings. The host or its owner may remove it; removal keeps it off until explicitly added again.
- Omni automatically reviews public finalized speech and Room chat for four categories: premature closure (`convergence`), sustained goal departure (`drift`), domination (`float`), and agreement without new information (`echo`). It uses semantic model review, evidence validation and abstention, as specified in [GROUPTHINK.md](GROUPTHINK.md).
- Preparation requires fresh public discussion and a quiet interval. Omni prepares a question of at most 240 characters silently, then waits for **Allow Omni to speak** or a fresh local finalized “Omni, go ahead” / “Omni，請發言” caption. Approval authorizes only that prepared question. New discussion or an expired draft cancels it.
- After approval, Omni waits for a quiet public turn, speaks to everyone and appears in Transcript. It does not publish each question as a Room chat message or edit the whiteboard. Its persistent Room card shows analysis and playback statuses, approval and Stop controls; only the Allow Omni to speak button glows while waiting for approval. Clicking the glowing button approves that question. Settings replace the card content inline.
- The room enforces a 30-second review interval, 120 seconds between confirmed publications and at most five confirmed publications while it remains occupied. Review waits when no eligible foreground browser is available. Fresh discussion received while unavailable remains eligible on return; historical replay alone does not trigger a review. These are cost and interruption limits, not measures of detection accuracy.

### Current limits

- There is no validated groupthink diagnosis, participant personality score, semantic-dispersion dashboard, Insights tab, Hand radar, Trace trajectory or post-meeting intervention report. Those older visualization concepts are not the current detection algorithm or interface.
- Automatic private reminders and Omni are separate systems with different inputs, providers and approval paths. Muse source settings do not configure automatic reminder analysis.
- Available context is bounded by the records in the current browser and application input budgets. An assistant may need to fetch earlier records or file pages, and must report unavailable context rather than imply it has read the entire meeting.
- No account system or meeting-media recording is implemented. Browser checkpoints are local recovery data, not a permanent meeting archive.

## Brand Commitments

- Name: Weave In. Tagline: “Keep the thread. Weave everyone in.” Landing-page language: English.
- The landing demonstration is an explicitly illustrative React/CSS/SVG conversation. Its statements demonstrate the workflow; they are not real users, testimonials or measured outcomes.
- Indigo meeting surfaces, cotton text, human thread colors and gold actions form the visual identity. Assistants retain explicit names and neutral public transcript styling rather than receiving human video tiles.
- Privacy copy distinguishes participant WebRTC/TURN, direct AI-provider connections, Worker processing and local recovery storage. Never imply all traffic stays in the browser, every connection is direct, or the Worker never receives transcript text. Keep landing and README claims synchronized with these paths.
- Signals identify discussion evidence and a useful question, not a verdict about a person. Do not claim validated detection, improved critical thinking or better decisions without outcome evidence.

## Evidence on Hand

- Implemented behavior is in [src/App.tsx](src/App.tsx), [src/agents](src/agents), [src/webmcp.ts](src/webmcp.ts), the whiteboard modules and [worker](worker).
- [VERIFICATION.md](VERIFICATION.md) describes reproducible tests and the limits of browser/provider verification. [GROUPTHINK.md](GROUPTHINK.md) describes Omni's actual review policy.
- There are no documented customer, testimonial, pricing or outcome metrics to use as product proof.

## Product Principles

1. **Preserve independent thinking.** Give people a private place to clarify an idea and an explicit path to share it.
2. **Respect the audience.** Private replies, requested shared edits, Room posts and public speech have different authorization boundaries.
3. **Keep decisions with participants.** Muse needs approval for each public reading; Omni needs approval for each prepared question.
4. **Ground the prompt.** Use explicit discussion evidence, examine intervening replies and abstain when meaning or novelty is uncertain.
5. **Make shared work editable.** People and agents should continue working on the same board objects and visible results.
6. **State the actual limits.** Describe data paths, local-history coverage and model uncertainty accurately.
7. **Keep entry simple.** A link, a name and a room; agent settings remain available when needed.
