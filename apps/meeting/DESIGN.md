---
name: Weave In
description: Browser meetings drawn as a weaver's draft. Indigo cloth, undyed cotton, eight dyed threads, one gold action.
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
  chip-woven:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.tag}"
    width: "26px"
    height: "18px"
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
  card-sheet:
    backgroundColor: "rgba(27, 34, 66, 0.7)"
    rounded: "{rounded.control}"
    padding: "20px"
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
  card-intervention:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.control}"
    padding: "14px 16px"
    width: "min(560px, 100%)"
  signal-row:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.muted}"
    typography: "{typography.body-compact}"
    rounded: "{rounded.field}"
    padding: "9px 11px"
  signal-tag:
    textColor: "{colors.base}"
    typography: "{typography.notation}"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
  meter-dispersion:
    backgroundColor: "{colors.base}"
    borderColor: "{colors.line}"
    rounded: "{rounded.pill}"
    height: "6px"
  chart-hand:
    backgroundColor: "{colors.base}"
    borderColor: "{colors.line-soft}"
    rounded: "{rounded.field}"
    padding: "12px"
  chart-trace:
    backgroundColor: "{colors.stage}"
    borderColor: "{colors.line}"
    rounded: "{rounded.control}"
    padding: "0"
---

# Design System: Weave In

## Overview

**Creative North Star: "The Weaver's Draft"**

Weave In draws a meeting the way a weaver draws cloth. The page is indigo-dyed ground; the type is undyed cotton; every participant is a warp thread in one of eight dyes, every caption a weft pass laid across those threads, and the transcript is the drawdown the passes leave behind. The landing surface persuades by weaving itself live in the first viewport; the meeting room operates with the same threads, the same mark, and the same gold, on the same cloth.

The world is quiet and material. Surfaces are flat tonal steps of indigo separated by thin lines, never glass, never gradients on text. Jost at medium weight carries every headline and sentence; Azeret Mono appears only where a weaver would write in the margin (labels, codes, draft notation). One dye, weld gold, is allowed to ask for a click. The eight thread dyes are reserved for people, so a colour on this page always means who, never what.

Density is editorial on the landing (one idea per sheet, generous section rhythm, a 60–64ch measure) and tight in the room (10–13px chrome, 8–12px gaps, a full-height stage). The build refused the dark-SaaS hero with a floating screenshot, icon cards, eyebrows and kickers, gradient text, and glass surfaces.

**The draft reads the cloth.** The analysis surfaces are not a second visual language bolted onto the first: groupthink already has a name in weaving, and the metaphor carries the whole detection model without inventing a single new idea.

- **Convergence** is every pass of the shuttle taking the same dye. Cloth woven in one colour has no pattern left to read.
- **Drift** is the weave leaving its threading plan — the draft still producing cloth, but not the cloth it set out to make.
- **Float** is the weaving fault it is named after: a thread passing over many others without interlacing. Long floats make weak cloth.
- **Echo** is a pass that lays down no new dye.
- **The intervention** is the shuttle carrying undyed cotton back across. It belongs to no participant, so it wears no dye.

Every analysis surface is drawn with the vocabulary that already exists — threads, passes, dyes, the drawdown — and adds only what the data genuinely requires.

**Key Characteristics:**
- Indigo cloth ground with undyed cotton text; depth comes from three tonal steps and 1px lines, not from shadows.
- Weld gold is the only colour that asks for a click; the eight dyed threads identify participants and nothing else.
- Jost (variable) at weight 500 for display and body; Azeret Mono strictly for notation at 11–13px, tracked and uppercase.
- The draft grammar: warps, weft passes, crossings, selvedge stripe, and a 20px graph-paper module that lives only on draft sheets. The draft carries no explanatory labels: warp name tags and speaker tags are the only text on it.
- One authored motion: the draft advancing one pick every 1.9s on an expo-out curve; everything else is a 120–140ms state change.

## Colors

Indigo cloth under undyed cotton, with eight dyed threads for people and one gold for action.

