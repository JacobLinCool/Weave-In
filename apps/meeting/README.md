# Weave In meeting

Browser-native meetings with a personal **Muse** and a shared **Omni**. Chat gives silent private reminders, supports private discussion, and can speak for its owner once they approve a specific reminder. Omni publishes brief public text suggestions without audio or an approval step. React/Vite runs the assistants; a Cloudflare Worker initializes GPT-Live and a Durable Object coordinates room signaling and assistant ownership. Automatic reminder analysis sends bounded transcript context through the Worker to Gemini.

The **Muse** tab opens the personal assistant conversation directly, with a settings button beside its name. Muse is configured automatically on join; its owner can edit instructions, language, sources and tool permissions without losing conversation history. The **Room** tab contains a persistent Omni status card above shared messages. The plus button to the right of the Omni heading adds Omni immediately with default settings. Its settings button opens a full Room-panel settings page with Back to Room at the top. Personal settings similarly provide Back to Muse. Back discards unsaved edits. Any participant can change Group settings; the creator or host can remove it. The card border glows while preparing or publishing a suggestion and returns to normal when idle, stopped or waiting. Settings save only after room confirmation and stop work using old permissions.

The landing page (`src/landing.tsx`) demonstrates the product as a weaver's draft: participants are warp threads, captions are weft passes, the transcript is the drawdown. Brand assets live in `src/brand.tsx` and `public/`.

```bash
pnpm dev
pnpm test
pnpm build
pnpm deploy:dry-run
```

## Documents

| File | What it settles |
| --- | --- |
| `PRODUCT.md` | What the product is, who it is for, and exactly what may be claimed |
| `GROUPTHINK.md` | The detection model: signals, formulas, thresholds, intervention policy, reading list |
| `ARCHITECTURE.md` | Where the code goes: data flow, protocol additions, storage, build order |
| `VERIFICATION.md` | Local verification results, browser matrix and remaining release checks |
| `DESIGN.md` | The design system, including § The Insight Surfaces for the analysis layer |

## The meeting

- Invite links can reopen a room: if no host is connected, the next person joining becomes host under the same room code. A fully empty room starts a new meeting timer; if guests remain, the existing timer is preserved. Joining an active hosted room still makes you a guest. The server does not archive prior chat or captions; a returning browser can restore its own same-tab checkpoint, and connected peers replay their own history.

- The header shows time since the room was created (`mm:ss`, then `h:mm:ss`). The signaling server supplies the shared start time and its current time, so late joiners see the room's duration without depending on their device clock matching the server. Socket attachments retain the timestamp through Durable Object hibernation. A new room starts a new clock.
- Up to eight participants in a full-mesh WebRTC room with public STUN only.
- Camera, microphone, and screen sharing; tracks are added and removed with perfect negotiation.
- Chat and live transcript are shared over a per-peer WebRTC data channel. Chat renders Markdown, including headings, lists, links, task lists, tables, and fenced code blocks. Enter sends; Shift+Enter adds a line. Raw HTML is disabled, and remote Markdown images appear as links.
- Files shared in chat (picker or drag-and-drop, up to 300 MB each) are announced by metadata. Chat keeps compact file cards; all files, including images, are fetched only when a participant clicks Preview or Download. Preview opens a viewport-sized modal with transfer progress, retry on failure, a reload action when the sharing participant reconnects, a close button, and Escape dismissal. Transfers use a dedicated peer-to-peer data channel (`file:<transfer id>`, 64 KiB chunks with `bufferedAmount` back-pressure) and are cached in memory for preview and saving. Late joiners get the announcements when their channel opens; files already received remain viewable after their owner leaves. See `src/file-share.ts`.
- Previews support PNG, JPEG, GIF, WebP, AVIF, SVG, BMP, PDF, DOCX, UTF-8 text, and Markdown. Image/PDF/DOCX previews are limited to 20 MB; text/Markdown previews to 1 MB. Larger or unsupported files remain downloadable. PDF previews have page navigation and selectable page text. DOCX previews retain headings, emphasis, lists, and tables, with sanitized HTML; embedded images and exact Word page layout are not reproduced. Password-protected PDFs must be saved and opened separately. PDF and DOCX readers load on demand from the app itself; no external document viewer receives the file. PDF.js uses JavaScript decoding (`useWasm: false`) under the existing script CSP.
- Late joiners get the past from the people who were there: when a newcomer's channel opens, each existing participant replays its **own** chat messages and finalized captions (`history` batches under 16 KiB, at most the last 400 entries) and re-announces its files. Nobody relays anyone else's words, so what a participant who already left said is gone. The newcomer merges replays by time, marks them `replayed: true` in the record, and draws a "You joined" rule in the panels. See `src/history.ts`.
- Every browser keeps the meeting record (`src/meeting-log.ts`): finalized captions with their speaker, chat, file announcements, joins and leaves, numbered by revision so a reader can resume from a cursor. Agent transcript fragments update a stable record ID and receive a fresh cursor.
- Each participant transcribes only their own microphone (browser echo cancellation keeps remote voices out of the local track) and streams the finalized and interim text to everyone else. Speaker attribution is structurally correct rather than inferred by diarization, which is what makes the analysis downstream possible.
- Captions use Gemini or OpenAI. The Worker mints short-lived ephemeral tokens from its `GEMINI_API_KEY` or `OPENAI_API_KEY` secret (Gemini is preferred when both exist; set `TRANSCRIPTION_PROVIDER=openai` to override) and the page adopts whichever provider the Worker reports. Without a key the meeting still works, but captions are reported as unavailable.

