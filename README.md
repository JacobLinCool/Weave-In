# Weave In

Keep the thread. Weave everyone in.

![Top 5 of 30 finalist teams — 2026 Sea x OpenAI Regional Codex Hackathon Taiwan](docs/assets/hackathon-finalist.svg)

[Open Weave In](https://weave.nycu.ai/)

Weave In is a browser meeting app for thinking independently and contributing together. Up to eight participants share video, audio, screens, live captions, chat, files, and an editable whiteboard. No account is required.

- **Muse** is each participant’s private assistant. Type, dictate a draft, or start a continuous GPT-Live conversation. Muse can read permitted meeting records and files, inspect a shared screen when enabled, and edit the whiteboard when asked. Room text posting requires a separate permission and an explicit request. **Send to everyone** reads one completed reply aloud to the room.
- **Omni** is the room’s shared facilitator. It automatically reviews public discussion for premature convergence, drift from an explicit goal, uneven participation, or repeated agreement without reasons. It prepares silently, then waits for a participant to choose **Allow Omni to speak** or say “Omni, go ahead” with captions enabled. Approved speech also appears in the shared transcript.
- **Codex and other WebMCP clients** can use structured browser tools to read meeting context, capture a screen or board, retrieve files, post requested messages, and edit diagrams. These clients run outside the app; Muse and Omni work in ordinary browsers.
- **Automatic private reminders** separately check whether the participant’s explicit objection remains unresolved as a later decision moves ahead. These are evidence-linked discussion prompts; the app does not diagnose groupthink or compute a validated group-risk score.

## Run locally

Use Node.js 24 and pnpm 11.24.0, matching CI and the root `packageManager` field.

```bash
pnpm install --frozen-lockfile
cp apps/meeting/.dev.vars.example apps/meeting/.dev.vars
# Replace the placeholders with server-side credentials for the features you use.
pnpm dev              # http://localhost:5173
pnpm check            # typecheck + tests + build + deployment dry run
```

| Credentials | Enables |
| --- | --- |
| `GEMINI_API_KEY` | Gemini captions and automatic private analysis |
| `OPENAI_API_KEY` | OpenAI captions, Muse, and Omni question drafting/speech |
| `TYPESAFE_API_KEY` | Jev automatic public meeting detection for Omni |
| `TRANSCRIPTION_PROVIDER` | Optional `gemini` or `openai` caption-provider override; Gemini is preferred when both keys exist |
| `TURN_KEY_ID` and `TURN_KEY_SECRET` | Cloudflare TURN relay provisioning; both are required for room connection setup |

Automatic private analysis requires Gemini even when captions use OpenAI. Muse requires OpenAI; Omni uses TypeSafe Jev for detection and OpenAI for question drafting and speech, independently of the caption provider. Credentials stay server-side. See the [meeting setup guide](apps/meeting/README.md) for provisioning, API limits, local preview, and deployment.

Deployment runs through [GitHub Actions](.github/workflows/deploy.yml) after checks on `main`; use `pnpm deploy:dry-run` to validate locally.

## Repository and documentation

```text
apps/meeting          React + Vite client, Cloudflare Worker and room Durable Object
packages/transcribe   Headless browser transcription core for Gemini and OpenAI
```

| Document | Purpose |
| --- | --- |
| [Meeting README](apps/meeting/README.md) | Setup, commands, environment, APIs, browser tools, limits, and deployment |
| [Product](apps/meeting/PRODUCT.md) | Current capabilities, user flows, privacy boundaries, and claim limits |
| [Architecture](apps/meeting/ARCHITECTURE.md) | Implemented modules, data paths, coordination, and storage |
| [Groupthink and intervention policy](apps/meeting/GROUPTHINK.md) | Implemented reminder and Omni policies, and limits of interpretation |
| [Design](apps/meeting/DESIGN.md) | Visual system and current interface behavior |
| [Verification](apps/meeting/VERIFICATION.md) | Automated checks, browser harnesses, and their evidence limits |
| [Project narrative](apps/meeting/PROJECT-NARRATIVE.md) | English project story, rendered on the About page |
| [Project narrative（繁體中文）](apps/meeting/PROJECT-NARRATIVE.zh-TW.md) | Product motivation and collaboration scenarios |
| [Transcription package](packages/transcribe/README.md) | Public API, provider differences, lifecycle, and usage |

## Data flow and storage

Meeting video, audio, screens, chat, files, captions, and whiteboard records travel over encrypted WebRTC connections between participants. Browsers prefer direct connections; Cloudflare TURN can relay encrypted packets on restricted networks. The relay handles connection metadata such as IP addresses and timing, but cannot read the encrypted content.

The signaling Worker routes connection setup, issues short-lived caption and TURN credentials, and initializes GPT-Live sessions. Its room Durable Object stores agent configuration, ownership, runner leases, approval/floor state, and coordination metadata. Meeting media and shared content use the peer connections, while caption audio goes directly from the browser to the selected AI provider. After Live initialization, assistant audio, permitted context, conversations, and tool results travel directly between the browser and OpenAI.

Automatic private analysis sends a bounded recent transcript window and previous automatic-reminder evidence through the Worker to Gemini. The Worker does not persist these analysis requests or private conversations. Analysis starts automatically in a meeting; the current interface has no pause switch. Hiding or dismissing a reminder controls its display, not analysis.

The browser stores the display name and caption preferences in `localStorage`. A bounded, room-specific `sessionStorage` checkpoint retains transcripts, text chat, private reminders, and up to 200 private Muse conversation lines for refresh/rejoin recovery in that tab, with a 12-hour validity window since the last save. Leaving saves this checkpoint; it does not erase it. Whiteboard elements and file bytes remain in participant memory and are excluded from that checkpoint. This is partial recovery, not a server-side meeting archive; export work before everyone leaves. AI-provider retention is separate from the app’s own storage.

Private Muse Live and dictation pause the owner’s room microphone and public captions while capturing private input. Ending capture restores the meeting microphone preference and caption flow. Reading a selected reply aloud uses only the approved text, without private history or tools; it leaves the room microphone available and stops when the owner starts speaking.

## Shared whiteboard

Choose **Open shared whiteboard** in the meeting controls. Each participant controls their own view; closing the board preserves its contents and synchronization. The [Excalidraw](https://github.com/excalidraw/excalidraw) editor supports shapes, bound text, arrows, freehand drawing, pan/zoom, and export. Fonts are served locally. Late joiners receive element records, including deletions, from connected peers. Concurrent edits resolve by native element version and nonce ordering.

For manual Mermaid input, open **More tools → Mermaid to Excalidraw**. For agent edits, `edit_whiteboard` supports read, edit, undo, redo, and Mermaid import; follow edits with `capture_whiteboard` to inspect the visible result. External WebMCP captures require the board to be open. Muse opens it when needed.

```json
{
  "action": "mermaid",
  "source": "flowchart LR\n A[需求] --> B{審核}\n B -->|通過| C[執行]\n B -->|修改| A",
  "x": 0,
  "y": 0
}
```

Tool imports accept Mermaid `flowchart` / `graph`, including nested subgraphs, and add editable elements while preserving existing content. Other diagram families and generated image assets are unsupported. Imports are limited to 12,000 source characters and 300 native elements; the board holds up to 1,000 records including bound text and deletions. Native records are also subject to text, point-count, and 16 KiB frame limits. See the [meeting guide](apps/meeting/README.md) for the complete editing limits.
