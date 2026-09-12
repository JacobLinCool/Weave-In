# Weave In

Keep the thread. Weave everyone in.

[Open Weave In](https://weave.nycu.ai/)

Groupthink is the failure mode where a group suppresses dissent to preserve harmony, stops thinking critically, and converges on a decision no member would have defended alone. It is invisible from inside the room, because the meeting feels productive precisely when nobody is arguing.

Weave In runs browser meetings with per-participant captions, private Personal assistants and one shared Group facilitator. A Group prepares after a manual signal, raises its hand, and speaks only when a participant invites it. Automated groupthink detectors are specified as future work; they are not running in the current product.

```
apps/meeting          Landing page + meeting room (React + Vite), Cloudflare Worker + Durable Object
packages/transcribe   Headless live transcription core (Gemini, OpenAI)
```

```bash
pnpm install
pnpm dev              # http://localhost:5173
pnpm check            # typecheck + tests + build + deploy dry run
```

## Where to start reading

| File | What it settles |
| --- | --- |
| `apps/meeting/PRODUCT.md` | What the product is and exactly what may be claimed |
| `apps/meeting/GROUPTHINK.md` | The detection model: signals, formulas, thresholds, intervention policy, reading list |
| `apps/meeting/ARCHITECTURE.md` | Data flow, protocol additions, storage, and the order to build in |
| `apps/meeting/DESIGN.md` | The design system, including the analysis surfaces |

## Privacy

Camera, microphone, screen share, chat, files, whiteboard edits, and captions use encrypted WebRTC connections between participants. Browsers prefer direct connections and can use Cloudflare TURN to relay encrypted packets on restricted networks. The relay can process connection metadata, including IP addresses and timing, but cannot read the encrypted meeting content. The signaling Worker issues short-lived TURN credentials and routes connection setup messages; meeting media and data do not pass through that Worker.

Caption audio goes directly to the selected AI provider. Agent context, selected files/screens and conversations go directly to OpenAI after initialization. The Worker handles Agent settings and room coordination; it does not store meeting transcripts or private conversations.

Automatic private analysis separately sends recent transcript text and previous automatic reminders through the Worker to Gemini. The Worker does not persist this analysis data. Participants can pause automatic analysis in the meeting.

See `apps/meeting/README.md` for room limits, TURN setup (`TURN_KEY_ID` / `TURN_KEY_SECRET`), and caption provider secrets (`GEMINI_API_KEY` / `OPENAI_API_KEY`).

### Shared whiteboard

In the bottom meeting controls, choose **Open shared whiteboard** to show the room's canvas and
**Close whiteboard** to return to video. It starts closed; each participant
controls their own view. Closing it does not clear its contents or stop sync.

The editor uses [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT),
with rectangles, decision diamonds, text, arrows and freehand drawing. Double-click
a shape to edit its bound text; long labels wrap and expand the container.
Drag nodes to move their text and attached arrows together. Use the hand tool
or hold Space to pan, and the native zoom, selection, resize and undo controls.
The menu can export an image. Fonts are served locally.
For manual Mermaid input, open **More tools → Mermaid to Excalidraw**, paste
the flowchart source, and choose **Insert**. The resulting elements also sync
with the room.

Edits travel over the meeting's existing WebRTC data channels. Participants
exchange versioned records, including deletions, when a channel opens, so late
joiners and reconnected peers receive the shared board. Concurrent edits to the
same element resolve by Excalidraw's version and nonce ordering. The canvas is held in
participant memory, not persisted on the server: export before everyone leaves.
The room supports up to 1,000 native element records (including bound text and
deleted elements), 4,000 characters per text element and 2,000 points per stroke,
subject to a 16 KB message limit per element. Images and embeds are not shared.

Two WebMCP tools are available while in a meeting:

- `edit_whiteboard`: read native elements and bindings, or create, update, move,
  delete and connect nodes. Tool requests accept up to 50 edits, 500 characters
  per new label and 256 points per stroke. Edit a label through its container's id.
  Use `action: "mermaid"` with a `source` string to import a Mermaid `flowchart`
  or `graph` as editable nodes, bound labels and arrows. Branches, edge labels
  and loops are supported. Existing content is preserved; one import is one
  undo step. Imports accept up to 12,000 characters and 300 native elements
  including labels. `subgraph` blocks, other diagram types and image fallbacks
  are rejected; the current upstream converter fails on subgraph group IDs.
- `capture_whiteboard`: capture the actual visible drawing canvas without
  toolbars. Open the board and finish any active text edit before capturing.

Use the capture tool after an edit to verify its rendered appearance. Closing
the board preserves shared content; viewport position and selection remain local.

For example, pass this to `edit_whiteboard`, then call `capture_whiteboard`:

```json
{
  "action": "mermaid",
  "source": "flowchart LR\n A[需求] --> B{審核}\n B -->|通過| C[執行]\n B -->|修改| A",
  "x": 0,
  "y": 0
}
```
