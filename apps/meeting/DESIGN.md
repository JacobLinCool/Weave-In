---
name: Weave In
description: Agent-native browser meetings with indigo surfaces, cotton type, human thread colors, and a light shared whiteboard.
colors:
  base: "#141a33"
  panel: "#1b2242"
  raised: "#232b52"
  stage: "#10142a"
  line: "#303a6b"
  line-soft: "#262f5a"
  ink: "#f3eee3"
  muted: "#c9c4b8"
  dim: "#9a968c"
  interim: "#cfcabf"
  weld: "#e9b44c"
  weld-hover: "#f2c46a"
  weld-ink: "#1a1408"
  peach: "#f4a27e"
  madder: "#e0563f"
  verdigris: "#5fc7a2"
  woad: "#7fb3e6"
  lilac: "#b79be8"
  moss: "#9bbf5a"
  rose: "#e98bb4"
  coral: "#ff806d"
  mint-pale: "#97e9c6"
typography:
  display:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(50px, 6.2vw, 92px)"
    fontWeight: 500
    lineHeight: 0.96
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(30px, 3.4vw, 46px)"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  about-heading:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "44px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  about-heading-mobile:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.01em"
  lede:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(16px, 1.25vw, 19px)"
    fontWeight: 400
    lineHeight: 1.6
  body:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.65
  about-body:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.8
  about-body-mobile:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.8
  body-compact:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  caption:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(14px, 1.35vw, 19px)"
    fontWeight: 590
    lineHeight: 1.45
  button:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 730
  chrome:
    fontFamily: "Jost Variable, Jost, Helvetica Neue, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 670
  notation:
    fontFamily: "Azeret Mono Variable, Azeret Mono, ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.1em"
  code:
    fontFamily: "Azeret Mono Variable, Azeret Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 520
    letterSpacing: "0.18em"
rounded:
  thread: "3px"
  tag: "4px"
  inner: "8px"
  field: "10px"
  control: "12px"
  panel: "14px"
  dialog: "16px"
  pill: "999px"
  mark: "22%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  gutter: "clamp(20px, 5vw, 72px)"
  section: "clamp(64px, 9vh, 112px)"
components:
  button-primary:
    backgroundColor: "{colors.weld}"
    textColor: "{colors.weld-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "43px"
  button-primary-hover:
    backgroundColor: "{colors.weld-hover}"
  button-primary-large:
    height: "51px"
    width: "100%"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "48px"
  button-icon:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    size: "36px"
  button-icon-hover:
    backgroundColor: "{colors.raised}"
  button-transport:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.chrome}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "39px"
  button-transport-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  button-transport-off:
    textColor: "{colors.coral}"
  button-transport-active:
    textColor: "{colors.verdigris}"
  input-field:
    backgroundColor: "{colors.base}"
    textColor: "{colors.ink}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.field}"
    padding: "0 12px"
    height: "44px"
  input-code:
    backgroundColor: "{colors.base}"
    textColor: "{colors.ink}"
    typography: "{typography.code}"
    rounded: "{rounded.field}"
    padding: "0 12px"
    height: "48px"
  pill-caption-status:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.chrome}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "32px"
  card-room-panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
    padding: "18px 18px 20px"
  card-draft:
    backgroundColor: "rgba(27, 34, 66, 0.7)"
    rounded: "{rounded.control}"
    padding: "20px 20px 16px"
  card-dialog:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.dialog}"
    padding: "20px 24px 22px"
    width: "min(100%, 580px)"
  message-row:
    backgroundColor: "{colors.raised}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.field}"
    padding: "9px 11px"
  tab-side-panel:
    textColor: "{colors.muted}"
    height: "46px"
  tab-side-panel-active:
    textColor: "{colors.ink}"
---

# Design System: Weave In

## Scope and identity

This document describes the implemented landing page and meeting interface. The rendering sources are [src/style.css](src/style.css), [src/agents/style.css](src/agents/style.css) and [src/whiteboard.css](src/whiteboard.css). Product behavior and data boundaries are described in [PRODUCT.md](PRODUCT.md); Omni's review policy is in [GROUPTHINK.md](GROUPTHINK.md).

**The Weaver's Draft** connects the brand and the meeting. Indigo forms the surrounding cloth, cotton carries the text, and dyed threads identify human speakers. A caption becomes a weft crossing the participants' warps in the landing illustration. The name is **Weave In** and the tagline is **Keep the thread. Weave everyone in.**

The landing uses generous, ruled sections. The room uses compact controls and gives most of the viewport to video, screen sharing or the shared board. Muse has a conversational panel; Omni has a persistent status and approval card within Room. The whiteboard is a light Excalidraw canvas within the indigo meeting frame.

## Color and typography

### Meeting palette

