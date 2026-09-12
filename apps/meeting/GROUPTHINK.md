# Groupthink: detection model

The specification for what Weave In measures, what counts as a signal, and what the room does about it. `PRODUCT.md` says why; this file says how. This is a future detection proposal; `packages/groupthink` does not exist in the current build. Today a manual system signal triggers the Client Group Agent described in `ARCHITECTURE.md`.

## 1. What we are claiming

Janis defined groupthink as the deterioration of mental efficiency, reality testing, and moral judgement that results from in-group pressure. Its antecedents are cohesion, insulation, directive leadership, and stress; its symptoms include the illusion of unanimity, self-censorship, direct pressure on dissenters, and a failure to examine alternatives.

We cannot observe cognition. We can observe **language and turn-taking**, which is the layer the symptoms surface in. The model below is a set of behavioural proxies, each one a defensible operationalisation of a named symptom:

| Janis symptom | Observable proxy | Detector |
| --- | --- | --- |
| Illusion of unanimity | Utterance embeddings collapse toward one point early | `convergence` |
| Self-censorship, no examination of alternatives | Agreement that adds no semantic information | `echo` |
| Direct pressure / directive leadership | One speaker dominates airtime and pulls the group centroid | `float` |
| Failure to appraise the original objective | Discussion centroid leaves the agenda anchor | `drift` |

**Claim discipline.** These proxies are *motivated by* the literature. They are not validated against it. Say "we operationalise the illusion of unanimity as early embedding convergence"; do not say "we detect groupthink with N% accuracy". The honest pitch is stronger than the fabricated one and survives a hostile question from a judge.

### Required reading before the hackathon

Everyone reads at least the first three.

1. Janis, I. L. (1972/1982). *Victims of Groupthink* / *Groupthink: Psychological Studies of Policy Decisions and Fiascoes*. The source. Read the symptom taxonomy and the Bay of Pigs vs. Cuban Missile Crisis contrast.
2. Esser, J. K. (1998). "Alive and Well after 25 Years: A Review of Groupthink Research." *OBHDP*. The honest meta-review — tells you which of Janis's antecedents actually replicate and which do not. Read this before claiming anything.
3. Nemeth, C. J. (1986). "Differential Contributions of Majority and Minority Influence." *Psychological Review*. Why dissent improves decision quality even when the dissenter is wrong. This is the theoretical warrant for intervening at all.
4. Stasser, G. & Titus, W. (1985). "Pooling of Unshared Information in Group Decision Making." The hidden profile paradigm — groups discuss what everyone already knows. Directly motivates the `echo` detector.
5. Schulz-Hardt, S. et al. (2006). "Group decision making in hidden profile situations: dissent as a facilitator." Evidence that structured dissent works, which is what the intervention is.
6. Optional, for the participation metrics: Woolley, A. W. et al. (2010). "Evidence for a Collective Intelligence Factor." *Science*. Equality of conversational turn-taking predicts group performance — this is the citation behind `float`.

## 2. Inputs

The detection engine is a pure function of an event log. It performs no I/O, which is what makes it testable.

```ts
type Utterance = {
  id: string;
  peerId: string;
  text: string;
  at: number;          // epoch ms, speaker's clock, normalized on arrival
  durationMs: number;  // from voice-activity, not text length
  embedding: Float32Array | null; // filled in asynchronously
};

type ActivityEvent = {
  peerId: string;
  startedAt: number;
  endedAt: number;
  overlappedWith: string[]; // peerIds speaking simultaneously — interruption evidence
};

type Agenda = { text: string; embedding: Float32Array | null } | null;
```

`durationMs` and `overlappedWith` come from `src/voice-activity.ts`, which today only drives the speaking ring. Turning its RMS level into start/stop/overlap events is the single highest-leverage piece of plumbing in this project: it is the entire non-verbal channel and it already exists.

## 3. Derived state

Maintained incrementally, recomputed on every finalized utterance.

- **Window** `W` — the last `WINDOW_SIZE` utterances that have embeddings (default 10), or the last `WINDOW_MS` (default 180 000), whichever is smaller.
- **Centroid** `c(W)` — mean of the window's embeddings, L2-normalized.
- **Dispersion** `D(W)` — mean cosine distance from each embedding in `W` to `c(W)`. Range roughly 0 (everyone saying the same thing) to 1. This is the master variable: **groupthink is low dispersion reached too early.**
- **Novelty** `n(u)` — `1 - max cosine similarity between u and the previous k utterances` (default k=5). How much a single utterance adds.
- **Airtime share** `p_i` — participant `i`'s share of total speaking `durationMs`.
- **Influence** `I_i` — mean displacement of `c(W)` toward participant `i`'s vector in the utterances following theirs. How much the room moves when they speak.
- **Anchor** `a` — the agenda embedding if one was set, otherwise the centroid of the first `ANCHOR_SIZE` utterances (default 8). A meeting always has an anchor by the time warm-up ends.

## 4. Detectors

All four share a guard: **no detector fires during warm-up** (`WARMUP_MS`, default 120 000, and at least `MIN_UTTERANCES`, default 12). A group that agrees in the first two minutes has not yet had time to disagree, and firing there makes the product look stupid on the first demo.

### 4.1 `convergence` — the illusion of unanimity

Fires when the window's dispersion falls below `θ_converge` (default 0.28) **and** has fallen by at least `CONVERGE_DROP` (default 0.15) over the last `CONVERGE_SPAN` utterances (default 6), **and** the mean novelty across the window is below `θ_novelty` (default 0.30).

The three-part condition matters. Low dispersion alone just means the group is on topic. Low dispersion reached *quickly*, with *nothing new being added*, is the signature. Severity scales with how far below threshold the dispersion sits.

