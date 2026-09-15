# Weave In meeting

Browser-native meetings with a personal **Muse** and a shared **Omni**. Muse gives silent private reminders, supports private discussion with meeting and file context, and can edit the shared whiteboard when its owner asks. Room posting is disabled unless its owner enables that permission and requests a public message. It can speak publicly for its owner once they select a completed Muse reply or approve a specific reminder. Omni prepares automatically and speaks its prepared question publicly only after a participant approves by button or voice. React/Vite runs the assistants; a Cloudflare Worker initializes GPT-Live and a Durable Object coordinates room signaling and assistant ownership. Automatic reminder analysis sends bounded transcript context through the Worker to Gemini.

The **Muse** tab opens the personal assistant conversation directly, with a settings button beside its name. Muse is configured automatically on join; its owner can edit instructions, language, sources and tool permissions without losing conversation history. The **Room** tab contains a persistent Omni status card above shared messages. Omni is created automatically with the room. After removal, the plus button to the right of its heading adds it again with default settings. Its settings button opens a full Room-panel settings page with Back to Room at the top. Personal settings similarly provide Back to Muse. Back discards unsaved edits. Any participant can change Group settings; the creator or host can remove it. The **Allow Omni to speak** button glows only when a prepared question is waiting for approval; click the glowing button to let Omni speak. Analysis and playback have separate text statuses. Settings save only after room confirmation and stop work using old permissions.

The landing page (`src/landing.tsx`) introduces the meeting and its assistants with a woven visual identity. The **About** links in its navigation and footer open `/about`, where `src/about.tsx` renders [PROJECT-NARRATIVE.md](PROJECT-NARRATIVE.md) directly. Brand assets live in `src/brand.tsx` and `public/`.

From the repository root, use `pnpm dev` to start development and `pnpm check` for the complete automated gate. The dev command first builds the transcription workspace package, then prepares whiteboard assets and starts Vite. Rebuild the transcription package after changing its source during development. App-specific commands run from `apps/meeting`:

```bash
pnpm dev
# Before running app-only checks on a fresh checkout:
pnpm --filter @weave-in/transcribe build
pnpm test
pnpm build
pnpm deploy:dry-run
```

## Documents

| File | What it settles |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Product behavior, audience and scope |
| [GROUPTHINK.md](GROUPTHINK.md) | Implemented intervention policy, evidence rules and limits |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current data flow, routes, protocols, storage and code ownership |
| [VERIFICATION.md](VERIFICATION.md) | Reproducible checks, historical evidence and remaining verification |
| [DESIGN.md](DESIGN.md) | Design system and current interaction surfaces |
| [PROJECT-NARRATIVE.md](PROJECT-NARRATIVE.md) | English project story and source for the About page |
| [PROJECT-NARRATIVE.zh-TW.md](PROJECT-NARRATIVE.zh-TW.md) | Original Traditional Chinese project story |

## The meeting

- If a duplicated tab inherits an identity that is still connected, its initial join retries once as a new participant. Copied local history is cleared so the new identity cannot replay the original participant's words. Automatic reconnections keep the existing identity. Rejected joins show the server's reason, such as a full room.
- The room removes connections that have sent no valid message for 90 seconds, checked on admission and by a 10-second cleanup alarm. The existing meeting heartbeat keeps quiet participants present. An expired connection no longer occupies a seat or blocks rejoining with the same identity.
- Invite links can reopen a room: if no host is connected, the next person joining becomes host under the same room code. A fully empty room starts a new meeting timer; if guests remain, the existing timer is preserved. Joining an active hosted room still makes you a guest. The server does not archive prior chat or captions; a returning browser can restore its own same-tab checkpoint, and connected peers replay their own history.

