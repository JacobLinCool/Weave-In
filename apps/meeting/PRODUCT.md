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

The current product pairs browser meetings and per-participant transcription with a personal **Muse** tab and shared **Omni**. Muse opens directly into private chat with a settings button. Muse is configured on join and gives silent, evidence-based reminders when the owner’s explicit concern remains unresolved while a decision moves ahead. It supports private follow-up and can speak once for the owner after approval. Omni provides brief public text suggestions in Room chat. The wider room-level Groupthink model remains proposed.

Success means a participant can raise an overlooked concern before a decision is finalized. Post-meeting intervention reports remain future work.

## Positioning

Weave In helps participants notice an unresolved concern while the discussion is still underway.

The meeting itself is the instrument, not the product. Full-mesh video, screen share, chat, and per-speaker live captions exist because they are the cleanest possible sensor: each participant transcribes their own microphone through the configured provider, so speaker attribution is structurally correct rather than guessed by diarization, and every utterance arrives tagged, timestamped, and separable. That signal is what the detection engine needs and what a mixed-audio recorder cannot give it.

Name: Weave In. "Keep the thread. Weave everyone in." The tagline is the product thesis, not decoration: *keep the thread* is topic drift, *weave everyone in* is participation balance. A meeting is cloth. Groupthink is what happens when every pass of the shuttle takes the same dye.

## Operating Context

- The meeting runs in the browser: full-mesh WebRTC with Cloudflare STUN/TURN, up to 8 participants, six-character room codes, invite links of the form `?room=CODE`.
- Camera, microphone, screen share, chat, files, whiteboard edits, and captions travel over encrypted WebRTC between participants. Connections prefer a direct path and may use Cloudflare TURN to relay encrypted packets. The relay processes connection metadata but cannot decrypt the meeting content. The operator's signaling Worker handles connection setup and credential issuance, not the meeting media or data-channel payloads.
- Audio for captions travels directly from the speaker's browser to the selected AI provider (Gemini or OpenAI) using a single-use ephemeral token minted by the Worker.
- Agent settings and connection descriptions go to the Worker for GPT-Live initialization. Meeting records, private conversations and permitted tools then travel directly between the Client and OpenAI.
- The room Durable Object coordinates Agent identity, the single Group executor, leases and public speaking rights. It does not store utterances or embeddings. Coordination is deleted when the last member leaves.
- Personal source permissions can be set at creation and edited by the owner. Private conversations stay out of public replay and the meeting log. Speaking for the owner uses only the selected completed Muse reply or specifically approved reminder in a fresh session, without private history or tools; persistent public mode is disabled.
- Automatic reminder analysis sends bounded human transcript text and prior reminder evidence through the Worker to Gemini, without Worker persistence. It runs while the meeting page is open, without a Codex browser or external assistant session.
- Same-tab room recovery uses sessionStorage for meeting text, reminders and up to 200 private Muse lines, for up to 12 hours since the last save. It does not restore active audio sessions or queued speaking approvals.
- Display name and settings (languages spoken, caption style, captions on/off) persist in the browser's localStorage.

## Capabilities and Constraints

### Current implementation

- Silent private reminder cards float at the stage's lower left without reserving layout space. They collapse after 15 seconds, pausing while hovered or focused; evidence and history remain in the Muse panel.
- Automatic analysis covers explicit unresolved concerns bypassed by later decisions, delivered only to the concern's author. The same concern can recur on a substantive new commitment, execution or scope change, not a timer or paraphrased decision. Meaning and novelty remain model judgments, not a validated diagnosis of Groupthink.
- **Discuss privately** opens follow-up in personal Muse. **Speak for me** grants one brief public turn, allowing slight elaboration without new commitments or private details. The owner's microphone remains in its current state; owner speech stops the assistant without automatic resume. Every new turn needs another approval.
- One personal Muse is configured automatically per participant; one shared Omni is enabled automatically for the room without a setup form. Removing Omni keeps it off for the rest of that room unless explicitly added again. Role, language, source and tool permissions remain configurable.
- Omni publishes at most 240 characters to shared Room chat, labelled Omni, without audio or human approval. A persistent Omni card at the top of Room shows status, glows while preparing or publishing, and lets every participant edit settings; public suggestions replay to late joiners. A ready browser can take over if the runner leaves.
- Camera, microphone, screen share with live renegotiation, shared messages and files, per-speaker live captions, and a merged transcript.
- Up to four selected BCP-47 caption languages or automatic detection; Verbatim or Smart captions. Each browser sends its own audio directly to its caption provider.
- Signaling reconnects automatically while preserving local state. Refresh/rejoin restores the same tab's checkpoint, including private reminder and Muse text history; it does not replay interrupted speech.
- No accounts or meeting recording. Meeting media is encrypted between participants; Cloudflare TURN may relay it without decrypting it. The signaling Worker does not carry that media. Configured AI providers receive the selected audio/context. GPT-Live uses native browser WebRTC after authorized initialization, with Responses delegation.

