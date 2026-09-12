# Weave In

Keep the thread. Weave everyone in.

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

Meeting media, chat and public transcripts travel peer-to-peer. Caption audio goes directly to the selected AI provider. Agent context, selected files/screens and conversations go directly to OpenAI after initialization. Our server handles connection information, Agent settings and room coordination; it does not store meeting transcripts or private conversations.

See `apps/meeting/README.md` for room limits, captions, and the `GEMINI_API_KEY` / `OPENAI_API_KEY` Worker secrets.