| Role | Values | Use |
| --- | --- | --- |
| Cloth, panel, raised | `#141a33`, `#1b2242`, `#232b52` | Page ground, panels, fields and message surfaces. |
| Stage | `#10142a` | Video and presentation surroundings. |
| Line, line soft | `#303a6b`, `#262f5a` | Borders, dividers and scrollbars. |
| Cotton, muted, dim | `#f3eee3`, `#c9c4b8`, `#9a968c` | Primary copy, supporting copy, metadata. |
| Gold, hover, ink | `#e9b44c`, `#f2c46a`, `#1a1408` | Primary actions, active tabs, focus and selection. |
| Coral | `#ff806d` | Muted/off controls, Leave and errors. |
| Verdigris, pale mint | `#5fc7a2`, `#97e9c6` | Live captions, active sharing and related status tints. |

The participant palette is peach `#f4a27e`, madder `#e0563f`, weld `#e9b44c`, verdigris `#5fc7a2`, woad `#7fb3e6`, lilac `#b79be8`, moss `#9bbf5a` and rose `#e98bb4`. Each browser uses peach for itself and assigns peer colors in its local join order. Colors identify speakers in avatars, speaking rings and public records; they do not represent a score or psychological state.

Gold identifies primary actions and selection, but secondary controls use cotton on indigo. Muse's circular composer Send control is cotton on the base color. Its completed-message Send affordance is a neutral icon that appears on interaction. Omni's active card uses a gold border and a steady glow while preparing, waiting for approval or speaking. These are distinct implemented control treatments, not participant identities.

Public assistant speech uses neutral cotton styling and explicit names such as **Omni** or **<owner>'s Muse**. Assistant-authored Room posts retain the sender's attribution with a bot glyph, assistant-name chip and dashed border. Assistants do not receive human video tiles.

### Type

Jost Variable is the main face, with Jost, Helvetica Neue, Arial and sans-serif alternatives. Azeret Mono Variable supplies codes, compact notation, file metadata, the meeting timer and code/plain-text content. Both families are self-hosted; `font-synthesis: none` prevents synthesized faces.

| Text | Current treatment |
| --- | --- |
| Hero | Jost 500, `clamp(50px, 6.2vw, 92px)`, line-height `.96`, tracking `-.035em`. |
| Section heading | Jost 500, `clamp(30px, 3.4vw, 46px)`, line-height `1.05`, tracking `-.025em`. |
| Room-panel heading | Jost 500, `20px`, tracking `-.01em`. |
| Landing body | Jost 400, approximately `15.5–19px`, line-height `1.6–1.65`. |
| Room rows | Jost `13px`, line-height `1.45`; author names and timestamps use smaller sizes. |
| Muse composer | Jost `16px`, line-height `1.5`, with a growing textarea. |
| Tabs | Jost `11px/700`, uppercase, tracking `.04em`. |
| Room code | Azeret Mono `13px/600`, tracking `.13em`. |

Display headings remain medium weight. Compact controls and captions use heavier weights for legibility. Timestamps in message lists use tabular figures. Monospace text is functional, not a second display voice.

## Landing

The English narrative moves through the meeting problem and critical thinking, agent-native collaboration, Omni/Muse/Codex roles, WebMCP, shared whiteboard, one contribution workflow, privacy, and room creation. It presents implemented behavior and does not use customer claims or outcome metrics as proof.

The page uses a `min(1280px, 100%)` content width, fluid side gutters and a 76px header. On desktop, the hero places the headline and woven demonstration to the left of a 360–400px room panel. The room panel includes camera/microphone preview, display name, room creation, room-code entry, loading/errors and invite prefill.

A full-width gold announcement strip above the navigation presents the team's advancement to the top five among 30 finalist teams at the 2026 Sea x OpenAI Regional Codex Hackathon Taiwan. The result and full event name use dark text in one centered row on desktop and wrap into stacked lines on smaller screens. This recognition sits outside the hero and product narrative.

Following sections use a heading-and-content split with thin rules and generous vertical space. Agent roles are open rows, the workflow is numbered, and the whiteboard example is an illustrative SVG payment flow. **Codex draws** and **You refine** are native buttons with `aria-pressed`; changing the selection updates the diagram, accessible description and caption.

At 1080px and below, the hero and sections stack. Invite visitors see the room form before the draft. At 720px and below, section navigation links hide while About and Settings remain, gutters and draft geometry shrink, and the hero title becomes `clamp(38px, 11vw, 56px)`. About is also available in the footer.

### About

