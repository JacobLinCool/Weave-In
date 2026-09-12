---
version: 1
slug: "src-about-tsx"
primary_target: "src/about.tsx"
related_targets: ["PROJECT-NARRATIVE.md", "src/style.css", "src/main.tsx", "src/brand.tsx", "src/landing.tsx"]
---

# About page

Mode: Read. The existing indigo, cotton, gold and Jost identity frames the complete English project narrative. The article imports `PROJECT-NARRATIVE.md` directly and renders its one H1 and 13 paragraphs in order.

Reading layout: one centered column up to 72ch wide, with 18px body text at 1.8 line height and 24px paragraph spacing. The heading is 44px, weight 500, with 1.15 line height and -0.025em tracking. At 640px and below, the heading becomes 32px, body text becomes 17px, horizontal gutters are 20px and content padding becomes 40px vertically. The final paragraph uses cotton ink; the preceding prose uses muted cotton.

Navigation: the brand and Home link return to `/`; About is marked as the current page. Both `/about` and `/about/` resolve to this independently lazy-loaded page. Landing navigation exposes About on desktop and mobile, with another entry in its footer. After the narrative, Start a room links to `/#start` and Back to home links to `/` using ordinary anchors.

Accessibility: the article is labelled by its document heading, the header navigation has an accessible name, and links retain visible gold keyboard focus. Header navigation and the secondary footer link have 44px minimum targets; the primary footer action is at least 48px high.