### In development

These remain proposals. Do not describe them as running in the current implementation.

- **Semantic space analysis.** Every finalized utterance is embedded; the room maintains a rolling window, a group centroid, and a dispersion measure.
- **Four groupthink detectors.** Convergence (opinions collapsing too early), drift (the discussion leaving its own agenda), float (one voice running unchecked), and echo (agreement carrying no new information). Specified in `GROUPTHINK.md`.
- **Visual intervention.** When a detector fires, every participant sees a non-intrusive card on the stage and an entry in the Insights panel, carrying the named signal and a generated counter-question. These proposed surfaces do not replace the current silent private Muse cards or text-only Omni behavior.
- **The Hand.** A six-axis profile of each participant's communication style — airtime, initiative, challenge, inquiry, echo, influence — drawn as a radar in their thread colour.
- **The Trace.** The discussion's path through semantic space over time, rendered as a dimensionally-reduced trajectory, so convergence and drift are visible as shape rather than asserted as a number.
- **Post-meeting report.** The signal timeline, each intervention, and whether the discussion reopened after it.

### Explicitly deferred

- Shared whiteboard. The team decided the whiteboard is an instrument for capturing non-verbal interaction data, not a headline feature. It is not part of the first build and must not lead the pitch.
- Host-only dashboards. Private assistance belongs to each participant; shared public suggestions are visible to everyone, rather than restricted to the chair.

## Brand Commitments

- Name: Weave In. Tagline: "Keep the thread. Weave everyone in." (confirmed by the user, 2026-09-12; replaces the working name On Track)
- Landing page language: English.
- The animated demonstration on the landing page is built in-page with React/CSS/SVG, not as a video file.
- Privacy copy must distinguish encrypted peer media (which may use Cloudflare TURN), direct AI connections, and the Worker. TURN handles connection metadata but cannot decrypt WebRTC content. The Worker handles Agent settings, SDP, credential issuance and coordination, plus bounded transcript/reminder evidence for stateless Gemini analysis. It does not persist conversation records. AI providers receive the selected audio/context/tool data. Do not claim that all connections are direct, nothing leaves the browser, or no metadata reaches the server. Update the landing page and README with changes to these data paths.
- The assistant has no dye: it is not a participant, it is never given a thread colour, and it is never described as a member of the meeting.
- Detector output is stated as an observation with its evidence, never as a verdict about a person. "Three speakers in a row added no new position" is allowed. "You are being a conformist" is not.

## Evidence on Hand

- A working product in `apps/meeting`; real screenshots can be captured from the running app.
- The groupthink literature is the theoretical backing and is cited in `GROUPTHINK.md`. Citing Janis and the established literature is legitimate; claiming our detectors are validated against it is not, until they are.
- No testimonials, customers, metrics, press, or pricing. Do not fabricate any.

## Product Principles

1. **Name the moment, not the person.** Every signal is attached to a timestamp and an utterance the group can go back and look at. The product describes what the discussion did, never what a participant is.
2. **Respect private and shared audiences.** Muse reminders and discussion belong to their owner. Only a selected completed Muse reply or specifically approved reminder may be spoken for them; Omni uses public context and posts visibly to the room.
3. **AI assists thinking and never replaces it.** Participants retain decisions. Muse needs approval for each public spoken turn and stops when its owner speaks. Omni offers brief text, never unsolicited audio.
4. **Truth over slogans.** Privacy claims name exactly what leaves the browser and where it goes. The claim changed when the product changed; the copy changes with it.
5. **Every voice is its own source.** Each person transcribes themselves; nothing is mixed or attributed by guesswork. Correct attribution is a precondition for every measurement downstream.
6. **Intervene rarely and well.** An assistant that fires constantly is noise, and a group learns to ignore noise. The implemented detector uses cooldowns, evidence checks and substantive-development rules; broader warm-up and per-meeting caps belong to the proposed detector model.
7. **Zero-friction entry.** A link, a name, a room.
