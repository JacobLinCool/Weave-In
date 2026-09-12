# Weave In meeting

Browser-native meetings with private Personal assistants and a shared Group facilitator. React/Vite hosts the Client Agent runtime. A Cloudflare Worker initializes GPT-Live and a hibernating Durable Object coordinates room signaling, Agent ownership, public speech and takeover. Conversation content remains on Clients and their direct AI connections.

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

- The header shows time since the room was created (`mm:ss`, then `h:mm:ss`). The signaling server supplies the shared start time and its current time, so late joiners see the room's duration without depending on their device clock matching the server. Socket attachments retain the timestamp through Durable Object hibernation. A new room starts a new clock.
- Up to eight participants in a full-mesh WebRTC room with public STUN only.
- Camera, microphone, and screen sharing; tracks are added and removed with perfect negotiation.
- Chat and live transcript travel over a per-peer WebRTC data channel. Media and chat never reach the Worker.
- Files shared in chat (picker or drag-and-drop, up to 300 MB each) are announced by metadata only. The bytes leave the owner's browser when a participant clicks Download, over a dedicated data channel per transfer (`file:<transfer id>`, 16 KiB chunks with `bufferedAmount` back-pressure), and stay in that participant's memory for the rest of the meeting. Late joiners get the announcements when their channel opens; a file whose owner left is marked unavailable. See `src/file-share.ts`.
- Late joiners get the past from the people who were there: when a newcomer's channel opens, each existing participant replays its **own** chat messages and finalized captions (`history` batches under 16 KiB, at most the last 400 entries) and re-announces its files. Nobody relays anyone else's words, so what a participant who already left said is gone. The newcomer merges replays by time, marks them `replayed: true` in the record, and draws a "You joined" rule in the panels. See `src/history.ts`.
- Every browser keeps the meeting record (`src/meeting-log.ts`): finalized captions with their speaker, chat, file announcements, joins and leaves, numbered by revision so a reader can resume from a cursor. Agent transcript fragments update a stable record ID and receive a fresh cursor.
- Each participant transcribes only their own microphone (browser echo cancellation keeps remote voices out of the local track) and streams the finalized and interim text to everyone else. Speaker attribution is structurally correct rather than inferred by diarization, which is what makes the analysis downstream possible.
- Captions use Gemini or OpenAI. The Worker mints short-lived ephemeral tokens from its `GEMINI_API_KEY` or `OPENAI_API_KEY` secret (Gemini is preferred when both exist; set `TRANSCRIPTION_PROVIDER=openai` to override) and the page adopts whichever provider the Worker reports. Without a key the meeting still works, but captions are reported as unavailable.

## WebMCP

When the browser exposes `navigator.modelContext` (or `document.modelContext`), the room registers four tools while a meeting is open and removes them on leave (`src/webmcp.ts`). Everything they return is this browser's own copy of the room; the Worker is not involved.

| Tool | Input | What it does |
| --- | --- | --- |
| `read_meeting` | `after?`, `limit?` | Room code, participants, caption status, live (unfinalized) captions, the current file list, and the meeting record from sequence number `after` onward. Pass the returned `nextCursor` back as `after` to read only what is new. |
| `download_file` | `fileId`, `offset?`, `length?` | Fetches the file from the participant who shared it (peer-to-peer, cached afterwards) and returns a slice: UTF-8 text for text files, base64 otherwise. Continue from `nextOffset` until `eof`. Default slice 1 MiB, maximum 8 MiB. |
| `capture_screen_share` | `maxWidth?`, `format?`, `quality?` | A still image of the screen currently being shared (yours or another participant's), as the room sees it, returned as an MCP `image` content block next to a text block naming the presenter and the dimensions. When nobody is sharing, the text block says so. |
| `send_chat_message` | `text`, `agent?` | Posts to chat on behalf of the participant using this browser. Every screen labels it "<name>'s agent" (with the `agent` name as a tag) rather than as something they typed. |

Tool results are `{ content: [{ type: 'text', text: <JSON> }] }` (plus an `image` block for screen captures), with `isError: true` and `{ ok: false, error }` on invalid input. `read_meeting` also reports `screenShare.presenter` so an agent knows when a capture is worth taking.

## Assistants

Open the Assistants tab, enable audio on the device and create an assistant. The settings summary shows sources, tools and audience before creation. A Personal conversation starts private; persistent public mode warns that later responses may refer to previous private context. Talk to assistant isolates private microphone input from the meeting. Public Agent input/output appears in the shared transcript; private conversation is excluded from WebMCP and history replay.

Any member can trigger the single Group, invite it after it raises its hand, or stop it. Current public human captions also recognize “團隊助理，請發言” and “Weave, go ahead”. The Group takes speaking priority and can move to another audio-enabled Client if its runner leaves. Enable audio on at least two devices to demonstrate takeover. No automatic groupthink detector runs in this version.

`OPENAI_API_KEY` is required for Agents even when meeting captions use Gemini. Model constants are in `src/agents/contracts.ts`, not the creation form. Setup, protocol and lifecycle details are in `ARCHITECTURE.md`.

Agent context is bounded by GPT-Live’s session input limit. The Client seeds at most 6,000 UTF-8 bytes, sends only new background records, and reserves capacity for the current question and tool results. Agent tools read at most five records or 1,024 file bytes per call; screen images are compressed to fit. Native WebMCP keeps its existing limits. An interaction that exhausts its budget stops with a visible message; a new question starts a fresh session.

## Privacy

Meeting media, chat and public captions travel peer-to-peer. Caption audio goes directly to the selected AI provider. Selected Agent context, screen/file tool results and private/public Agent conversations go directly to OpenAI after initialization. The server receives Agent settings, SDP and room coordination, and stores coordination for the meeting lifetime; it does not receive or store conversation records. Public mode can quote earlier private context, but switching modes does not retroactively broadcast private records.

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

The check creates three independent browser contexts and uses real room WebSockets and peer connections. Only GPT-Live initialization is intercepted by a local WebRTC provider simulator. Assertions cover microphone isolation/restoration, remote audible output, private/public records, late fragments, silent preparation, fresh context after approval, automatic takeover and mobile overflow. Screenshots are written beneath `output/playwright`. This deterministic check does not verify real credentials or speech understanding. A separate local real-provider pass on 2026-09-12 verified initialization, Responses delegation, audible output/transcripts, three-Client private/public routing, Group approval and automatic takeover. A synthetic spoken question also passed input transcription, audible reply and private microphone isolation. See `VERIFICATION.md` for the expanded Chromium/Firefox/WebKit evidence and failures; this is not an all-browser pass. Human microphone/listening evaluation across supported browsers remains a release check.