`/about` and `/about/` present the English project narrative directly from `PROJECT-NARRATIVE.md`. The page keeps the indigo, cotton and Jost visual system in a single reading column up to 72ch wide. Its document heading is 44px on desktop and 32px at widths of 640px and below; body text is 18px, or 17px at the same breakpoint, with a 1.8 line height. These About typography roles support sustained reading. The full narrative retains one H1 and all 13 paragraphs in their original order. A compact header links to Home and marks About as the current page; the footer links to the room form at `/#start` and home. Navigation uses ordinary page links, and the About route loads independently of the meeting interface.

### Draft, selvedge and mark

The hero illustration is labelled **Illustrative conversation · every voice has a thread**. Five human warps carry vertical names; each caption is a colored weft, speaker label and text. Seven picks remain visible. The plain-weave crossing alternates according to `(row + column)` parity.

A new pick arrives every 1,900ms while the tab is visible. The weft draws left to right over 900ms, rises 6px and introduces its caption on `cubic-bezier(.16,1,.3,1)`. Old rows advance out of the cloth. Reduced-motion users see a static seven-pick demonstration.

The room panel's 6px selvedge contains eight equal color columns. The mark uses four colored warps and cotton wefts on indigo, with alternating over/under crossings and a 22% corner radius. The graph-paper texture belongs to the illustrated draft, not the meeting stage.

## Meeting layout

The desktop room is a full-height shell with a 60px header and a flexible stage beside a side panel of `clamp(360px, 34vw, 560px)`. The header holds the brand, room code, caption status, elapsed meeting timer, participant count, Settings, Copy link and Leave. **Copy link** shows confirmation for 1.6 seconds.

The stage displays a responsive video grid, a shared-screen presentation with participant thumbnails, or the whiteboard with a short video strip. Local camera video is mirrored; remote cameras and shared screens are not. Speaking rings use the participant's color. Captions appear on the corresponding video tile, with interim text lighter than final text; final bubbles linger for six seconds.

Controls provide microphone, camera, screen sharing and whiteboard access. On/off, loading and disabled states remain explicit. At 980px and below, the stage and side panel stack. The normal side panel is bounded to 45vh; the active Muse panel moves above the stage and uses up to 75dvh. Header labels compress further at 640px and smaller widths.

### Room and Transcript

The side-panel tabs are **Room**, **Transcript** and **Muse**, each at least 46px high with a gold active underline. Room has a message count; Muse uses an unread-reminder dot. There is no Insights or separate Omni tab.

Room contains Omni's card above the chronological public conversation. Public messages render Markdown, and the composer explains its submission keys. Human rows use the author's thread color and a raised background; own rows receive a subtle gold tint. Agent posts use dashed borders and explicit attribution. Replayed records sort before a **YOU JOINED** divider using their original timestamps.

Transcript shows finalized attributed speech and current interim lines. Public Muse and Omni speech uses assistant labels and playback status. Private Muse dialogue and dictation drafts do not appear here.

### Files and previews

A file card combines an icon, ellipsized filename, size/status, and actions. Supported files expose **Preview**; download, retry and save use labelled icon buttons. Transfer progress shows received bytes, percentage and a progress bar. Missing/unavailable cards fade, while transfer errors have visible text.

Preview opens a native modal dialog sized to the viewport with 16px margins, becoming full-screen below 600px. The header keeps the filename, Save when bytes are present, and Close. The body handles images, PDF pages, DOCX, Markdown or plain text. Opening a supported available file begins its download; errors and retries stay in the dialog. Preview limits are 1 MiB for text/Markdown and 20 MiB for image/PDF/DOCX, separate from the 300 MiB transfer limit.

### Shared whiteboard

The board uses Excalidraw's light UI, a `#fafaf8` canvas, green controls and restrained borders. It has a minimum height of 460px and a 72px participant strip underneath. This light editing surface is an intentional part of the current application palette.

Human users can draw, select, move, label and connect native elements. Agent tools can read objects, perform structured edits, import supported Mermaid flowcharts, undo/redo and capture the board. Mermaid imports add editable objects; modifying an earlier diagram uses object edits. Screen/board captures inspect the current view; a successful mutation alone does not verify its visual result.

Image insertion, pasted files, external embeds, scene loading and theme switching are disabled. The menu retains image export, clear canvas and Help. Unsupported or oversized edits produce a visible board error and do not become accepted shared content. Board changes synchronize between connected peers and are replayed to late joiners; local viewport navigation remains personal.

## Muse

Muse is configured on join without starting private microphone capture. The tab opens directly into a private conversation with settings in the heading, a scrollable log and a rounded composer. The empty state sits near the top of the log and offers a concrete shared-work example. Indigo surfaces and gold accents follow the meeting palette. Icon controls use consistent 44px rounded-square targets; the labelled Live control is wider to keep its icon and text legible.