Evidence payload: the utterance ids whose novelty was lowest, so the UI can point at the actual moment.

### 4.2 `drift` — losing the thread

Fires when `cosine_distance(c(W), a) > θ_drift` (default 0.55) sustained for `DRIFT_SUSTAIN_MS` (default 90 000).

The sustain requirement is what separates drift from a productive tangent. Groups legitimately wander for a minute; the signal is failing to come back. Severity scales with distance beyond threshold and with time sustained.

Evidence payload: the anchor text (or first-utterances summary) and the current window's dominant terms.

### 4.3 `float` — one voice running unchecked

Two independent triggers, either sufficient:

- **Distribution.** Normalized entropy of airtime `H = -Σ p_i·ln(p_i) / ln(n)` falls below `θ_entropy` (default 0.72) with at least `MIN_SPEAKERS` participants present. Perfectly equal airtime is 1.0; one person holding the floor approaches 0.
- **Run length.** A single participant holds `FLOAT_RUN` consecutive utterances (default 5) or `FLOAT_MS` of continuous speaking (default 180 000).

Named for the weaving fault: a thread that passes over many others without interlacing makes a long float, and long floats make weak cloth.

Evidence payload: the airtime table and, for the distribution trigger, who has spoken least.

### 4.4 `echo` — agreement carrying no information

Per-utterance classification: an utterance is an echo if `n(u) < θ_echo_novelty` (default 0.22) **and** it is shorter than `ECHO_MAX_CHARS` (default 120). Optionally boosted by an agreement-marker lexicon, which must be maintained per language — note this is the one detector with a language dependency, and it degrades to the novelty test alone when the lexicon is missing.

Fires when the echo ratio in the window exceeds `θ_echo_ratio` (default 0.45).

Evidence payload: the consecutive echo utterances.

### 4.5 Composite severity

Each detector returns `{ signal, severity: 0..1, evidence, at }`. `convergence` co-firing with `echo` is the textbook pattern and is escalated one severity band — that combination is the demo moment worth engineering for.

## 5. The Hand — communication profile

Six axes per participant, each normalized 0..1 against the room rather than an absolute scale, because the question is always *relative to this group*. Drawn as a radar in the participant's thread colour.

| Axis | Measure |
| --- | --- |
| **Airtime** | `p_i`, share of speaking duration |
| **Initiative** | mean novelty of their utterances |
| **Challenge** | rate of utterances whose embedding moves *away* from the current centroid |
| **Inquiry** | question rate (interrogatives, per language) |
| **Echo** | rate of their utterances classified as echo — plotted as-is, low is healthy |
| **Influence** | `I_i`, centroid displacement following their turns |

The Hand is descriptive and must be labelled as such in the UI. It is a picture of how someone participated in *this meeting*, not a personality assessment, and the copy must not let a viewer mistake it for one.

## 6. Intervention policy

An intervention is generated only when **all** of these hold:

1. A detector fired at severity ≥ `MIN_SEVERITY` (default 0.5).
2. `COOLDOWN_MS` (default 120 000) has elapsed since the last intervention of any kind.
3. Fewer than `MAX_INTERVENTIONS` (default 5) have fired this meeting.
4. Nobody has been speaking for `QUIET_MS` (default 1 500) — do not land a card while someone is mid-sentence.

| Signal | Intervention | Shape of the generated text |
| --- | --- | --- |
| `convergence` | `counterpoint` | The strongest argument against the position the room has converged on, stated as a question the group can answer. |
| `drift` | `refocus` | Names the anchor, names where the discussion is now, asks whether the move was intended. |
| `float` | `invite` | Invites the least-heard participants by name to respond to the current point. Never scolds the dominant speaker. |
| `echo` | `deepen` | Asks for the strongest *reason* behind the agreement, or for information only one person in the room has. |

**Generation constraints** (these belong in the system prompt):

- One question, at most two sentences. A paragraph will not be read mid-meeting.
- No verdict about the group and no evaluation of any person.
- No opinion about the decision itself — the assistant asks, it does not advocate.
- Quote or reference the actual discussion so it is visibly not generic.
- Match the language of the meeting.

**Effect measurement.** Record `D(W)` and `H` at fire time and again `EFFECT_WINDOW_MS` later (default 180 000). A rise in dispersion or entropy after an intervention is the evidence that it worked. This is the single most persuasive number in the demo and the post-meeting report, and it costs almost nothing to capture — instrument it from the first commit.

## 7. Constants

Every threshold above is a named constant in one exported config object, overridable per room. Two reasons: they will all be wrong on the first real meeting, and a demo needs a "sensitive" preset that fires reliably inside eight minutes. Ship both `DEFAULT_THRESHOLDS` and `DEMO_THRESHOLDS`.

## 8. Failure modes to design against

- **Short meetings.** Below `MIN_UTTERANCES` the model says nothing and the UI must say *why* it is quiet, not look broken.
- **Two-person meetings.** `float` entropy is meaningless at n=2; gate it on `MIN_SPEAKERS` (default 3).
- **Multilingual rooms.** Embeddings are cross-lingual enough for dispersion; the echo lexicon and question detection are not. Degrade, do not guess.
- **Transcription noise.** A garbled utterance reads as high novelty and suppresses `convergence`. Drop utterances below `MIN_CHARS` (default 15) from the window.
- **A genuinely aligned group.** Real consensus after real debate looks like late low dispersion preceded by *high* dispersion. The `CONVERGE_DROP` requirement is what distinguishes it. Do not remove it to make the demo fire more easily — use `DEMO_THRESHOLDS` for that.
- **Self-fulfilling measurement.** Participants who know they are scored on airtime will manipulate airtime. Worth stating out loud in the pitch as a known limitation; a judge will otherwise raise it as a gotcha.
