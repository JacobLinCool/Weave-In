---
version: 1
slug: "src-landing-tsx"
primary_target: "src/landing.tsx"
related_targets: ["src/brand.tsx","index.html"]
---

# Landing page (src/landing.tsx)

Scope: the pre-join surface at `/` (and `/?room=CODE` invites). Mode: Persuade.

Audience and job: teams who make consequential decisions in meetings and suspect they reach agreement faster than understanding, plus the privacy-conscious small teams and friend groups who were the original audience. They must believe three things in seconds: groupthink is a real and costly failure mode they cannot see from inside the room; this product can see it, because every participant is transcribed separately and the discussion is measured as it happens; their camera, microphone, screen, and chat stay between browsers.

Action: "Create a room" (primary) and join-by-code / invite prefill in the room panel; the panel keeps the pre-join preview and mic/camera toggles. Settings (languages, caption style, captions on/off) open from the header.

Proof on hand: the live draft demonstration (synthetic, labelled), the exact data-path key ("Where your data goes"), the specification table. The groupthink literature may be cited as the theoretical basis (see GROUPTHINK.md § Required reading); detector accuracy may not be claimed, because it has not been measured. No testimonials, customers, or metrics exist; none may be added.

Constraints: claims follow PRODUCT.md exactly. **The privacy claim is scheduled to change and this surface will carry a false version the moment it does.** Today's copy is accurate; it stops being accurate when utterance transport ships (ARCHITECTURE.md § Build order, step 2), and the rewrite belongs in that same commit. New wording: camera, microphone, screen share, and chat never touch our server; transcript text does, so the room can analyze the discussion, and it is deleted when the room closes. The "Where your data goes" key gains a transcript-to-server row, and the empty dashed "Our server" chip stops being right for it — that chip means "carries nothing", and the server will then carry something. Audio for captions still goes browser -> Gemini/OpenAI with a single-use token. English copy. No video assets; motion is in-page React/CSS. The whiteboard is deferred and must not be promised; analysis features in development must not be described as shipped.

Chosen direction: The Weaver's Draft (user's pick on the decision round, seed 555f8bb4). Memorable moment: the drawdown weaving itself in the first viewport, one caption row every ~2s in the speaker's thread colour, with the tie-up grid showing every warp tied to every other and nothing in the middle.

Open opportunity: the draft already demonstrates the product thesis and does not yet say so. A drawdown whose picks converge to a single dye is groupthink rendered literally, in the visual language the page already speaks — the strongest available version of this hero, and it needs no new vocabulary. See DESIGN.md § Overview for the metaphor mapping.

Unresolved: whether the in-meeting room should adopt more of the draft grammar beyond seat colours and the mark; whether a Remotion explainer video is ever wanted (declined for now).