The composer separates three actions: **Live** at the left starts continuous private voice; microphone **Dictate** and the primary **Send** action sit at the right. Dictation fills an editable draft and shows audio level and a stop control while recording. Starting Live replaces the text input and its actions with a dedicated session bar showing **Connecting to Muse**, then **Live with Muse** and the current session status. **End** receives keyboard focus and remains available while connecting and throughout the conversation. Ending or failing the session restores the unsent draft and returns focus to the text input. Settings are unavailable during private voice capture so its stop control stays accessible. Private voice pauses the meeting microphone and captions and shows that state. A bounded response exposes **Stop response**; ongoing Live conversation remains active until ended or interrupted by an error.

Private user messages align right on raised indigo. Assistant replies use a wider, neutral text surface. A completed assistant reply reveals a 44px **Send** icon button centered at its right edge on hover or keyboard focus; the button stays visible on touch devices and other devices without hover. The tooltip identifies public speech. This action authorizes a fresh session to read exactly the selected message aloud, omitting Markdown marks but without summarizing or elaborating. It does not publish a Room message. A visible Stop control ends that public turn, and the room's public-floor limit is ten minutes. The owner's microphone stays in its existing state; owner speech cancels Muse speech with no automatic restart.

Settings replace the personal conversation inline and provide **Back to Muse**. The form covers role, name, language, public-source scope, chat/system inclusion, screen/file permissions and optional Room posting. Whiteboard edits require a direct request; Room posting also requires its setting. Saving stops current work and applies the settings while retaining conversation history. A manually added Muse uses a review step before creation.

### Private reminders

A reminder floats at the lower left of the video stage without reserving space. It avoids caption/error rectangles; when it cannot fit, the card stays hidden and its history remains available in Muse. Only one card is shown, and new reminders do not replace the card being read.

Cotton text, a lock and **Muse · Only you** identify the audience. There is no sound, autofocus or entrance animation. After 15 visible seconds the card collapses, excluding hover/focus time. Collapse, read and dismissal are separate states. Closing or viewing evidence returns keyboard focus to the Muse tab.

**Discuss privately** opens private follow-up. **Speak for me** authorizes a faithful public reading of that reminder only. **View evidence** opens its history; **Later** collapses it. Reminder history is a collapsible list with source excerpts and dismissal, and reports **Reminders unavailable · retrying** when needed. There is no analysis pause toggle or per-detector settings in this interface.

## Omni

Omni's compact persistent card sits at the top of Room. Its states distinguish waiting for discussion, reviewing, awaiting approval, approved/waiting for quiet, speaking, unavailable device and the publication limit. Preparing, awaiting approval and speaking use a steady gold border/glow; status text remains the primary cue.

A prepared question exposes **Allow Omni to speak** and the voice-approval instruction **“Omni, go ahead” / “Omni，請發言”**, which requires enabled captions. Preparation itself is silent. Approval applies only to the current question; new discussion or an expired draft invalidates it. Omni waits for quiet and an available public speaking turn before reading the approved question aloud. Its output appears in Transcript and replays as public assistant history.

**Stop** cancels current work. Settings replace the Room card inline with a scrollable form and **Back to Room**, temporarily hiding chat. Everyone may edit shared settings; the host or Omni's owner can remove it. The Add button recreates Omni with defaults after removal. An audio-enable action appears when browser audio initialization needs a participant gesture.

Omni's settings expose role, name, language and optional shared-screen/file reads. Public discussion is its fixed source; private Muse conversations are never included. It has no board controls or free-form chat composer. The four review categories are semantic rules with evidence checks, not visual meters or participant profiles.

## Accessibility and motion

Native buttons, labelled form controls, dialog semantics, visible errors and gold `:focus-visible` outlines carry interaction. Public and private audiences remain explicit in labels and transcript attribution. File previews retain keyboard dismissal; reminder popups do not steal focus. Selected landing diagram buttons expose their state to assistive technology.

The woven draft is the main illustrative motion. Live indicators, voice levels, progress and the Omni active border convey actual operational state. Reduced motion collapses looping animations, freezes the draft and gives speaking tiles a solid ring. Never add a decorative motion that suggests detection confidence or urgency the runtime does not provide.

## Content boundaries

Use the actual action and audience in copy: private reply, requested board edit, requested Room post, or approved public reading. Do not present a tool's availability as permission to act. Do not claim an unavailable file or missing transcript was inspected.

Privacy explanations distinguish encrypted participant traffic, possible TURN relay, direct AI-provider traffic, Worker processing and local text checkpoints. An ordinary browser supports the meeting and built-in assistants; external Codex tools depend on WebMCP availability.

The current app has no Insights panel, dispersion/entropy meters, Hand radar, Trace projection or persistent room-wide intervention card. The former detailed visualization proposal is not an implemented design contract. Current reminders and Omni status/approval controls are the analysis surfaces to preserve.