- The header shows time since the room was created (`mm:ss`, then `h:mm:ss`). The signaling server supplies the shared start time and its current time, so late joiners see the room's duration without depending on their device clock matching the server. Socket attachments retain the timestamp through Durable Object hibernation. A new room starts a new clock.
- Up to eight participants in a full-mesh WebRTC room. Each controller obtains short-lived Cloudflare STUN/TURN configuration before joining; browsers use direct connections when possible and relay encrypted packets when necessary.
- Camera, microphone, and screen sharing; tracks are added and removed with perfect negotiation. The shared Excalidraw whiteboard supports native shapes, text, freehand drawing and editable Mermaid flowcharts. Scene changes synchronize over the room data channel and replay from connected peers; the board is not saved in the tab checkpoint or on the server.
- Chat and live transcript are shared over a per-peer WebRTC data channel. Chat renders Markdown, including headings, lists, links, task lists, tables, and fenced code blocks. Enter sends; Shift+Enter adds a line. Raw HTML is disabled, and remote Markdown images appear as links.
- Files shared in chat (picker or drag-and-drop, up to 300 MiB each) are announced by metadata. Room chat keeps compact file cards; files are fetched on demand by Preview, Download, or an assistant tool with file permission. Preview opens a viewport-sized modal with transfer progress, retry on failure, a reload action when the sharing participant reconnects, a close button, and Escape dismissal. Transfers use a dedicated peer-to-peer data channel (`file:<transfer id>`, 64 KiB chunks with `bufferedAmount` back-pressure) and are cached in memory for preview and saving. Late joiners get the announcements when their channel opens; files already received remain viewable after their owner leaves. See `src/file-share.ts`.
- Previews support PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, PDF, DOCX, UTF-8 text, and Markdown. Image/PDF/DOCX previews are limited to 20 MiB; text/Markdown previews to 1 MiB. Larger or unsupported files remain downloadable. PDF previews have page navigation and selectable page text. DOCX previews retain headings, emphasis, lists, and tables, with sanitized HTML; embedded images and exact Word page layout are not reproduced. Password-protected PDFs must be saved and opened separately. PDF and DOCX readers load on demand from the app itself; no external document viewer receives the file. PDF.js uses JavaScript decoding (`useWasm: false`) under the existing script CSP.
- Late joiners get the past from the people who were there: when a newcomer's channel opens, each existing participant replays its **own** chat messages and finalized captions (`history` batches under 16 KiB, at most the last 400 entries) and re-announces its files. Nobody relays anyone else's words, so a newcomer's browser cannot retrieve an absent participant's words from peers or the server. Existing browsers retain records they already received. The newcomer merges replays by time, marks them `replayed: true` in the record, and draws a "You joined" rule in the panels. See `src/history.ts`.
- Every browser keeps the meeting record (`src/meeting-log.ts`): finalized captions with their speaker, chat, file announcements, joins and leaves, numbered by revision so a reader can resume from a cursor. Agent transcript fragments update a stable record ID and receive a fresh cursor.
- Each participant transcribes only their own microphone and streams finalized and interim text to everyone else. Speaker labels come from the sending participant rather than inferred diarization. Browser echo cancellation reduces remote playback entering that microphone; acoustic leakage can still affect attribution.
- Captions use Gemini or OpenAI. The Worker mints short-lived ephemeral tokens from its `GEMINI_API_KEY` or `OPENAI_API_KEY` secret (Gemini is preferred when both exist; set `TRANSCRIPTION_PROVIDER=openai` to override) and the page adopts whichever provider the Worker reports. Without a key the meeting still works, but captions are reported as unavailable.

## WebMCP

When the browser exposes `navigator.modelContext` (or `document.modelContext`), the room registers eight tools while a meeting is open and removes them on leave (`src/webmcp.ts`). Everything they return is this browser's own copy of the room; the Worker is not involved. The built-in Muse assistant calls the shared implementations directly and does not require browser WebMCP support.