## WebMCP

When the browser exposes `navigator.modelContext` (or `document.modelContext`), the room registers six tools while a meeting is open and removes them on leave (`src/webmcp.ts`). Everything they return is this browser's own copy of the room; the Worker is not involved.

| Tool | Input | What it does |
| --- | --- | --- |
| `read_meeting` | `after?`, `limit?` | Room code, participants, caption status, live (unfinalized) captions, the current file list, and the meeting record from sequence number `after` onward. Pass the returned `nextCursor` back as `after` to read only what is new. |
| `download_file` | `fileId`, `offset?`, `length?` | Fetches the file from the participant who shared it (peer-to-peer, cached afterwards) and returns a slice: UTF-8 text for text files, base64 otherwise. Continue from `nextOffset` until `eof`. Default slice 1 MiB, maximum 8 MiB. |
| `capture_screen_share` | `maxWidth?`, `format?`, `quality?` | A still image of the screen currently being shared (yours or another participant's), as the room sees it, returned as an MCP `image` content block next to a text block naming the presenter and the dimensions. When nobody is sharing, the text block says so. |
| `send_chat_message` | `text`, `agent?` | Posts to chat on behalf of the participant using this browser. Every screen labels it "<name>'s agent" (with the `agent` name as a tag) rather than as something they typed. |
| `show_private_notice` | `id`, `text`, `evidenceSeqs`, `ttlSeconds?` | Places a contextual reminder in this browser's private notification. Cite 1–5 speech/chat sequence numbers from `read_meeting`; text is limited to 240 characters. Stable ids make retries safe within the retained history. |
| `read_private_notices` | none | Reads private history and lifecycle statuses. Does not publish anything to the room. |

### Private reminders

Private reminders float at the lower left of the video stage, above the meeting controls, without resizing the video or footer. No empty reminder card is shown. A popup collapses after 15 seconds of unattended display; pointer hover, keyboard focus, or insufficient space to avoid captions pauses the countdown. Placement avoids visible captions and error messages. A newer reminder does not replace the popup currently being read; the latest eligible reminder can appear after it closes. Expired/dismissed reminders are not newly surfaced.

**Later**, the close button, and timeout only collapse the popup: they do not dismiss it or mark it read. The **Muse** tab shows an unread dot and combines private reminders, evidence, and personal assistant discussion. Viewing history marks reminders read. Collapsed/read states survive same-tab room recovery. The underlying active-reminder TTL remains 120 seconds by default (15–300 configurable), independently of popup display time. Screen sharing can reveal visible private content.

Reminder state is private to this tab and checkpointed in sessionStorage for same-room recovery. It is never added to the shared meeting log, peer messages, server storage, or localStorage. Automatic monitoring runs in ordinary browsers while the meeting page is open; no MCP or assistant interaction is required. Existing WebMCP tools remain available as an optional manual delivery path. Use **Discuss privately** to bring a reminder into Chat, or **Speak for me** to approve one public spoken explanation of that reminder. Neither action requires an external assistant or a Codex browser.

Example, after reading sequence 42 from the current meeting:

```json
{"id":"maintenance-cost","text":"Your maintenance-cost question is still unanswered, and the group is preparing to decide.","evidenceSeqs":[42],"ttlSeconds":120}
```

Tool results are `{ content: [{ type: 'text', text: <JSON> }] }` (plus an `image` block for screen captures), with `isError: true` and `{ ok: false, error }` on invalid input. `read_meeting` also reports `screenShare.presenter` so an agent knows when a capture is worth taking.

## Muse and Omni

Muse is configured automatically when a participant joins. Open **Muse** for reminders and private discussion. Automatic reminders are silent and do not start an audio session. A direct text question or **Talk to Muse** starts a private assistant interaction; private voice input temporarily isolates the microphone from the meeting and restores its previous state when finished.

**Speak for me** approves one public turn based on the selected reminder. Muse uses a fresh session with only that approved text, without personal conversation history or meeting tools. It may elaborate slightly, aiming for 15–20 seconds, but must not add a new position, commitment, or private detail. Public output is labelled as the owner's Muse. The owner's microphone remains in its existing state; speaking on an enabled microphone stops the assistant and revokes any queued public turn. It does not resume automatically. A new spoken turn requires another click. There is no persistent public-audience mode.

The **Room** tab holds shared messages and the Omni status card and its settings. Any participant can create it and edit its settings. The room accepts `agent-signal` commands, but the automatic public-context signal producer is not connected. There is no manual review button. Omni prepares a suggestion and publishes at most 240 characters to shared Room chat, labelled **Omni**, with no audio and no user approval step. It uses public meeting context only. It can move to another ready browser if its runner leaves; its replacement uses whatever public history that browser has. Public suggestions replay through the agent-history channel to late joiners and appear as Omni messages. A trigger requests a review, not a room-wide Groupthink verdict.

`OPENAI_API_KEY` is required for Muse and Omni, even when captions and automatic reminders use Gemini. Model constants are in `src/agents/contracts.ts`. Browser audio activation may be needed for Muse’s spoken replies; creating the personal configuration on join does not itself open a continuous Live connection. The settings button in Muse edits source and tool permissions in place.

Agent context is bounded by GPT-Live's session input limit. The Client seeds at most 6,000 UTF-8 bytes, sends only new background records, and reserves capacity for the current question and tool results. Agent tools read at most five records or 1,024 file bytes per call; screen images are compressed to fit. Native WebMCP keeps its existing limits. An interaction that exhausts its budget stops with a visible message; a new question starts a fresh session.

## Automatic private analysis

Each browser checks for new finalized **speech** every five seconds, with at least 30 seconds between analyses. It sends up to 40 recent utterances (bounded request size) and up to 20 previous automatic reminders with their original concern and decision evidence (also byte-bounded) to `/api/private-analysis`. Chat, interim captions, files, and assistant messages are not analyzed. Replayed history alone does not trigger a notification. The Worker calls Gemini Embedding (`gemini-embedding-001`, 256 dimensions) to identify related earlier speech and neighboring replies, then Gemini Flash (`gemini-3.6-flash`) evaluates that context with the complete bounded window and returns a structured decision.

The first detector covers **an explicit unresolved objection bypassed during a later decision**. The server derives the recipient from the objection's author and returns a notice only to that person's browser. It validates both evidence references and decision recency. No public message, assistant action, or broadcast is generated. Event IDs combine the concern and decision sequence numbers. History retains the original evidence even after a reminder is closed or dismissed. The same concern can recur only for a substantive new commitment, execution starting, or a material scope change; repeating or paraphrasing the same decision does not qualify. Structured validation rejects repeated or older decisions and invalid links to prior events. Semantic novelty is still judged by Gemini. A 120-second cooldown prevents closely spaced reminders; time passing alone never triggers one. Leaving the meeting cancels the browser request and discards late results; the upstream provider request may already be processing. If new speech arrives during analysis, the result is discarded and re-evaluated on the next check. Provider errors show an unavailable/retrying state with a 60-second backoff, without interrupting the meeting.

This is a bounded prototype, not the full room-wide design in `ARCHITECTURE.md`: no shared room corpus, embedding cache, cross-browser coordination, persistent report, or full set of Groupthink detectors. Each participant analyzes their local view, so costs scale with participant count, background-tab throttling can delay checks, and incomplete context can cause misses. Embeddings provide semantic retrieval hints; the model still decides whether an objection remains unresolved. The browser must stay open and connected to receive new speech. This does not run after the tab closes or wake an assistant.

## Privacy

Meeting media, chat and public captions travel peer-to-peer. Caption audio goes directly to the selected provider. Selected assistant context, allowed screen/file tool results, and private assistant conversations go directly to OpenAI after initialization. The Worker receives assistant settings and connection setup, but does not store assistant conversation records. Automatic analysis sends recent transcript text and previous automatic reminders through the Worker to Gemini. The Worker does not persist this data or embeddings. Reminder history is checkpointed in the receiving tab's sessionStorage for same-room recovery. Google processes the supplied text under the configured Gemini service's terms; this implementation makes no claim about provider retention. Private reminder evidence and personal conversations are not published to the room. Only the specifically approved reminder enters a speak-for-me session; Omni receives public context only.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set a key.

## Deployment

Public URL: [https://weave.nycu.ai](https://weave.nycu.ai/).

Deploy through GitHub Actions only. Use a push to `main` or the workflow's manual trigger; local development may run builds, tests, and deployment dry runs, but must not publish directly to Cloudflare.

The [GitHub Actions workflow](../../.github/workflows/deploy.yml) runs `pnpm check` for pull requests targeting `main` and pushes to `main`. After a successful check on `main`, it deploys the verified build to the `weave-in-meeting` Cloudflare Worker, including static assets and Durable Object migrations. The Actions tab also supports **Run workflow**; select `main` to deploy. Manual runs on other branches only run checks. Deployments run one at a time without interrupting an active deployment.

Before the first deployment, add these repository secrets in [Settings → Secrets and variables → Actions](https://github.com/JacobLinCool/Weave-In/settings/secrets/actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the Worker. |
| `CLOUDFLARE_API_TOKEN` | An API token created with the **Edit Cloudflare Workers** template, scoped to that account. |

See [Cloudflare's GitHub Actions authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) for account ID lookup and token creation. Missing deployment secrets fail the deployment step with an explicit error; pull request checks do not require them.

Production transcription keys are Worker secrets, configured separately from the GitHub deployment credentials. After the first deployment, set at least one provider key from the repository root:

```bash
pnpm --filter @weave-in/meeting exec wrangler secret put GEMINI_API_KEY
# Or use OpenAI:
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

With `pnpm dev` running at `http://127.0.0.1:5173`, run `scripts/verify-agents-browser.js` through Playwright CLI's `run-code`. Launch Chromium with fake camera/microphone and autoplay enabled:

```json
{"browser":{"browserName":"chromium","launchOptions":{"args":["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--autoplay-policy=no-user-gesture-required"]},"contextOptions":{"permissions":["microphone","camera"],"viewport":{"width":1440,"height":1000}}}}
```

Save this as `output/playwright/cli.config.json` from the repository root, then:

```bash
mkdir -p output/playwright
playwright-cli -s=agents open http://127.0.0.1:5173 --config=output/playwright/cli.config.json
playwright-cli -s=agents run-code "$(cat apps/meeting/scripts/verify-agents-browser.js)"
playwright-cli -s=agents close
```

The browser harness creates two independent browser contexts with real room WebSockets and peer connections, using a local WebRTC provider simulator for GPT-Live initialization. It verifies automatic Chat setup without a Live connection, private isolation, approved-only public speech with owner attribution, an open owner microphone and interruption without resume, silent Omni messages in Room, private conversation recovery, signaling reconnection, public replay/deduplication, and mobile layout. `VERIFICATION.md` also contains historical results from the original PR #6. Provider simulation does not verify real credentials or speech understanding; real-provider connection and human listening checks complement it.

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

Private Muse conversation text is restored after refresh and rejoining the same room. Active Live connections, queued speaking approvals, file bodies, file-transfer state, media permission, and screen sharing are not checkpointed; restoring text does not resume assistant speech. Refreshing requires rejoining and restarting screen sharing or re-sharing local files. Storage failures preserve live in-memory state and show a warning that refresh recovery is unavailable. Large histories may be trimmed further to fit the checkpoint budget. The room server still owns its own timer lifecycle; this patch preserves the returning tab's local timer, not a server-wide durable meeting archive.
