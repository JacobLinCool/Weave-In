> Implementation note for PR #2: the automatic private-reminder prototype uses stateless, per-participant Worker analysis of recent transcripts, without room-wide persistence or broadcasts. The architecture and exact privacy wording below describe the broader planned system. Current implementation behavior and user-facing privacy copy are documented in README; they take precedence for this prototype.

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

Weave In runs the meeting, transcribes every participant separately, embeds what they say into a semantic space, and watches that space for the signatures of groupthink — opinions collapsing toward a single point too early, the discussion wandering off its own agenda, one voice carrying the room, agreement that adds no information. When a signature fires, the room says so, and offers the counter-question the group is not asking.

Success: a team finishes a meeting, sees the three moments where they stopped disagreeing, and can point to the intervention that reopened the discussion.

## Positioning

Every meeting tool on the market records what was said. Weave In reads how the group is thinking while it says it.

The meeting itself is the instrument, not the product. Full-mesh video, screen share, chat, and per-speaker live captions exist because they are the cleanest possible sensor: each participant transcribes their own microphone locally, so speaker attribution is structurally correct rather than guessed by diarization, and every utterance arrives tagged, timestamped, and separable. That signal is what the detection engine needs and what a mixed-audio recorder cannot give it.

Name: Weave In. "Keep the thread. Weave everyone in." The tagline is the product thesis, not decoration: *keep the thread* is topic drift, *weave everyone in* is participation balance. A meeting is cloth. Groupthink is what happens when every pass of the shuttle takes the same dye.

## Operating Context

- The meeting runs in the browser: full-mesh WebRTC with Cloudflare STUN/TURN, up to 8 participants, six-character room codes, invite links of the form `?room=CODE`.
- Camera, microphone, screen share, chat, files, whiteboard edits, and captions travel over encrypted WebRTC between participants. Connections prefer a direct path and may use Cloudflare TURN to relay encrypted packets. The relay processes connection metadata but cannot decrypt the meeting content. The operator's signaling Worker handles connection setup and credential issuance, not the meeting media or data-channel payloads.
- Audio for captions travels directly from the speaker's browser to the selected AI provider (Gemini or OpenAI) using a single-use ephemeral token minted by the Worker.
- **Transcript text is sent to the operator's server.** Finalized utterances go from each browser to that room's Durable Object over the existing signaling socket, where they are stored for the life of the room and analyzed. This is the deliberate cost of the analysis; see Brand Commitments for exactly how it must be described.
- A Cloudflare Worker with one Durable Object per room relays SDP/ICE signaling, mints transcription tokens, holds the room's utterance log, runs the groupthink detectors, and broadcasts analysis and interventions back to every participant.
- Embedding and intervention-generation calls are made server-side from the Durable Object. Browsers talk only to the same origin for analysis, so the page's connect-src is unchanged.
- The room's stored transcript, embeddings, and analysis are deleted when the room closes. There are no accounts and nothing survives the meeting unless a participant exports it.
- Display name and settings (languages spoken, caption style, captions on/off) persist in the browser's localStorage.

## Capabilities and Constraints

### Shipped

- Private, agent-authored reminders in a reserved page dock and a Private history tab. Evidence comes from this browser's meeting record. Reminders remain local, can be hidden or dismissed, expire, and are cleared on leaving. Follow-up stays in the existing assistant conversation. This is a delivery surface, not an implemented Groupthink detector or autonomous monitoring service.

- Camera, microphone, screen share with live renegotiation, chat panel, per-speaker live captions on tiles, and a merged transcript panel.
- Per-participant local transcription: each browser transcribes only its own microphone (browser echo cancellation keeps remote voices out) and streams interim and final text to everyone.
- Up to 4 selected BCP-47 languages or automatic detection; caption style Verbatim or Smart.
- No accounts or recording. Meeting media is encrypted between participants; Cloudflare TURN may relay it without decrypting it.