### Primary
- **Weld Gold** (#e9b44c, `--accent`): the single action colour. Primary buttons, the chat send button, the 2px focus ring (offset 3px), text caret and selection, the active side-panel tab underline, the switch when on, the selected segmented option, the selected language card (border plus 12% tint), and the nav link hover underline. It is also thread 2 in the dyed set, so the participant seated third wears the action colour as identity.
- **Weld Hover** (#f2c46a): primary button hover only. (The stylesheet also names it, and Weld Gold, as default author-name colours on chat and transcript rows, but every rendered author name carries an inline thread colour, so those rules never paint.)
- **Weld Ink** (#1a1408): text on gold, and the switch knob when on.

### Secondary
- **The Dyed Threads**, one per seat, in seat order: **Peach** (#f4a27e, seat 0, always you), **Madder** (#e0563f), **Weld** (#e9b44c), **Verdigris** (#5fc7a2), **Woad** (#7fb3e6), **Lilac** (#b79be8), **Moss** (#9bbf5a), **Rose** (#e98bb4). Peers take the next dye in join order; the ninth wraps to seat 1. Seats reset when you leave. A thread colour sets `--thread` and `--thread-rgb` on a video tile (avatar initial, speaking ring), colours the author name on chat and transcript rows, paints the warps, wefts, and name tags of the landing draft, the eight-column selvedge stripe, and the four warps of the mark (madder, weld, verdigris, peach).

### Tertiary
- **Coral** (#ff806d): off and danger, nowhere else. Mic off, camera off, the Leave button, the muted-mic glyph on a tile, and error notices (border and 7% tint; error text lightens to #ffc1b6).
- **Verdigris** (#5fc7a2, `--mint`) as a state: "live". Caption status while starting or transcribing, the active Share screen button, and the invite note.
- **Mint Pale** (#97e9c6): the alpha base for every verdigris state tint (7–8% fill, 30–35% border, the 42% pulse ring). It is a paler dye than verdigris itself; the build uses both.

### Neutral
- **Indigo Cloth** (#141a33, `--base`): page ground, header, input wells, the mark's field.
- **Indigo Panel** (#1b2242, `--panel`): the room panel, side panel, dialog, icon and transport buttons, caption-status pill. Draft sheets use the same indigo at 70% so the graph paper shows through.
- **Indigo Raised** (#232b52, `--raised`): secondary buttons, chat and transcript rows, language cards, the tab count badge, and every hover fill.
- **Stage** (#10142a): the meeting stage behind tiles and the preview well's outer edge (the preview frame and presentation letterbox sit a hair deeper still).
- **Line** (#303a6b) and **Line Soft** (#262f5a): 1px borders. Line on controls, panels, and sheets; Line Soft on section rules, list dividers, tile edges, and the composer top. The scrollbar is Line on transparent.
- **Cotton** (#f3eee3, `--ink`, aliased `--cotton`): all primary text, the mark's weft passes, and the draft's graph paper at 6% alpha.
- **Cotton Muted** (#c9c4b8): ledes, body prose, nav links, field labels, room chrome text.
- **Cotton Dim** (#9a968c): placeholders, footers, empty states, dividers' captions, hover borders on secondary controls.
- **Cotton Interim** (#cfcabf): captions still being spoken (interim text).

### Named Rules
**The One Dye Rule.** Weld gold means act, or yours. It asks for a click (buttons, focus ring, selection, toggles on, active tab) and tints what you yourself said (own chat rows at 12%, own transcript rows at 8%). It never decorates a heading, an icon, or a section.

**The Dyed Thread Rule.** A thread colour means one participant and nothing else. Seat 0 is you (peach); peers take madder, weld, verdigris, woad, lilac, moss, rose in join order. A thread colour never labels a feature, a status, or a section.

**The Coral Rule.** Coral is only ever off or wrong: muted, camera off, leave, error — and now the cloth going wrong: a fired signal and its severity. Verdigris is only ever live: captions running, screen shared, invited, and the discussion measured as sound (dispersion and entropy above threshold). Neither is an accent, and neither is ever applied to a person — a signal colours the moment, never the participant who spoke in it.

**The Undyed Rule.** The assistant has no dye. Every surface that speaks for the room rather than for a person — the intervention card, signal rows, the analysis meters' labels — is drawn in undyed cotton on indigo, with a 1px Cotton border at 22% where a boundary is needed. It never takes a thread colour, because it is not a participant, and it never takes weld gold, because it is not an action the visitor must perform. The one exception is the card's own dismiss control, which is an action and therefore gold. This rule is why the intervention reads as the cloth speaking and not as a ninth person joining the meeting.

## Typography

**Display Font:** Jost Variable (with Jost, Helvetica Neue, Arial, sans-serif), self-hosted via @fontsource-variable.
**Body Font:** Jost Variable (same stack).
**Label/Mono Font:** Azeret Mono Variable (with Azeret Mono, ui-monospace, monospace), self-hosted.

**Character:** A geometric grotesk at medium weight that reads like a poster set in one voice, with a monospace only where a weaver would write in the margin. `font-synthesis: none` is set at the root so nothing is faked.

### Hierarchy
- **Display** (500, clamp(50px, 6.2vw, 92px), 0.96, -0.035em): the hero title only, two lines, balanced. Drops to clamp(38px, 11vw, 56px) with the line break removed below 720px. The video-tile avatar initial borrows the display voice at clamp(48px, 7vw, 104px), -0.04em.
- **Headline** (500, clamp(30px, 3.4vw, 46px), 1.05, -0.025em): section heads on every sheet. The closing "Ready when you are." steps up to clamp(36px, 4.6vw, 64px), line-height 1, -0.03em.
- **Title** (500, 20px, -0.01em): the room panel heading. List heads (voices) sit at 18px and key terms at 17px, both 500. The settings dialog title is the one heavier title: 18px at 720, -0.02em.
- **Lede** (400, clamp(16px, 1.25vw, 19px), 1.6): the hero lede at a 62ch measure. Sheet intros are 16px at 40ch.
- **Body** (400, 15.5px, 1.65): landing prose (key definitions, voices list) at 60–62ch; the spec table cells run 16px, 1.6, at 64ch. Draft notes inside a pick are 14.5px at 1.25, clamped to two lines.
- **Body Compact** (400, 13px, 1.45): room chat and transcript rows, inputs (at 520), settings copy (12px, 1.5). Live captions on the stage are 590 at clamp(14px, 1.35vw, 19px); tile captions are 580 at 13px.
- **Button** (730, inherits 1rem): primary and secondary buttons. Tabs are 11px at 700, tracked 0.04em, uppercase.
- **Chrome** (640–700, 10px): room-header buttons, transport buttons, the caption-status pill, and the people count, all in Jost, none uppercase.
- **Notation** (500, 11px, 0.1em, uppercase, Azeret Mono): the "Room" data label, spec row heads (0.12em), field labels (0.06em), the or-divider (0.09em), the stage footnote (0.075em). Warp name tags run vertical at 600, 0.04em; pick speaker tags are 600 at 0.06em.
- **Code** (520, 13px, 0.18em, uppercase, Azeret Mono): the room-code input. The room code in the header is 600 at 0.13em; the code inside an invite note keeps Jost with 0.12em tracking and tabular figures.

### Named Rules
**The Notation Rule.** Azeret Mono is for what a weaver writes in the margin: labels, codes, and draft notation, always 11–13px, tracked, uppercase. Never a heading, never a sentence, never a button. Counts (people, tab badges) and timestamps stay in Jost with tabular figures.

**The Medium Weight Rule.** Display, headlines, and titles sit at 500 and never bolder. Weight rises only as size falls: 590 for captions, 660–700 for 10–11px chrome, 730 for buttons.

## Layout

The landing is a single column of sheets inside a `min(1280px, 100%)` container with a fluid gutter of clamp(20px, 5vw, 72px) (16px below 720px). The header is 76px tall with a Line Soft rule beneath it.

**The hero** is a two-column grid: `minmax(0, 1.45fr)` for copy and draft, `minmax(360px, 400px)` for the room panel, with a column gap of clamp(32px, 5vw, 72px) and a 34px row gap. The copy is row 1, the draft row 2, and the room panel spans both rows, sticky at `top: 24px`. Top padding is clamp(40px, 6vh, 72px).

**Sheets** (data key, voices, spec) are a two-column grid of `minmax(0, .8fr)` head beside `minmax(0, 1.4fr)` content, gap clamp(28px, 5vw, 80px), vertical padding clamp(64px, 9vh, 112px), each opened by a Line Soft rule. Inside a sheet, rows are separated by Line Soft rules with 16–22px of vertical padding and the first row loses its rule. The key's term column is `minmax(180px, .5fr)`; the spec's row head is 130px. The voices sheet holds a sticky swatch (200px column, `top: 100px`). The close is centred with clamp(72px, 12vh, 140px) of padding; the footer is 72px.

**Spacing rhythm** is a 4px base: 4 (thread gaps), 8 (control gaps, warp gap), 12 (icon gaps, composer padding), 16 (panel gaps), 20 (sheet padding, key gaps), 24 (dialog padding, hero sticky offset). Hero rows use 34px; the 20px graph-paper module on draft sheets is the same 20 as sheet padding, so the grid meets the frame edge.

**Draft geometry.** Warps are 12px wide with an 8px gap (five warps = 92px); each pick row is 40px tall; the cloth shows seven picks plus a 40px top margin (320px). The swatch uses 32px warps with 8px gaps, 16px weft rows, and 4px row gaps.

**Breakpoints (landing):**
- **≤1080px:** the hero stacks (copy, draft, room panel), the panel loses its sticky position and is capped at 560px; sheets and the voices grid go single column with 24px gaps; the swatch is hidden. When the visitor arrives by invite link (`?room=CODE`), the room panel moves above the draft (row 2) so the join form is the first thing after the lede.
- **≤720px:** nav links hide (Settings stays), hero top padding 32px and row gap 26px, the display drops to clamp(38px, 11vw, 56px), pick notes shrink to 13px, key rows stack, spec row heads narrow to 92px, and the footer stacks.

**The room** is a full-height shell (`100dvh`, overflow hidden): a 60px header, then a stage beside a 340px side panel with a Line border between them. The stage has 16px/17px/11px padding and a tile grid with 20px gaps: 2 columns by default, 1 for a single tile (max 1200px, centred), the first tile spans two rows at 3 and 5, 3 columns at 5–6, 4 columns at 7–8 (160px min rows). A presentation replaces the grid with a `minmax(0,1fr) auto` stack: the screen on top and a 132px strip of 208×124px tiles beneath. Transport controls sit in a 67px bar; a 20px notation footnote closes the stage.

**Breakpoints (room):**
- **≤980px:** the shell scrolls, the side panel drops below the stage (max 45vh, border on top), the presentation strip shrinks to 104px with 160×96px tiles.
- **≤640px:** one tile column (220px rows), the brand word, people count, and button labels hide, live captions pin to the viewport bottom above the controls, the stage footnote hides, dialog padding drops to 16px and its footer stacks.
- **≤420px / ≤360px:** header gaps tighten to 7px; the brand hides entirely at 360px.

### Named Rules
**The Sheet Rule.** Graph paper belongs on the draft, not the page. The 20px module (Cotton at 6% alpha, 1px lines, `linear-gradient` in both axes) is painted only on `.draft` and `.swatch`; the page ground stays plain indigo.

**The Invited Reorder Rule.** On an invite link the join form outranks the demonstration. Below 1080px the room panel moves above the draft; above it the panel is already sticky beside the copy.

## Elevation & Depth

This is a flat, tonal system. Depth is three steps of indigo (base, panel, raised) and 1px lines (Line, Line Soft); hover raises a surface one tonal step, never lifts it. Only two surfaces float: the room panel and the settings dialog, each with a single large, soft, ambient shadow. The weft pass on the draft carries a 2px thread shadow so the cloth reads as cloth. The speaking ring on a tile is drawn with `box-shadow` as a ring, not a shadow. Backdrop blur exists only on the two full-screen scrims (dialog backdrop and leaving overlay), never on a card or panel.

### Shadow Vocabulary
- **Room panel** (`box-shadow: 0 30px 80px rgba(0,0,0,.35)`): the sticky pattern card in the hero.
- **Dialog** (`box-shadow: 0 32px 100px rgba(0,0,0,.45)`): the settings dialog over its 74% scrim (`rgba(8,10,24,.74)`, blur 6px).
- **Weft pass** (`box-shadow: 0 2px 6px rgba(0,0,0,.25)`): each caption's thread as it crosses the warps.
- **Speaking ring** (`box-shadow: 0 0 0 <1.5–4px> rgba(thread,.42–.92), 0 0 0 <3.5–10px> rgba(thread,.08–.30)`): a two-step ring in the tile's thread colour, its width and alpha driven live by voice level; fades in and out over 120ms.
- **Leaving overlay** (`rgba(12,15,32,.86)`, blur 8px): the full-screen scrim while local media is released.

### Named Rules
**The Flat Cloth Rule.** Surfaces are flat at rest and flat on hover; hover changes fill (panel to raised) or border (line to dim), never elevation. A new floating surface needs a reason as strong as "the visitor must act here" (the room panel) or "the page is interrupted" (the dialog).

## Shapes

Corners are soft and stepped by role. Threads and their crossings are 3px; speaker tags and woven chips 4px; the segmented control's inner buttons 8px; inputs, icon buttons, language cards, message rows, and tile captions 10px; buttons, transport controls, draft sheets, the preview frame, and live captions 12px; the room panel and video tiles 14px; the dialog 16px. Status pills, tab count badges, and the switch are full pills (999px). The weave mark rounds at 22% of its size (14 on a 64 grid).

Borders are 1px, Line on interactive and framed surfaces, Line Soft on rules. The interim transcript row uses a dashed Line border for text not yet final. The "Our server" chip is filled because automatic analysis sends transcript text through the server. The draft's caption is separated by a dashed Line rule.

The recurring silhouette is the plain weave: vertical warps, horizontal wefts, and the warp rising over the weft on alternate crossings (`(row + column) % 2 === 0`). It appears at four scales: the favicon and mark (4×4 on a 64 grid), the woven chip (4px stripes), the swatch (3 warps × 8 wefts), and the live draft (5 warps × 7 picks). The selvedge is eight equal columns of thread colour, 6px tall, flush to the top edge of the room panel. Warps fade in from transparent over their first 30px and out over their last 4px.

## Components

Controls are quiet, square-shouldered, and flat; state is told by colour, not by motion. Every focusable element shares one focus ring: 2px Weld Gold, offset 3px. Disabled controls fade to 55% with a wait cursor.

### Buttons
- **Shape:** softly rounded (12px), no border on primary, 1px Line on secondary.
- **Primary:** Weld Gold fill, Weld Ink text, 730 weight, 43px min-height, 0 18px padding, 9px icon gap, 24px top margin in forms. The large variant (room panel "Create a room", the closing CTA) is 51px tall and full width (min-width 220px when inline). The join variant is 48px with no top margin. While connecting, a spinning loader replaces the leading icon.
- **Hover / Focus:** fill lightens to Weld Hover; focus draws the shared gold ring.
- **Secondary:** Indigo Raised fill, 1px Line border, 48px min-height, 0 20px padding; hover turns the border Cotton Dim. The wide variant is full width.
- **Icon button** (room header, landing Settings): 36px square, Indigo Panel fill, 1px Line, 10px radius; hover fills Raised. The wide variant adds 0 12px padding and a 10px/670 label (13px, 40px tall on the landing header). The danger variant (Leave) is Coral text.
- **Transport button** (room stage): 39px tall, 105px min-width, Panel fill, Line border, Cotton Muted 10px/650 label with a 20px icon; hover to Ink on Raised; off state Coral text and a 30% Coral border; active state (screen shared) Verdigris text with a Mint Pale 35% border and 8% fill; disabled uses a not-allowed cursor.
- **Preview toggle** (mic/camera in the preview frame): 42px square, near-opaque indigo (`rgba(20,26,51,.92)`), a 20% Cotton border, 12px radius; off state Coral with a 38% Coral border.
- **Chat send:** 42px square, Weld Gold fill, 10px radius; disabled at 40%.

### Chips
- **Woven chip** (data key terms): 26×18px, 4px radius, two 4px-stripe `repeating-linear-gradient` layers (colour A vertical, colour B horizontal) over Indigo Raised, so the two named parties read as woven. The empty variant is transparent with a dashed Cotton Dim border for the path that carries nothing.
- **Speaker tag** (draft pick, warp name): 11px Azeret Mono, 600, uppercase, Indigo Cloth text on the speaker's thread fill, 1px 6px padding, 4px radius (warp names run vertical with 3px radius).
- **Caption-status pill** (room header): 32px pill, Panel fill, Line border, 10px/670 text with a 6px current-colour dot; live state Verdigris text with a Mint Pale border and tint and a 1.7s pulsing dot; error state Coral.
- **Count badge** (tabs): 10px on Raised, pill, 1px 6px padding.

### Cards / Containers
- **Room panel:** 14px radius, Indigo Panel, 1px Line, 18px 18px 20px padding, the selvedge stripe at the top edge, and the room-panel shadow; sticky in the hero, overflow hidden.
- **Draft sheet and swatch:** 12px radius, Indigo Panel at 70% over the 20px graph paper, 1px Line, 20px padding (16px bottom on the draft).
- **Dialog:** 16px radius, Indigo Panel, 1px Line, 20px 24px 22px padding, `min(100%, 580px)` wide, dialog shadow, sections divided by Line Soft rules with 16px padding.
- **Side panel:** 340px, Indigo Panel, Line border on the stage side; list items are Raised rows with 10px radius and 9px 11px padding.
- **Video tile:** 14px radius, 1px Line Soft, a radial indigo field (`#2a3462` to `#161c3a`) behind the avatar initial in thread colour, a 35% bottom shade, meta at 11px/660 in white, and a caption bubble (10px radius, `rgba(20,26,51,.9)`, 13px/580, clamped to 4.3em, 6s linger after a final line). The shell carries the thread variables and the speaking ring. Presentation tiles letterbox (`object-fit: contain`) on a near-black field; the local tile mirrors.

### Inputs / Fields
- **Style:** 1px Line stroke on Indigo Cloth, 10px radius, 44px min-height, 0 12px padding, 13px Jost at 520, Cotton Dim placeholder, gold caret. The field label above is 11px Azeret Mono, 500, 0.06em, uppercase, Cotton Muted, with a 7px gap.
- **Code input:** the same well at 48px, in Azeret Mono at 0.18em tracking, uppercase, placeholder "ABC123", paired in a `1fr auto` join row with an 8px gap.
- **Focus:** the shared 2px gold ring at 3px offset; no glow.
- **Error:** the error notice, not the field: Coral 25% border, 7% Coral fill, #ffc1b6 text, 11px, with a 16px alert icon, 12px top margin. On the stage it is centred at `min(680px, 100%)`.
- **Switch:** 42×24px pill, Line track, Cotton knob; on is Weld Gold with a Weld Ink knob, 140ms.
- **Segmented control:** Indigo Cloth track with 3px padding and a Line border, 10px radius; options 32px tall, 12px/700, 8px radius; the checked option is Weld Gold with Weld Ink text.
- **Language card:** Raised, 1px Line, 10px radius, 9px 11px padding, native name at 660 over an 11px muted label; selected is a gold border with 12% gold fill; disabled fades to 45%.
- **Chat composer:** `1fr auto` grid, 12px padding, Line Soft top rule, 42px input.

### Chat entries (files and agents)

- **File card** (`.file-card`): a `panel` container inside the chat message, `grid: auto minmax(0,1fr) auto`, 9px×10px padding, 8px radius, `line-soft` border. Icon by MIME family in `muted`, turning `weld` once the bytes are in this browser (`is-ready`, `is-downloading`). Name in body 12px/640 ellipsised on one line; size and state on one notation line (`dim`; `coral` when `is-error`). The only action is a text button in weld outline (`.file-card__action`: 30px high, 8px radius, 11px/700) reading **Download**, **Save**, or **Retry**; a 3px weld progress bar sits under the meta while a transfer runs. `is-unavailable` and `is-missing` fade the card to 60%.
- **Agent message** (`.chat-message.is-agent`): the sender's own thread colour stays on the name, but the bubble loses its fill and takes a 1px dashed `line` border (weld at 42% when it is your own agent), a `Bot` glyph precedes "<name>'s agent" / "Your agent", and the assistant's name sits in a notation chip (`.chat-agent-tag`: 9px, .08em, uppercase, 999px). The dashed edge is the whole tell: typed words are solid, an agent's words are stitched on.
- **Join rule** (`.panel-divider`): one notation line, "YOU JOINED · 04:50", `dim` at 10px/.09em with a hairline of `line-soft` on either side, placed between what was replayed from before this participant arrived and what they witnessed. Entries before it carry `data-before-join` and sort ahead with flex `order`, so replays land in time order without re-keying the list.
- **Drop overlay** (`.drop-overlay`): covers the chat panel at 8px inset with a 2px dashed weld border, 12px radius, indigo at 94%, paperclip glyph in weld, "Drop to share with everyone" 14px/700 and the size limit in `muted` 11px. Pointer events pass through so the drop lands on the panel.

### Navigation
- **Landing header:** 76px, brand (30px mark plus "Weave In" at 17px/600, -0.01em, 11px gap) on the left; on the right, three in-page links at 14px/500 in Cotton Muted with 22px gaps, hover to Cotton with a gold underline at 5px offset, then the wide Settings icon button. Links hide at 720px; Settings stays.
- **Room header:** 60px, compact brand (24px mark, 15px word), a Line-ruled identity block ("Room" data label over the mono code), the caption-status pill, then people count, Settings, Copy link (swaps to a check and "Link copied" for 1.6s), and Leave in Coral. Labels and the count collapse at 640px; the brand hides at 360px.
- **Side-panel tabs:** meeting tabs for Room, Transcript and Muse (the proposed Insights surface is not implemented), 11px/700 uppercase at 0.04em with a 15px icon, Cotton Muted; the active tab is Cotton with a 2px Weld Gold bottom border. The public message tab retains its count badge; personal Muse uses a dot for unread reminders. The future Insights panel would have its own signal count.
- **Footer:** 72px, compact brand and a Cotton Dim 13px line, stacking at 720px.

### The Draft (signature)
The live demonstration in the hero. Five warps hang in thread colour with vertical mono name tags, and picks arrive as rows: a 12px weft in the speaker's thread colour crossing all five warps (extending 4px past them), with the warp rising over the weft on alternate crossings, and beside it the speaker tag and caption text.

**Motion (the one authored moment):** a new pick arrives every 1,900ms while the tab is visible. The weft draws in left to right over 900ms (`clip-path`), the row rises 6px into place over 900ms, and the note slides in from the left over 700ms after a 250ms delay, all on `cubic-bezier(.16,1,.3,1)`. Once seven picks are shown, the list advances: it translates up one pick height (40px) over 600ms on the same curve while the oldest row fades over 360ms, then the row is dropped. Under `prefers-reduced-motion: reduce` the draft renders seven picks statically and never advances, all animations collapse to 0.01ms and one iteration, and the speaking ring becomes a solid 3px ring at 90%.

### The Selvedge and the Mark (signature)
The selvedge is the eight thread colours as equal columns in a 6px stripe along the top edge of the room panel: the whole set of possible seats, before anyone has sat down. The mark is the favicon drawn in the page: an indigo tile rounded at 22%, four warps (madder, weld, verdigris, peach) under four cotton wefts, warp over weft on alternate crossings. It is 30px in the header, 24px compact, 44px at the close.

## The Insight Surfaces (future proposal)

These visualizations and intervention-card rules describe a future room-wide analysis layer. They are not implemented and do not govern the current Muse reminder or Omni interfaces described below. In particular, the older persistent intervention-card proposal does not override the current 15-second private popup.

The analysis layer. Four surfaces, all governed by The Undyed Rule: the room speaks in undyed cotton, participants keep their dyes, and a signal colours a moment rather than a person. Specified against `GROUPTHINK.md`; nothing here renders a measure that file does not define.

### The Insights panel

A third side-panel tab beside Chat and Transcript, with the same 46px height, 11px/700 uppercase label, 15px icon, and gold active underline. It carries a count badge only when signals are unread.

Top of the panel is the **state block**: two meters, dispersion and participation entropy, each a 6px pill track on Indigo Cloth with a 1px Line border and a fill that runs Verdigris while the measure is healthy and Coral once it crosses threshold. Each has an 11px Azeret Mono label and a Jost tabular-figure value. A threshold tick sits on the track as a 1px Cotton line at 40% — the number means nothing without the line it is being compared to.

Below it, the **signal log**: Raised rows at 10px radius, 9px 11px padding, newest last, matching the chat and transcript rows exactly. Each row is a signal tag, a timestamp in Jost tabular figures, and one line of evidence in Cotton Muted. The tag is 11px Azeret Mono, uppercase, Indigo Cloth text on a Coral fill whose alpha carries severity (45% / 70% / 100% for the three bands) — the tag is the only place severity is encoded as colour.

During warm-up the panel says what it is waiting for in Cotton Dim at 13px. It never renders an empty chart or a zeroed meter; a measure that is not yet meaningful is not drawn.

### The intervention card

The product thesis made visible, and the one surface allowed to interrupt the stage.

It sits centred above the transport controls at `min(560px, 100%)`, on Indigo Panel with a 1px Cotton border at 22%, 12px radius, 14px 16px padding, and the room-panel shadow — it is the third floating surface in the system and it earns that by the same test as the dialog: the meeting is being interrupted. A 3px undyed cotton bar runs the full left edge, the shuttle's thread crossing the card.

Head: the signal tag, then the intervention kind in 11px Azeret Mono Cotton Muted. Body: the generated question in Jost 15.5px/1.5 Cotton, capped at two sentences by generation, clamped to three lines by the UI. Foot: an evidence link in 11px Cotton Dim that scrolls the transcript panel to the cited utterances, and a gold dismiss control — the one gold thing on the card, because dismissing is an action.

**Motion.** The card draws in the way a weft pass does: `clip-path` left to right over 900ms with a 6px rise, on `cubic-bezier(.16,1,.3,1)`, the same authored curve as the draft. It never slides, fades in place, or bounces. It persists until dismissed or until the next intervention replaces it — an intervention that disappears on a timer is an intervention nobody read. Under `prefers-reduced-motion: reduce` it appears at full opacity with no draw.

Never more than one card on the stage. `GROUPTHINK.md` caps interventions at five per meeting with a two-minute cooldown; if the design ever needs a stack, the policy is wrong, not the layout.

### The Hand (signature)

Each participant's communication profile: a six-axis radar — airtime, initiative, challenge, inquiry, echo, influence — drawn in their thread colour, one per participant in the Insights panel.

The web is 1px Line Soft at three rings; axis labels are 10px Azeret Mono uppercase in Cotton Dim, set outside the web. The polygon is the participant's thread colour at 18% fill with a 1.5px stroke at full strength, and a 3px vertex dot on each axis. Nothing else is coloured: this is the Dyed Thread Rule working exactly as intended, because a Hand *is* a person and is the one analysis surface that should carry a dye.

At rest the card is 12px radius on Indigo Cloth with a 1px Line Soft border and 12px padding, name above in 13px/600 in the thread colour. Hovering a video tile raises that participant's Hand one tonal step; the two are the same identity seen twice.

The polygon animates between states over 400ms on the shared curve. It is never drawn before `MIN_UTTERANCES` — a radar built from four sentences is a lie told confidently.

**Copy constraint.** The Hand is labelled as a description of this meeting, in Cotton Dim beneath the set. It is not a personality result and the UI must not let a viewer read it as one.

### The Trace (signature)

The discussion's path through semantic space: the drawdown of the whole meeting in one figure.

A near-black Stage field at 12px radius with a 1px Line border, full panel width. Each utterance is a 4px dot in the speaker's thread colour, positioned by the incremental PCA projection from `ARCHITECTURE.md`; consecutive utterances are joined by a 1px polyline in Cotton at 18%, so the path is undyed and only the moments carry dye. The most recent dot is 6px with a 2px ring in its thread colour, and the anchor is a 10px undyed cotton ring at 40% — the point the discussion set out from.

Convergence is legible without a label: the dots crowd. Drift is legible: the path walks away from the anchor ring. This is the whole argument for the surface — the abstract psychology claim becomes a shape a judge can read in two seconds, with no number to take on trust.

When a signal is active, the window it fired on is enclosed by a 1px Coral hull at 35%. That is the only Coral on the figure and the only decoration permitted anywhere on it: no grid, no axes, no tick labels. The axes of a PCA projection have no meaning a viewer could use, and drawing them would imply one.

New dots arrive with a 300ms fade and a 1px→4px scale; the polyline extends over the same 300ms. Rotation, parallax, auto-orbit, and depth fog are all forbidden — the figure is read, not admired.

### Named Rules

**The Undyed Path Rule.** In every analysis figure, dye marks *who spoke* and undyed cotton marks *the discussion itself*. The Trace's polyline, the intervention card's edge, and the meters' threshold ticks are cotton because they belong to the room. Dots, polygons, and names are dyed because they belong to people. A figure that colours the path has claimed the conversation belongs to someone.

**The Threshold Rule.** A measure is never drawn without the threshold it is judged against. Every meter carries its tick, every signal carries its evidence, and no number appears alone. The product's credibility rests on a viewer being able to see why something fired, and a bare number gives them nothing to check.

**The Quiet Instrument Rule.** Analysis surfaces do not animate to attract attention. One authored motion already exists in this system — the weft pass — and the intervention card borrows it because an intervention is a pass. Everything else in this layer is a 120–400ms state change. No pulsing, no attention-seeking loops, no counters ticking up. An instrument that performs is an instrument that gets ignored.

## Do's and Don'ts

### Do:
- **Do** set every action in Weld Gold and nothing else: primary buttons, send, focus ring (2px, offset 3px), selection, caret, toggles on, active tab.
- **Do** give every participant a thread colour by seat (you are peach; peers take madder, weld, verdigris, woad, lilac, moss, rose in join order) and use it for their avatar, speaking ring, name, warp, and weft.
- **Do** set headlines and titles in Jost at 500 with negative tracking (-0.035em display, -0.025em headline, -0.01em title) and balance the wrap.
- **Do** write labels, codes, and draft notation in Azeret Mono at 11–13px, uppercase, tracked 0.06–0.18em, in Cotton Muted.
- **Do** build depth from tonal steps (Cloth, Panel, Raised) and 1px Line or Line Soft rules; hover moves one step up.
- **Do** paint the 20px graph paper on draft sheets (the draft, the swatch) at Cotton 6% alpha, and frame them at 12px with a 1px Line.
- **Do** ease every authored movement on `cubic-bezier(.16,1,.3,1)` and keep state changes at 120–140ms.
- **Do** honour `prefers-reduced-motion`: render the draft's seven picks statically, collapse animations, and show the speaking ring as a solid 3px line.
- **Do** keep the plain-weave silhouette exact: warp over weft where `(row + column)` is even.
- **Do** use Coral only for off and wrong, and Verdigris (with the Mint Pale tint) only for live.
- **Do** draw everything that speaks for the room — the intervention card, the Trace's path, threshold ticks — in undyed cotton, and keep dye for people.
- **Do** show the threshold beside every measure, and the evidence beside every signal.
- **Do** keep current private reminders silent and allow their 15-second collapse; the persistent animated intervention card belongs only to the future Insights proposal.
- **Do** hold every analysis surface back until it has enough data to be true, and say what it is waiting for in Cotton Dim.

### Don't:
- **Don't** add eyebrows or kickers above headings; a sheet head is a headline and one intro line.
- **Don't** build icon cards or feature grids; the data key uses woven chips and the voices sheet is a ruled list.
- **Don't** put gradients on text, or use gradients anywhere except the warp fade, the tile field, the preview well, and the tile shade.
- **Don't** make glass: no `backdrop-filter` on cards or panels (it exists only on the two full-screen scrims), and no translucent surfaces below 90% opacity except the 70% draft sheet over its graph paper.
- **Don't** use a thread colour for a feature, a status, or decoration, and don't use gold as a participant colour on purpose (seat 2 wears it because it is a dye; that is the only overlap).
- **Don't** set Azeret Mono in a heading, a sentence, a button, a count, or a timestamp.
- **Don't** add drop shadows to controls, chips, tiles, or sheets; only the room panel and the dialog float.
- **Don't** put the graph paper on the page ground, the room, or any surface that is not a draft sheet.
- **Don't** raise headline weight above 500 or invent a second display face.
- **Don't** fabricate proof: no testimonials, customers, metrics, or screenshots as hero art; the draft is the demonstration and is labelled synthetic.
- **Don't** present assistants as additional human participants. Label the personal assistant Muse, shared public suggestions Omni, and approved personal speech as the owner’s Muse.
- **Don't** colour a person by a signal. Coral marks the moment the discussion went wrong, never the speaker who was in it.
- **Don't** add a charting library, axes, gridlines, or tick labels to the Trace; a PCA axis has no meaning a viewer can use and drawing one implies it does.
- **Don't** rotate, orbit, parallax, or fog the Trace, and don't pulse, tick, or loop any analysis surface; the instrument is read, not admired.
- **Don't** render a Hand, a meter, or a Trace before the data supports it, and don't stack intervention cards — if a stack is needed the intervention policy is wrong, not the layout.
- **Don't** state a measure as a verdict about a person; the Hand describes one meeting and must be labelled as doing so.

## Muse reminders and Omni (implemented)

Private reminders use an absolutely positioned card at the lower left of the video stage, above controls. No empty reminder card appears and no stage space is reserved. The card avoids caption/error rectangles; if it cannot fit it remains available in Muse rather than covering them. One card appears at a time, remains stable while being read, and collapses after 15 seconds excluding hover/focus time. Collapse is distinct from dismissal and read status. The Muse tab shows an unread dot and combines reminder history, evidence, visibility and monitoring controls with private assistant discussion. Cotton text, a lock, and “Muse · Only you” identify the card; no sound, autofocus, or entrance animation. Keyboard activation returns focus to the Muse tab when closing or viewing evidence.

Muse is configured for each participant on join, without starting a spoken session. Reminder actions offer **Discuss privately** and **Speak for me**; closing or timing out never grants permission. The latter approves only the displayed reminder for one public turn, with slight elaboration capped around 20 seconds and no new commitments. The owner's microphone stays in its existing state; owner speech interrupts Muse with no automatic resume. Shared transcript labels identify whose Muse spoke.

Omni publishes suggestions of at most 240 characters in shared Room chat, labelled Omni. Omni occupies a compact control row within Room; setup and settings open scrollable modal dialogs. Creation stays pending until room acknowledgement, and errors retain the form. There is no separate Omni tab. There is no audio, public-audience toggle, or permission popup for Omni. It uses public meeting context and does not expose individual Muse histories.

Same-tab room recovery includes up to 200 private Muse lines alongside reminder history. Refresh/rejoin restores text and reminder state, never an active spoken turn or its approval. Public Omni suggestions restore/replay as shared messages, not private reminders.