| Tool | Input | What it does |
| --- | --- | --- |
| `read_meeting` | `after?`, `limit?` | Room code, participants, caption status, live (unfinalized) captions, the current file list, and the meeting record from sequence number `after` onward. Pass the returned `nextCursor` back as `after` to read only what is new. |
| `download_file` | `fileId`, `offset?`, `length?` | Fetches the file from the participant who shared it (peer-to-peer, cached afterwards) and returns a slice: UTF-8 text for text files, base64 otherwise. Continue from `nextOffset` until `eof`. Default slice 1 MiB, maximum 8 MiB. |
| `capture_screen_share` | `maxWidth?`, `format?`, `quality?` | A still image of the screen currently being shared (yours or another participant's), as the room sees it, returned as an MCP `image` content block next to a text block naming the presenter and the dimensions. When nobody is sharing, the text block says so. |
| `edit_whiteboard` | `action`, action-specific inputs | Reads the shared board or edits native elements, imports an editable Mermaid flowchart, and undoes or redoes eligible changes. Muse uses editing actions only for a direct owner request. |
| `capture_whiteboard` | `maxWidth?`, `format?`, `quality?` | Captures the drawing canvas so the assistant can inspect a board or verify an edit. Muse opens the board in this browser when it needs a capture. |
| `send_chat_message` | `text`, `agent?` | Posts to chat on behalf of the participant using this browser. Every screen labels it "<name>'s agent" (with the `agent` name as a tag) rather than as something they typed. |
| `show_private_notice` | `id`, `text`, `evidenceSeqs`, `ttlSeconds?` | Places a contextual reminder in this browser's private notification. Cite 1–5 speech/chat sequence numbers from `read_meeting`; text is limited to 240 characters. Stable ids make retries safe within the retained history. |
| `read_private_notices` | none | Reads private history and lifecycle statuses. Does not publish anything to the room. |

### Whiteboard limits

The shared scene uses native Excalidraw elements. The compact shape model is an internal planner for structured tool edits; it is not a second room protocol.

| Boundary | Limit |
| --- | --- |
| Shared scene | 1,000 native records, including bound labels and deleted elements |
| Native record | 16 KiB serialized peer frame; up to 4,000 characters per text field and 2,000 points per stroke |
| Structured tool edit | 1–50 operations committed as one undo step; note, rectangle, diamond, text, pen or connector |
| New/updated tool fields | Text up to 500 characters; pen strokes 2–256 points; coordinates ±20,000; dimensions 20–1,200 |
| Read page | External WebMCP up to 100 native records; Muse up to 10 compact records; continue with `nextOffset` |
| Mermaid tool import | `flowchart` / `graph` only; 12,000 source characters and 300 converted native elements, including labels |

Tool edits preserve untouched native fields even when their values exceed the narrower structured-input limits. Edit bound text through its container's ID. Mermaid import adds a new diagram and preserves existing content; nested subgraphs, branch labels and loops are supported. A pinned converter patch handles Mermaid 11's diagram-prefixed group IDs. Other diagram families, initialization directives, images and embeds are unsupported by the tool. The native UI's **More tools → Mermaid to Excalidraw** is a separate manual importer; the resulting scene still passes native record validation.

External `capture_whiteboard` requires an open board and a completed text edit. Muse opens the board when needed. Captures show the current viewport without toolbars; they do not guarantee off-screen elements are visible. Closing the board does not clear it or stop synchronization. Export before all participants leave: scene contents are held in memory, not saved in the tab checkpoint or on the server.

Source contracts: [whiteboard-webmcp.ts](src/whiteboard-webmcp.ts), [excalidraw-store.ts](src/excalidraw-store.ts), [agents/tools.ts](src/agents/tools.ts).

### Private reminders

Private reminders float at the lower left of the video stage, above the meeting controls, without resizing the video or footer. No empty reminder card is shown. A popup collapses after 15 seconds of unattended display; pointer hover, keyboard focus, or insufficient space to avoid captions pauses the countdown. Placement avoids visible captions and error messages. A newer reminder does not replace the popup currently being read; the latest eligible reminder can appear after it closes. Expired/dismissed reminders are not newly surfaced.

**Later**, the close button, and timeout only collapse the popup: they do not dismiss it or mark it read. The **Muse** tab shows an unread dot and combines private reminders, evidence, and personal assistant discussion. Expanding history marks reminders read. Collapsed/read states survive same-tab room recovery. The underlying active-reminder TTL remains 120 seconds by default (15–300 configurable), independently of popup display time. Screen sharing can reveal visible private content.

Reminder state is private to this tab and checkpointed in sessionStorage for same-room recovery. It is never added to the shared meeting log, peer messages, server storage, or localStorage. Automatic monitoring runs in ordinary browsers while the meeting page is open; no MCP or assistant interaction is required. Existing WebMCP tools remain available as an optional manual delivery path. Use **Discuss privately** to bring a reminder into Muse, or **Speak for me** to approve one public reading of that reminder. Neither action requires an external assistant or a Codex browser.

Example, after reading sequence 42 from the current meeting:

```json
{"id":"maintenance-cost","text":"Your maintenance-cost question is still unanswered, and the group is preparing to decide.","evidenceSeqs":[42],"ttlSeconds":120}
```

Tool results are `{ content: [{ type: 'text', text: <JSON> }] }` (plus an `image` block for screen captures), with `isError: true` and `{ ok: false, error }` on invalid input. `read_meeting` also reports `screenShare.presenter` so an agent knows when a capture is worth taking.

## Muse and Omni

Muse’s **Live** button opens a continuous private `gpt-live-1` WebRTC conversation. Speak naturally, interrupt, and continue after each answer on the same connection; **End** closes it and restores the meeting microphone. The microphone icon still dictates an editable draft. Live audio stays private, while permitted meeting context and tools remain available. Leaving, disconnecting, or saving changed settings stops the session; it is never automatically resumed. Application input budgets still apply, and background updates can pause to reserve tool capacity.

Muse is configured automatically when a participant joins. Open **Muse** for reminders and private discussion. Automatic reminders are silent and do not start an audio session. The microphone starts private dictation and temporarily isolates the microphone from the meeting. Stop finalizes the transcription into an editable draft without contacting Muse. Send during recording finalizes the last words, restores the meeting microphone and submits the text; ordinary text uses the same Send action. While Muse is connecting or responding, Send becomes a square Stop response control and returns to the arrow when finished or stopped. Dictation never enters shared captions or conversation history until submitted.

New personal assistants include everyone's available public transcripts and Room chat, with shared file and image reading enabled. Shared-screen capture stays opt-in, and Room posting is disabled by default. Muse receives recent records and a file inventory, retrieves older records or file contents as needed, and can use the whiteboard tools during private interactions. Ask “Turn the discussion into a flowchart on the whiteboard” or “Read the uploaded design and draw its workflow.” Whiteboard edits synchronize with the room; Muse's spoken replies stay private. Drawing uses editable shapes and diagrams, not generated image assets.

Background meeting updates and content inside transcripts, files, images, screens, and the board never authorize a shared action. Muse is instructed to edit only when its owner directly requests it, and the runtime disables shared actions outside an active owner interaction. Room messages additionally require the **Allow posting to Room (visible to everyone)** permission, which is unchecked by default. Without it, Muse does not receive the public-posting tool. After enabling it in Muse settings and choosing **Save settings**, the owner must still request a public message; permitted posts are labelled as the owner's agent. It can inspect the shared whiteboard independently of the transcript source setting; file and screen access still require their respective permissions. Existing assistant configurations retain their settings until saved through **Muse → Settings**. Saving stops work using the previous permissions and keeps the private conversation.

**Send** is an icon vertically centered on the right of a completed private Muse reply. It appears on hover or keyboard focus with a subtle message background; touch users tap the message to reveal it. It approves reading that message aloud to everyone. It is unavailable while Muse is responding, for interrupted replies, user messages, or public messages. A visible **Stop** control cancels public speech. **Speak for me** on a reminder uses the same one-turn public read-aloud flow. Muse uses a fresh session with only that approved text, without personal conversation history or meeting tools. It is instructed to read the complete selected text faithfully in its original language, omitting Markdown formatting, without summarizing or adding information. The public turn has a ten-minute safety timeout and ends when playback finishes; disconnected speakers still lose their turn after the heartbeat lease expires. Public output is labelled as the owner's Muse. The owner's microphone remains in its existing state; speaking on an enabled microphone stops the assistant and revokes any queued public turn. It does not resume automatically. A new spoken turn requires another click. There is no persistent public-audience mode.

The **Room** tab holds shared messages and the Omni status card. Omni is created automatically when the room starts and begins watching public discussion; any participant can edit its settings. There is no manual review trigger. Once Omni has a question ready, approve with Allow Omni to speak or say “Omni, go ahead” / “Omni，請發言” with captions enabled. The elected foreground browser with working speech monitoring checks for new finalized human captions or Room chat every two seconds, after at least four public records and a 1.5-second quiet period. The room authority allows at most one review per 30 seconds, waits 120 seconds between interventions and caps them at five per room. Replayed history and agent output alone never start reviews. Model output selects one grounded intervention: counterpoint for premature closure, refocus for sustained drift, invite for domination in a room with at least three people, or deepen for repeated agreement without reasons. Answered concerns, supported agreement and uncertain evidence yield no message. See `GROUPTHINK.md` for exact policy and limits.

Omni validates the selected public evidence and waits for participant approval before reading one question of at most 240 characters aloud, with a public transcript. It does not edit the whiteboard. Changed discussion before output, cancel, a 120-second draft expiry, changed settings or runner replacement requires a new review and approval. Publication still waits for a quiet moment and an available public floor. The speaking session receives only the approved question, without tools or background context. Personal conversations and private reminders never enter Group context. A runner that moves to the background or loses speech monitoring yields Omni to another available foreground participant without disabling Muse audio; speech already being published keeps its valid turn until completion or expiry. If no device is available, review waits until one returns. Runner replacement retains room cooldown/count/deduplication state and uses only the public history available on the replacement browser. Fresh discussion received while unavailable remains eligible; replayed history alone still cannot trigger review. Public transcripts replay to late joiners without duplication.

`OPENAI_API_KEY` is required for Muse and Omni, even when captions and automatic reminders use Gemini. Model constants are in `src/agents/contracts.ts`. Browser audio activation may be needed for Muse’s spoken replies; creating the personal configuration on join does not itself open a continuous Live connection. The settings button in Muse edits source and tool permissions in place.

Muse is instructed to choose available tools and their sequence from the user's goal, existing context and tool schemas; users do not need to name MCP tools. It retrieves missing meeting/file/visual information, performs only requested shared actions, and verifies their result. New node-and-connection diagrams may use Mermaid `flowchart`/`graph`; precise layouts, annotations and changes to existing objects use native whiteboard edits. Other Mermaid diagram families are not supported. Tool selection remains model behavior rather than a deterministic router, and does not expand permissions.

The client currently applies a conservative 30,000-byte / 120-item cumulative budget to its Live input events. This application guard is not a claim about the model's context window. It seeds at most 6,000 UTF-8 bytes of recent records, private conversation and a scoped participant/file inventory, sends only new background records, and reserves capacity for the current question and tool results. `read_meeting` defaults to and accepts up to 500 complete permitted records per page. Muse is instructed to read from cursor zero through every available page before its first meeting-based request, then refresh from the last successfully consumed cursor. A large page may exceed the remaining application budget; the client returns an explicit error without silently truncating it. Thus 500-record tool pagination does not establish that the full transcript reaches the model in one interaction. Muse has no separate meeting-search or raw-download tool. Shared files are inspected on demand rather than automatically copied into context. Native WebMCP keeps its existing limits. An interaction that exhausts its budget stops with a visible message; a new question starts a fresh session.

The agent's `read_meeting` file inventory has its own `fileOffset` cursor, with up to 20 files per page. `read_shared_file` accepts those file ids, fetches an uncached file automatically from its sharing participant, and returns visible images, UTF-8 text/Markdown, DOCX extracted text, or a selected PDF page. Text pages contain up to 6,000 UTF-16 code units and return `nextOffset`; PDF results also report physical page counts and `nextPage`. A PDF page with no extractable text automatically includes a rendered image, and `render: true` includes figures/layout on other pages. This is not a separate OCR pipeline. DOCX embedded images and physical page layout are not extracted. Source files are limited to 1 MiB for text and 20 MiB for images/PDF/DOCX; DOCX declared ZIP expansion is capped at 50 MiB. Images are resized to at most 1,600 pixels on their longest edge and further compressed as needed for the remaining Live context. The native browser WebMCP `download_file` tool remains separate and is not exposed to Muse. Agent board reads return up to ten compact elements per page; successful edits return metadata before a separate capture verifies the rendered result.

Context coverage is limited to records and file announcements available in this browser, including its same-tab recovery and connected peers' history replay. There is no server archive of the whole meeting. An uncached file cannot be fetched after its sharing participant leaves; a cached file may remain readable. Muse must report missing or unreadable content instead of treating its inventory as proof that it has read everything.

When continuous background updates reach their reserved input budget, Muse shows that updates have paused and informs its reasoning backend that prior snapshots may be stale. The current tool workflow can still finish. The backend is instructed to fetch current meeting details for each new meeting-related request. A fresh text interaction or ending and restarting Live provides a new context budget; another spoken turn in the same Live connection retains its cumulative budget.

To test the current tools with default instructions and permissions, create a fresh test room. In an existing room, inspect **Muse → Settings** first. Update the file, screen, and Room-posting permissions directly, then choose **Save settings**; the existing conversation is preserved. Whiteboard tools need neither screen-capture permission nor a browser MCP extension.

For a manual voice test:

1. Open the latest frontend in a fresh test room and invite another participant. Enable captions, discuss a short workflow, and confirm that both speakers appear in **Transcript**.
2. Have the other participant upload a small image, PDF, or text file in **Room** and stay connected so Muse can fetch it.
3. In **Muse → Settings**, confirm **Allow posting to Room (visible to everyone)** is unchecked. If you change it, choose **Save settings**; otherwise choose **Back to Muse**. Click the microphone and dictate, “Use our discussion and the uploaded reference to draw the workflow on the whiteboard. Keep your reply private.”
4. Click **Stop recording** to review the draft, then **Send** (or click **Send** while recording). Check that the whiteboard opens and both participants see the diagram. Muse's spoken response should stay private, and no assistant message should appear in Room.
5. Confirm that dictation alone produces no assistant response, Stop retains editable text, and the meeting microphone returns to its previous state.

To test public posting separately, open **Muse → Settings**, check **Allow posting to Room (visible to everyone)**, choose **Save settings**, then explicitly ask “Post the agreed steps in Room chat.” Verify that both participants see the message with the owner's agent attribution. To revoke posting permission, uncheck the same setting and save again. Saving stops any current assistant work and preserves the private conversation.

## Automatic private analysis

Each browser checks for new finalized **speech** every five seconds, with at least 30 seconds between analyses. It sends up to 40 recent utterances (bounded request size) and up to 20 previous automatic reminders with their original concern and decision evidence (also byte-bounded) to `/api/private-analysis`. Chat, interim captions, files, and assistant messages are not analyzed. Replayed history alone does not trigger a notification. The Worker calls Gemini Embedding (`gemini-embedding-001`, 256 dimensions) to identify related earlier speech and neighboring replies, then Gemini Flash (`gemini-3.6-flash`) evaluates that context with the complete bounded window and returns a structured decision.

The first detector covers **an explicit unresolved objection bypassed during a later decision**. The server derives the recipient from the objection's author and returns a notice only to that person's browser. It validates both evidence references and decision recency. No public message, assistant action, or broadcast is generated. Event IDs combine the concern and decision sequence numbers. History retains the original evidence even after a reminder is closed or dismissed. The same concern can recur only for a substantive new commitment, execution starting, or a material scope change; repeating or paraphrasing the same decision does not qualify. Structured validation rejects repeated or older decisions and invalid links to prior events. Semantic novelty is still judged by Gemini. A 120-second cooldown prevents closely spaced reminders; time passing alone never triggers one. Leaving the meeting cancels the browser request and discards late results; the upstream provider request may already be processing. If new speech arrives during analysis, the result is discarded and re-evaluated on the next check. Provider errors show an unavailable/retrying state with a 60-second backoff, without interrupting the meeting.

Private reminder analysis is bounded and independent per browser: it has no shared room corpus, embedding cache, cross-browser analysis coordination or persistent report. The separate Omni path coordinates four public intervention categories through the room authority. Each participant analyzes their local view, so costs scale with participant count, background-tab throttling can delay checks, and incomplete context can cause misses. Embeddings provide semantic retrieval hints; the model still decides whether an objection remains unresolved. The browser must stay open and connected to receive new speech. This does not run after the tab closes or wake an assistant.

## Privacy

Camera, microphone, screen share, chat, files, whiteboard edits, and captions use encrypted WebRTC connections between participants. A connection may be direct or pass through Cloudflare TURN. TURN forwards encrypted packets and processes connection metadata (such as IP addresses, ports, and session timing); it cannot decrypt the WebRTC content. The signaling Worker has a separate role: it exchanges SDP/ICE connection metadata and issues short-lived credentials. Meeting media and data-channel payloads do not pass through that Worker. See [Cloudflare's TURN privacy explanation](https://developers.cloudflare.com/realtime/turn/faq/#what-data-can-cloudflare-access-when-turn-is-used-with-webrtc).

Caption audio goes directly to the selected provider. Selected assistant context, permitted file/image and shared-screen results, whiteboard contents/captures, and private assistant conversations go directly to OpenAI after initialization. New personal assistants allow file/image reading by default; shared-screen capture is opt-in. The Worker receives assistant settings and connection setup, but does not store assistant conversation records. Private discussion is not automatically published. Shared whiteboard edits require a direct owner request; Room messages also require the separately enabled posting permission, which defaults to off. Only the selected message or specifically approved reminder enters a speak-for-me session; Omni receives public context only.

Automatic analysis separately sends recent transcript text and previous automatic reminders through the Worker to Gemini. The Worker does not persist this data or embeddings. Reminder history is checkpointed in the receiving tab's sessionStorage for same-room recovery. Google processes the supplied text under the configured Gemini service's terms; this implementation makes no claim about provider retention. The landing page discloses this data flow.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, configure `TURN_KEY_ID` and `TURN_KEY_SECRET`, and optionally set a caption provider key. TURN configuration is required to enter a room. Missing or unavailable credentials produce a join error so a room cannot silently appear connected without relay support. Ordinary CI uses mocked credential responses and does not need live secrets.

### Cloudflare TURN setup

The `weave-in-meeting` Worker and its TURN service use the **JacobLinCool** Cloudflare account. TURN usage is billed to the account that owns the TURN key. See the [current TURN pricing](https://developers.cloudflare.com/realtime/turn/faq/#how-much-does-cloudflare-realtime-turn-cost) before provisioning another account.

1. Open the [Cloudflare Realtime dashboard](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fcalls) and select the account.
2. In **TURN Server**, choose **Create** and name the key `weave-in-meeting`.
3. Save **Turn Token ID** as `TURN_KEY_ID` and **API Token** as `TURN_KEY_SECRET` in `.dev.vars`. Keep both values out of source control, browser code, and logs. These are separate from the GitHub Actions deployment token. Cloudflare's [TURN setup example](https://github.com/cloudflare/speedtest/blob/main/example/turn-worker/README.md#creating-a-new-realtime-turn-app) shows these fields.
4. Set both values as secrets on the Worker used by the environment. The following commands prompt for each value; run from the repository root with the account that owns the Worker selected:

   ```bash
   pnpm --filter @weave-in/meeting exec wrangler secret put TURN_KEY_ID --name weave-in-meeting
   pnpm --filter @weave-in/meeting exec wrangler secret put TURN_KEY_SECRET --name weave-in-meeting
   pnpm --filter @weave-in/meeting exec wrangler secret list --name weave-in-meeting
   ```

Creating a TURN key through the Cloudflare account API requires **Calls Write** permission. Managing Worker secrets requires Worker write permission. Provisioning secrets does not replace the GitHub Actions deployment process below.

The browser posts `{}` to same-origin `/api/ice-servers`. The Worker generates credentials with a 24-hour TTL, validates the provider response, removes port 53 URLs, and returns only ICE configuration and its expiry with `Cache-Control: no-store`. UDP, TCP, and TLS options (including ports 5349 and 443) remain available. The endpoint has an independent limit of 20 requests per IP per minute and an eight-second upstream deadline. Each meeting controller shares one credential request across its peers and signaling retries, so an eight-person room sharing one public IP ordinarily needs eight initial requests.

The controller renews credentials before expiry, updates existing peer connections with `setConfiguration()`, and requests ICE restarts to replace allocations using the old credentials. It rechecks expiry before creating a peer, negotiating, or restarting ICE. Failed renewal has three attempts with backoff and jitter, then reports an error and makes one final attempt at expiry; entering the room again also retries provisioning. Successful renewal clears the corresponding error. Peer recovery waits five seconds for a transient disconnect and allows at most three ICE restart attempts per outage. Leaving a room aborts pending provisioning and cancels renewal and recovery timers. Production retains the browser's default ICE policy so direct connectivity remains available.

### Verifying TURN

`scripts/verify-turn-relay.js` is an opt-in Playwright CLI `run-code` script for a running local preview or deployed site with TURN configured. It makes real Cloudflare calls and transfers synthetic audio, video, and data. Open the site in an isolated test browser and click the page once to enable Web Audio, then run:

```bash
playwright-cli run-code --filename /absolute/path/to/Weave-In/apps/meeting/scripts/verify-turn-relay.js
```

The script creates two peers for each of three configurations: all supported TURN transports, TCP only, and TLS on port 443 only. Every peer uses `iceTransportPolicy: 'relay'`. It verifies both directions of data transfer and received media, and checks both peers' selected candidate pairs via `getStats()` for relay candidates. The TCP and TLS cases also require the matching `relayProtocol`. Output omits credentials, addresses, and candidate URLs. Restricting candidates tests the specified transport without changing the machine's firewall; repeat on the target restricted network before a demo.

Also exercise a normal room with camera, microphone, screen share, chat, file download, and whiteboard edits; include a late participant, signaling reconnect, and downloading a file after its owner reconnects. A successful credential API response or direct same-network connection alone does not prove relay connectivity. For a release, record the target environment, relay check results, GitHub Actions deployment result and production smoke test separately from local unit/browser checks.

## Deployment

Public URL: [https://weave.nycu.ai](https://weave.nycu.ai/).

Deploy through GitHub Actions only. Use a push to `main` or the workflow's manual trigger; local development may run builds, tests, and deployment dry runs. The workspace exposes `deploy:dry-run` for local validation; publication is handled by the workflow.

The [GitHub Actions workflow](../../.github/workflows/deploy.yml) runs `pnpm check` for pull requests targeting `main` and pushes to `main`. After a successful check on `main`, it deploys the verified build to the `weave-in-meeting` Cloudflare Worker, including static assets and Durable Object migrations. The Actions tab also supports **Run workflow**; select `main` to deploy. Manual runs on other branches only run checks. Deployments run one at a time without interrupting an active deployment.

Configure these repository secrets in [Settings → Secrets and variables → Actions](https://github.com/JacobLinCool/Weave-In/settings/secrets/actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the Worker. |
| `CLOUDFLARE_API_TOKEN` | An API token created with the **Edit Cloudflare Workers** template, scoped to that account. |

See [Cloudflare's GitHub Actions authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) for account ID lookup and token creation. Missing deployment secrets fail the deployment step with an explicit error; pull request checks do not require them.

Production transcription keys are Worker secrets, configured separately from the GitHub deployment credentials. Configure provider keys for the capabilities you need from the repository root:

```bash
# Gemini captions and automatic private reminders:
pnpm --filter @weave-in/meeting exec wrangler secret put GEMINI_API_KEY
# Muse, Omni, and optional OpenAI captions:
pnpm --filter @weave-in/meeting exec wrangler secret put OPENAI_API_KEY
```

The workflow uses the pnpm version in `package.json` and the Wrangler version in `pnpm-lock.yaml`. Local `.dev.vars` files are ignored by Git and are not part of the CI checkout.

## Search and link previews

The initial HTML contains the canonical URL, Open Graph and X/Twitter large-image metadata, and WebSite/WebApplication structured data. Crawlers can read this metadata without running JavaScript. `public/robots.txt` points to the homepage-only sitemap; invitation URLs still serve the same preview but send `X-Robots-Tag: noindex, follow`. The web manifest supplies the name, theme, and home-screen icons.

`public/og-image.png` is the 1200 × 630 social preview. Its vector source is `public/og-image.svg`; the generator uses the project's Jost font and woven brand mark. To regenerate it after editing the design, install ImageMagick and run from the repository root:

```bash
uv run --with fonttools --with brotli python apps/meeting/scripts/generate-social-image.py
```

## Browser verification

With `pnpm dev` running at `http://127.0.0.1:5173`, run both browser harnesses through Playwright CLI's `run-code`, passing that origin explicitly. Launch Chromium with fake camera/microphone and autoplay enabled:

```json
{"browser":{"browserName":"chromium","launchOptions":{"args":["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--autoplay-policy=no-user-gesture-required"]},"contextOptions":{"permissions":["microphone","camera"],"viewport":{"width":1440,"height":1000}}}}
```

Create `output/playwright/` and save this as `output/playwright/cli.config.json` from the repository root, then:

```bash
mkdir -p output/playwright
playwright-cli -s=agents open http://127.0.0.1:5173 --config=output/playwright/cli.config.json
playwright-cli -s=agents run-code "async (page) => ($(cat apps/meeting/scripts/verify-agents-browser.js))(page, 'http://127.0.0.1:5173')"
playwright-cli -s=agents run-code "async (page) => ($(cat apps/meeting/scripts/verify-chat-tools-browser.js))(page, 'http://127.0.0.1:5173')"
playwright-cli -s=agents close
```

The browser harness creates two independent browser contexts with real room WebSockets and peer connections, using a local WebRTC provider simulator for GPT-Live initialization and mocked TURN provisioning for local peer connectivity. It verifies automatic Muse setup without a Live connection, private isolation, approved-only public speech with owner attribution, an open owner microphone and interruption without resume, silent Omni preparation followed by explicitly approved public audio and transcript, private conversation recovery, signaling reconnection, public replay/deduplication, and mobile layout. [VERIFICATION.md](VERIFICATION.md) separates current harness coverage from historical browser/provider results. The same harness accepts a third options argument `{ groupOnly: true, scenario: "convergence" | "drift" | "float" | "echo" | "none", realProvider: true }` to exercise automatic Group reviews against real GPT-Live. Omit `realProvider` for deterministic provider simulation. It sends normal Room chat through the UI; it never injects review commands. Each scenario uses a separate room. Intervention scenarios wait for a raised draft, assert that no public output occurs before approval, then approve it and check peer delivery and audio. The `none` scenario checks abstention. Provider simulation checks integration; real-provider runs additionally sample classification and read-aloud behavior. Human listening and noisy-room evaluation remain separate.

`scripts/verify-chat-tools-browser.js` is a second harness with the same `(page, origin)` calling convention. It joins two real local participants, shares a guest's text file and image, and submits the owner's private request through simulated GPT-Live function calls. Those calls execute the actual meeting read, automatic file transfer/reader, Mermaid whiteboard edit, and rendered board capture paths. Assertions cover the receiving peer's board, image delivery as provider vision input, private request isolation, default file permission, shared-screen opt-in, the 500-record tool limit, and the absence of search, raw-download, and public-posting tools in the default personal session. Room must receive no assistant message during this private interaction. All provider responses in this harness are simulated; it checks tool integration rather than model judgment or actual speech recognition.

### Stable local preview behind Tailscale

For a long-running local meeting, build once and serve the completed Worker directly through Miniflare:

```bash
pnpm build
pnpm serve:local --origin https://your-machine.your-tailnet.ts.net:9443
# In another terminal:
tailscale serve --bg --https=9443 http://127.0.0.1:8787
```

`serve:local` binds only to loopback. `--origin` must match the external HTTPS origin; the Worker continues to enforce its same-origin checks. The runner reads bindings, assets, SQLite Durable Objects, rate limits, and local secrets from the generated Wrangler configuration. It accepts `--config`, `--port`, and `--persist` for serving an isolated build snapshot under a process supervisor. It does not watch or rebuild source files.

This avoids Wrangler's development ProxyWorker, whose fatal `Network connection lost` failure can disconnect all participants during HTTP requests alongside open WebSockets (Cloudflare workers-sdk issues [15452](https://github.com/cloudflare/workers-sdk/issues/15452) and [15203](https://github.com/cloudflare/workers-sdk/issues/15203)). A restart closes existing sockets; the browser retries signaling automatically and keeps its local history. Reload to receive a new frontend build, then rejoin the same room to restore the tab checkpoint.

### When to send a private reminder

For the optional MCP path, the connected assistant receives the same decision-focused guidance in `read_meeting` results and the `show_private_notice` tool description. No reminder is the default. It must find reliable evidence of a pending decision and an important unresolved concern, read surrounding finalized records and later replies, and check private history before notifying. Missing topics, silence, agreement, and hypothetical risks alone do not qualify. Unclear transcription lowers confidence; speaking speed, unclear words, and requests to check or repeat captions must not trigger reminders.

Visible text should name the decision and unresolved concern, then offer one question the participant can say aloud. Sequence numbers belong in `evidenceSeqs`, not in the reminder. These are assistant instructions; the browser validates the payload and evidence references, but does not independently judge its meaning or guarantee the assistant follows the guidance.

Manual acceptance scenarios for the connected assistant:

- Fast speech plus an unclear API phrase, without a decision: no reminder and no request to verify captions.
- An objection about data loss on disconnect followed by a proposal to approve Friday’s launch, with no answer: a reminder asking to confirm recovery behavior before approval.
- The same objection followed by an answer and acceptance before approval: no reminder.
- Ordinary agreement, or only a partial page without enough context: read more if available; otherwise no reminder.
- A concern already dismissed without material new evidence: no repeated reminder.

Suggested test prompt: “Read the meeting and private history. Send a private reminder only if reliable context shows a pending decision with an important unresolved concern. Otherwise send no notification. Ignore transcript-quality issues.”

### Testing automatic reminders

Run the normal `pnpm check` suite for lifecycle, routing, input validation, retrieval, and error handling. For an opt-in live Gemini check against a running preview, run `node scripts/evaluate-private-analysis.mjs https://your-preview-origin` from this directory. This uses synthetic conversations and makes billable provider calls; it exits nonzero on unexpected results. It checks an unresolved objection, a resolved objection, unclear transcription, ordinary agreement, and prompt injection in speech. Passing these fixtures does not establish accuracy on real meetings.

To test in ordinary browsers, join the same room as two participants with captions on. One person raises an untested data-loss concern; the other moves to approve launch without answering it. Pause briefly after the decision so analysis can finish. Only the objection author should receive a private reminder; chat stays empty. Then test a new room where the concern is answered before approval (no reminder). No assistant tools are needed.

Provider references: [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [structured generation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

### Reconnection and same-tab recovery

A dropped signaling socket automatically retries joining the same room with the same participant id (1–10 second backoff). The meeting stays open, media state and local history remain, and a reconnecting message replaces the terminal disconnect error. Peers exchange their own history again, with duplicate suppression. A temporary disconnect does not invoke Leave.

The tab checkpoints its latest room in **sessionStorage**: up to 1,000 text chat messages, 1,000 finalized transcript lines, 2,000 meeting-log entries with original sequence numbers, 50 private reminders, and up to 200 private Muse conversation lines. The checkpoint includes dismissed/read/collapsed status. The checkpoint also preserves participant identity and the locally displayed timer. Refreshing and joining the same room, or deliberately leaving and rejoining it, restores that checkpoint. It is ignored after 12 hours without a save; joining a different room replaces the saved room. Closing the tab normally ends its browser session, though browsers may restore sessionStorage when restoring tabs. This is not account storage or cross-device synchronization.

Private Muse conversation text is restored after refresh and rejoining the same room. Active Live connections, queued speaking approvals, file bodies, file-transfer state, whiteboard scenes, media permission, and screen sharing are not checkpointed; restoring text does not resume assistant speech. Refreshing requires rejoining and restarting screen sharing or re-sharing local files. A connected peer can replay the current whiteboard scene. Storage failures preserve live in-memory state and show a warning that refresh recovery is unavailable. Large histories may be trimmed further to fit the checkpoint budget. The room server owns its own timer lifecycle; the checkpoint restores the returning tab's local timer and does not create a server-wide durable meeting archive.