### In development

These are the product. They are not shipped and must never be described as though they were.

- **Semantic space analysis.** Every finalized utterance is embedded; the room maintains a rolling window, a group centroid, and a dispersion measure.
- **Four groupthink detectors.** Convergence (opinions collapsing too early), drift (the discussion leaving its own agenda), float (one voice running unchecked), and echo (agreement carrying no new information). Specified in `GROUPTHINK.md`.
- **Visual intervention.** When a detector fires, every participant sees a non-intrusive card on the stage and an entry in the Insights panel, carrying the named signal and a generated counter-question. The assistant never speaks, never injects itself into chat as a participant, and never interrupts someone mid-utterance.
- **The Hand.** A six-axis profile of each participant's communication style — airtime, initiative, challenge, inquiry, echo, influence — drawn as a radar in their thread colour.
- **The Trace.** The discussion's path through semantic space over time, rendered as a dimensionally-reduced trajectory, so convergence and drift are visible as shape rather than asserted as a number.
- **Post-meeting report.** The signal timeline, each intervention, and whether the discussion reopened after it.

### Explicitly deferred

- Shared whiteboard. The team decided the whiteboard is an instrument for capturing non-verbal interaction data, not a headline feature. It is not part of the first build and must not lead the pitch.
- Voice intervention (TTS). Considered and set aside: interrupting a live meeting with synthetic speech is a larger product and ethics question than the first build should take on.
- Host-only dashboards. Analysis is shown to everyone in the room. A group cannot correct a bias that only its most senior member can see.

## Brand Commitments

- Name: Weave In. Tagline: "Keep the thread. Weave everyone in." (confirmed by the user, 2026-09-12; replaces the working name On Track)
- Landing page language: English.
- The animated demonstration on the landing page is built in-page with React/CSS/SVG, not as a video file.
- Privacy descriptions distinguish encrypted WebRTC (which may use a Cloudflare TURN relay), signaling and credential issuance in the Worker, and transcript analysis. Do not promise that all connections are direct. Cloudflare TURN can process connection metadata but cannot decrypt WebRTC media or data. Current private analysis sends transcript context through the Worker to Gemini without server persistence; any future room-wide storage must ship with matching disclosure and retention behavior. Update the landing page and README with changes to these data paths.
- The assistant has no dye: it is not a participant, it is never given a thread colour, and it is never described as a member of the meeting.
- Detector output is stated as an observation with its evidence, never as a verdict about a person. "Three speakers in a row added no new position" is allowed. "You are being a conformist" is not.

## Evidence on Hand

- A working product in `apps/meeting`; real screenshots can be captured from the running app.
- The groupthink literature is the theoretical backing and is cited in `GROUPTHINK.md`. Citing Janis and the established literature is legitimate; claiming our detectors are validated against it is not, until they are.
- No testimonials, customers, metrics, press, or pricing. Do not fabricate any.

## Product Principles

1. **Name the moment, not the person.** Every signal is attached to a timestamp and an utterance the group can go back and look at. The product describes what the discussion did, never what a participant is.
2. **The group sees what the room sees.** Analysis is broadcast to every participant. A bias visible only to the chair is a new authority problem, not a fix for the old one.
3. **AI assists thinking and never replaces it.** The assistant asks the question the group is not asking. It does not have an opinion about the decision, and it never tells the group what to conclude.
4. **Truth over slogans.** Privacy claims name exactly what leaves the browser and where it goes. The claim changed when the product changed; the copy changes with it.
5. **Every voice is its own source.** Each person transcribes themselves; nothing is mixed or attributed by guesswork. Correct attribution is a precondition for every measurement downstream.
6. **Intervene rarely and well.** An assistant that fires constantly is noise, and a group learns to ignore noise. Cooldowns, warm-up periods, and a hard cap per meeting are features, not limitations.
7. **Zero-friction entry.** A link, a name, a room.
