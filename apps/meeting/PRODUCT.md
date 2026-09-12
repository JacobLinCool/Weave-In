# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Teams that make consequential decisions in meetings — product, research, strategy, investment committees — and who suspect their meetings reach agreement faster than they reach understanding.
- Facilitators, chairs, and team leads who know a discussion is going wrong but cannot name the moment it did, and have nothing but instinct to act on.
- Privacy-conscious small remote teams (startups, research groups, advisors) who discuss sensitive material and want their camera, microphone, and screen to stay between the people in the room.
- All three care about keeping their own critical thinking intact while collaborating. The product should help every participant contribute input rather than let one voice dominate.

## Product Purpose

Detect groupthink while it is happening and intervene before the decision is made.

Groupthink is the failure mode where a group suppresses dissent to preserve harmony, stops thinking critically, and converges on a low-quality decision that no individual member would have defended alone. It is invisible from inside the room: the meeting feels productive precisely because nobody is arguing.

The current product pairs browser meetings and per-participant transcription with personal thinking partners and one shared facilitator. Owners explicitly ask their Personal assistant for help. A manual signal asks the Group to prepare; it raises its hand and waits for a participant to invite it. Automatic semantic detection remains a proposed extension.

Success: a team finishes a meeting, sees the three moments where they stopped disagreeing, and can point to the intervention that reopened the discussion.

## Positioning

Every meeting tool on the market records what was said. Weave In reads how the group is thinking while it says it.

The meeting itself is the instrument, not the product. Full-mesh video, screen share, chat, and per-speaker live captions exist because they are the cleanest possible sensor: each participant transcribes their own microphone locally, so speaker attribution is structurally correct rather than guessed by diarization, and every utterance arrives tagged, timestamped, and separable. That signal is what the detection engine needs and what a mixed-audio recorder cannot give it.

Name: Weave In. "Keep the thread. Weave everyone in." The tagline is the product thesis, not decoration: *keep the thread* is topic drift, *weave everyone in* is participation balance. A meeting is cloth. Groupthink is what happens when every pass of the shuttle takes the same dye.

## Operating Context

- The meeting runs entirely in the browser: full-mesh WebRTC, public STUN only, up to 8 participants, six-character room codes, invite links of the form `?room=CODE`.
- Camera, microphone, and screen share travel peer-to-peer and are never sent to, mixed by, or recorded on the operator's server. Chat travels peer-to-peer over the same data channels.
- Audio for captions travels directly from the speaker's browser to the selected AI provider (Gemini or OpenAI) using a single-use ephemeral token minted by the Worker.
- Agent settings and connection descriptions go to the Worker for GPT-Live initialization. Meeting records, private conversations and permitted tools then travel directly between the Client and OpenAI.
- The room Durable Object coordinates Agent identity, the single Group executor, leases and public speaking rights. It does not store utterances or embeddings. Coordination is deleted when the last member leaves.
- Personal source permissions are chosen at creation. Private content never enters public replay or WebMCP. Changing to public mode retains private context and warns about possible references in future answers.
- Display name and settings (languages spoken, caption style, captions on/off) persist in the browser's localStorage.

## Capabilities and Constraints

### Current implementation

- Camera, microphone, screen share with live renegotiation, chat panel, per-speaker live captions on tiles, and a merged transcript panel.
- Per-participant local transcription: each browser transcribes only its own microphone (browser echo cancellation keeps remote voices out) and streams interim and final text to everyone.
- Up to 4 selected BCP-47 languages or automatic detection; caption style Verbatim or Smart.
- No accounts, no recording, no media ever reaching the server.

- One Personal Agent per owner, one Group per meeting; editable role/language and explicit source/tool permissions.
- GPT-Live voice and transcription with Responses delegation, running through native Client WebRTC after authorized server initialization.
- Group preparation, hand raising, participant approval, speaking priority and automatic takeover to an available Client.

### In development

These remain proposals. Do not describe them as running in the current implementation.

- **Semantic space analysis.** Every finalized utterance is embedded; the room maintains a rolling window, a group centroid, and a dispersion measure.
- **Four groupthink detectors.** Convergence (opinions collapsing too early), drift (the discussion leaving its own agenda), float (one voice running unchecked), and echo (agreement carrying no new information). Specified in `GROUPTHINK.md`.
- **Visual intervention.** When a detector fires, every participant sees a non-intrusive card on the stage and an entry in the Insights panel, carrying the named signal and a generated counter-question. Future detector signals must use the existing Group preparation and approval flow before public speech.
- **The Hand.** A six-axis profile of each participant's communication style — airtime, initiative, challenge, inquiry, echo, influence — drawn as a radar in their thread colour.
- **The Trace.** The discussion's path through semantic space over time, rendered as a dimensionally-reduced trajectory, so convergence and drift are visible as shape rather than asserted as a number.
- **Post-meeting report.** The signal timeline, each intervention, and whether the discussion reopened after it.

### Explicitly deferred

- Shared whiteboard. The team decided the whiteboard is an instrument for capturing non-verbal interaction data, not a headline feature. It is not part of the first build and must not lead the pitch.
- Host-only dashboards. Analysis is shown to everyone in the room. A group cannot correct a bias that only its most senior member can see.

## Brand Commitments

- Name: Weave In. Tagline: "Keep the thread. Weave everyone in." (confirmed by the user, 2026-09-12; replaces the working name On Track)
- Landing page language: English.
- The animated demonstration on the landing page is built in-page with React/CSS/SVG, not as a video file.
- Privacy copy must distinguish peer media, direct AI connections and server metadata. Our server handles Agent settings, SDP and coordination, not meeting or private conversation records. AI providers receive the selected audio/context/tool data. Do not claim that nothing leaves the browser or that no metadata reaches the server.
- The assistant has no dye: it is not a participant, it is never given a thread colour, and it is never described as a member of the meeting.
- Detector output is stated as an observation with its evidence, never as a verdict about a person. "Three speakers in a row added no new position" is allowed. "You are being a conformist" is not.

## Evidence on Hand

- A working product in `apps/meeting`; real screenshots can be captured from the running app.
- The groupthink literature is the theoretical backing and is cited in `GROUPTHINK.md`. Citing Janis and the established literature is legitimate; claiming our detectors are validated against it is not, until they are.
- No testimonials, customers, metrics, press, or pricing. Do not fabricate any.

## Product Principles

1. **Name the moment, not the person.** Every signal is attached to a timestamp and an utterance the group can go back and look at. The product describes what the discussion did, never what a participant is.
2. **The group sees what the room sees.** Analysis is broadcast to every participant. A bias visible only to the chair is a new authority problem, not a fix for the old one.
3. **AI assists thinking and never replaces it.** The assistant asks the question the group is not asking. It may propose alternatives and recommendations, but members retain the decision and control its speaking permission.
4. **Truth over slogans.** Privacy claims name exactly what leaves the browser and where it goes. The claim changed when the product changed; the copy changes with it.
5. **Every voice is its own source.** Each person transcribes themselves; nothing is mixed or attributed by guesswork. Correct attribution is a precondition for every measurement downstream.
6. **Intervene rarely and well.** An assistant that fires constantly is noise, and a group learns to ignore noise. Cooldowns, warm-up periods, and a hard cap per meeting are features, not limitations.
7. **Zero-friction entry.** A link, a name, a room.
