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

- Up to eight participants in a full-mesh WebRTC room with public STUN only.
- Camera, microphone, and screen sharing; tracks are added and removed with perfect negotiation.
- Chat and live transcript travel over a per-peer WebRTC data channel. Media and chat never reach the Worker.
- Files shared in chat (picker or drag-and-drop, up to 300 MB each) are announced by metadata only. The bytes leave the owner's browser when a participant clicks Download, over a dedicated data channel per transfer (`file:<transfer id>`, 16 KiB chunks with `bufferedAmount` back-pressure), and stay in that participant's memory for the rest of the meeting. Late joiners get the announcements when their channel opens; a file whose owner left is marked unavailable. See `src/file-share.ts`.
- Late joiners get the past from the people who were there: when a newcomer's channel opens, each existing participant replays its **own** chat messages and finalized captions (`history` batches under 16 KiB, at most the last 400 entries) and re-announces its files. Nobody relays anyone else's words, so what a participant who already left said is gone. The newcomer merges replays by time, marks them `replayed: true` in the record, and draws a "You joined" rule in the panels. See `src/history.ts`.
- Every browser keeps the meeting record (`src/meeting-log.ts`): finalized captions with their speaker, chat, file announcements, joins and leaves, numbered densely so a reader can resume from a cursor.
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

## The analysis

In development. See `ARCHITECTURE.md` § Build order before starting anything.

- Finalized utterances and speaking-activity events go from each browser to the room's Durable Object over the **existing signaling socket** — not a new endpoint, and not over the peer data channels.
- The Durable Object persists them to its SQLite storage, embeds them server-side, runs the detectors from `packages/groupthink`, and broadcasts analysis snapshots and interventions back to every participant.
- Embedding and generation calls are server-to-server from the Durable Object. The browser only ever talks to the same origin for analysis, so **the CSP needs no new entries**.
- Everything stored is deleted when the room closes.

## Privacy

State it exactly as `PRODUCT.md` § Brand Commitments does, and nowhere else any other way:

> Camera, microphone, screen share, and chat never touch our server. Transcript text does, so the room can analyze the discussion, and it is deleted when the room closes.

The earlier "nothing touches our server" claim is **false as of the analysis work** and must not survive anywhere in copy, docs, or the landing page.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and set a key. For production, create the Worker secret with `pnpm exec wrangler secret put GEMINI_API_KEY` or `pnpm exec wrangler secret put OPENAI_API_KEY`.
