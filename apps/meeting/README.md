# Weave In meeting

Browser-native meetings that detect groupthink while it is happening. React/Vite in the browser, a Cloudflare Worker for routing and security headers, and one hibernating Durable Object per six-character room code that handles signaling, stores the room's utterance log, and runs the detection engine.

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
| `DESIGN.md` | The design system, including § The Insight Surfaces for the analysis layer |

## The meeting

- Invite links can reopen a room: if no host is connected, the next person joining becomes host under the same room code. A fully empty room starts a new meeting timer; if guests remain, the existing timer is preserved. Joining an active hosted room still makes you a guest. Reopening does not restore previous chat or captions.

- The header shows time since the room was created (`mm:ss`, then `h:mm:ss`). The signaling server supplies the shared start time and its current time, so late joiners see the room's duration without depending on their device clock matching the server. Socket attachments retain the timestamp through Durable Object hibernation. A new room starts a new clock.
- Up to eight participants in a full-mesh WebRTC room with public STUN only.
- Camera, microphone, and screen sharing; tracks are added and removed with perfect negotiation.
- Chat and live transcript travel over a per-peer WebRTC data channel. Media and chat never reach the Worker.
- Files shared in chat (picker or drag-and-drop, up to 300 MB each) are announced by metadata only. The bytes leave the owner's browser when a participant clicks Download, over a dedicated data channel per transfer (`file:<transfer id>`, 16 KiB chunks with `bufferedAmount` back-pressure), and stay in that participant's memory for the rest of the meeting. Late joiners get the announcements when their channel opens; a file whose owner left is marked unavailable. See `src/file-share.ts`.
- Late joiners get the past from the people who were there: when a newcomer's channel opens, each existing participant replays its **own** chat messages and finalized captions (`history` batches under 16 KiB, at most the last 400 entries) and re-announces its files. Nobody relays anyone else's words, so what a participant who already left said is gone. The newcomer merges replays by time, marks them `replayed: true` in the record, and draws a "You joined" rule in the panels. See `src/history.ts`.
- Every browser keeps the meeting record (`src/meeting-log.ts`): finalized captions with their speaker, chat, file announcements, joins and leaves, numbered densely so a reader can resume from a cursor.
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
| `show_private_notice` | `id`, `text`, `evidenceSeqs`, `ttlSeconds?` | Places a contextual reminder in this browser's private dock. Cite 1–5 speech/chat sequence numbers from `read_meeting`; text is limited to 240 characters. Stable ids make retries safe within the retained history. |
| `read_private_notices` | none | Reads private history, lifecycle statuses, and whether display is hidden. Does not publish anything to the room. |

### Private reminders

A compact card beside the meeting controls shows one reminder at a time. Empty or hidden reminders use a compact header and monitoring status; visible reminders expand to fit their text. On narrow screens the controls and card stack. New reminders replace the current reminder; dismissing does not surface older ones. The **Private** tab holds up to 50 reminders with copied evidence. Reminders expire after 120 seconds by default (15–300 configurable), and remain in history. **Hide** hides content in both surfaces, including future reminders. It does not stop the assistant from reading the private history. Screen sharing can reveal any visible private content.

Reminder state exists only in this tab's memory, is cleared on leaving, and is never added to the meeting log, peer messages, server storage, or localStorage. Automatic monitoring runs in ordinary browsers while the meeting page is open; no MCP or assistant interaction is required. Existing WebMCP tools remain available as an optional manual delivery path. Follow-up conversation can stay in the user's existing assistant session; there is no automatic conversation handoff.

Example, after reading sequence 42 from the current meeting:

```json
{"id":"maintenance-cost","text":"Your maintenance-cost question is still unanswered, and the group is preparing to decide.","evidenceSeqs":[42],"ttlSeconds":120}
```

Tool results are `{ content: [{ type: 'text', text: <JSON> }] }` (plus an `image` block for screen captures), with `isError: true` and `{ ok: false, error }` on invalid input. `read_meeting` also reports `screenShare.presenter` so an agent knows when a capture is worth taking.

## Automatic private analysis (PR #2)

Each browser checks for new finalized **speech** every five seconds, with at least 30 seconds between analyses. It sends up to 40 recent utterances (bounded request size) and up to 20 previous automatic reminders to `/api/private-analysis`. Chat, interim captions, files, and assistant messages are not analyzed. Replayed history alone does not trigger a notification. The Worker calls Gemini Embedding (`gemini-embedding-001`, 256 dimensions) to identify related earlier speech and neighboring replies, then Gemini Flash (`gemini-3.6-flash`) evaluates that context with the complete bounded window and returns a structured decision.

The first detector covers **an explicit unresolved objection bypassed during a later decision**. The server derives the recipient from the objection's author and returns a notice only to that person's browser. It validates both evidence references and decision recency. No public message, assistant action, or broadcast is generated. A stable objection id, existing notice lifecycle, 120-second cooldown and private history suppress repeat reminders. Pause cancels the browser request and discards late results; the upstream provider request may already be processing. Hide affects visibility only. If new speech arrives during analysis, the result is discarded and re-evaluated on the next check. Provider errors show an unavailable/retrying state with a 60-second backoff, without interrupting the meeting.

This is a bounded prototype, not the full room-wide design in `ARCHITECTURE.md`: no shared room corpus, embedding cache, cross-browser coordination, persistent report, or full set of Groupthink detectors. Each participant analyzes their local view, so costs scale with participant count, background-tab throttling can delay checks, and incomplete context can cause misses. Embeddings provide semantic retrieval hints; the model still decides whether an objection remains unresolved. The browser must stay open and connected to receive new speech. This does not run after the tab closes or wake an assistant.

## Privacy

Camera, microphone, screen share, and chat are not sent to the operator's server. Automatic analysis sends recent transcript text and previous automatic reminders through the Worker to Gemini. The Worker does not persist this data or embeddings. Reminder history remains in the receiving browser's memory and clears on leaving. Google processes the supplied text under the configured Gemini service's terms; this implementation makes no claim about provider retention. Pause stops new analysis requests; it does not stop transcription. The landing page and Private panel disclose this data flow.

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

### Stable local preview behind Tailscale

For a long-running local meeting, build once and serve the completed Worker directly through Miniflare:

```bash
pnpm build
pnpm serve:local --origin https://your-machine.your-tailnet.ts.net:9443
# In another terminal:
tailscale serve --bg --https=9443 http://127.0.0.1:8787
```

`serve:local` binds only to loopback. `--origin` must match the external HTTPS origin; the Worker continues to enforce its same-origin checks. The runner reads bindings, assets, SQLite Durable Objects, rate limits, and local secrets from the generated Wrangler configuration. It accepts `--config`, `--port`, and `--persist` for serving an isolated build snapshot under a process supervisor. It does not watch or rebuild source files.

This avoids Wrangler's development ProxyWorker, whose fatal `Network connection lost` failure can disconnect all participants during HTTP requests alongside open WebSockets (Cloudflare workers-sdk issues [15452](https://github.com/cloudflare/workers-sdk/issues/15452) and [15203](https://github.com/cloudflare/workers-sdk/issues/15203)). Restarting a failed process does not restore an existing browser connection; rejoin the meeting after switching the running service.

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

To test in ordinary browsers, join the same room as two participants with captions on. One person raises an untested data-loss concern; the other moves to approve launch without answering it. Pause briefly after the decision so analysis can finish. Only the objection author should receive a private reminder; chat stays empty. Then test Pause/Resume, Hide/Show, and a new room where the concern is answered before approval (no reminder). No assistant tools are needed.

Provider references: [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings), [structured generation](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).
