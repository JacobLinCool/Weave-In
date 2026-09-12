# Weave In

Keep the thread. Weave everyone in.

[Open Weave In](https://weave.nycu.ai/)

Groupthink is the failure mode where a group suppresses dissent to preserve harmony, stops thinking critically, and converges on a decision no member would have defended alone. It is invisible from inside the room, because the meeting feels productive precisely when nobody is arguing.

Weave In runs the meeting, transcribes every participant separately in their own browser, embeds what they say into a semantic space, and watches that space for the signatures of groupthink — opinions collapsing toward one point too early, the discussion leaving its own agenda, one voice carrying the room, agreement that adds no information. When a signature fires, the room says so, and asks the question the group is not asking.

```
apps/meeting          Landing page + meeting room (React + Vite), Cloudflare Worker + Durable Object
packages/transcribe   Headless live transcription core (Gemini, OpenAI)
packages/groupthink   Detection engine — pure, no I/O, no network            [in development]
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

Camera, microphone, screen share, and chat travel peer-to-peer and never touch our server. Transcript text does — that is how the room can analyze the discussion — and it is deleted when the room closes.

See `apps/meeting/README.md` for room limits, captions, and the `GEMINI_API_KEY` / `OPENAI_API_KEY` Worker secrets.

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
  loops and nested `subgraph` groups are supported. Existing content is preserved; one import is one
  undo step. Imports accept up to 12,000 characters and 300 native elements
  including labels. Other diagram types and image fallbacks are rejected.
  A pinned converter patch handles Mermaid 11’s diagram-prefixed group IDs.
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
