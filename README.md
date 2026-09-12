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
