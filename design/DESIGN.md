---
version: "1.0"
name: "zs-business dashboard"
description: "Premium black owner dashboard: near-black surfaces, white for actions, one electric-blue pop for good news, Google Sans, hairline cards and short spring motion on navigation only."
provenance: "Redesign of apps/dashboard, 2026-10-20. Tokens live in apps/dashboard/src/styles/theme.css; this file records them and the reasons. Ported MIT components are listed in NOTICE."
colors:
  bg: "#0a0a0a"
  surface: "#131313"
  surface-warm: "#1c1c1c"
  fg: "#f5f5f4"
  fg-2: "#d6d6d3"
  muted: "#a6a6a2"
  meta: "#8e8e8a"
  border: "#262626"
  border-soft: "#1d1d1d"
  border-strong: "#6e6e6b"
  primary: "#f5f5f4"
  accent: "#f5f5f4"
  accent-on: "#0a0a0a"
  accent-hover: "#e2e2df"
  accent-active: "#cfcfcb"
  success: "#6f93ff"
  warn: "#f2b84b"
  danger: "#ff6b5f"
typography:
  page-title:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 600
    lineHeight: 40px
    letterSpacing: "-0.022em"
  kpi-value:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 600
    lineHeight: 36px
  card-title:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 500
    lineHeight: 24px
  body:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  ui:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
  meta:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  section-label:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: "0.08em"
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  pill: 9999px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "12": 48px
---

# zs-business dashboard

## Overview

The owner opens this on a phone between appointments and on a laptop at the end of the day.
The screen has one job: show what needs the owner now and let them act on it. The look is
quiet so the business's own data carries the colour. The brief and before/after evidence are
in `design/BRIEF.md` and `design/evidence/`.

## Colors

Black, set by the owner on 2026-10-20 ("black, premium, high-class, a little fun"; no green,
no warm paper). Near-black `bg` with slightly lifted `surface` cards and hairline white
borders. Primary actions, the current place and the brand mark are white (`accent`), so the
screen reads monochrome. The one pop of colour is `success`, electric blue #6f93ff, kept for
good news only: up trends, connected services, the live dot. `warn` and `danger` are status
only. Every text pair meets WCAG AA; `meta` (#8e8e8a on #131313) is the lowest-contrast text.
Black is the only theme; the app no longer follows the system light setting. A violet pop
(#a58bff) was rendered as the alternative.

## Typography

Google Sans for everything, self-hosted by `next/font` (no request to Google at run time). The
offline service worker keeps pages, scripts and styles but not fonts, so a cold offline open
shows the system font, which is what the dashboard used before this redesign.
Page titles and KPI values are 28px on a phone and 36px from `sm` up (titles from `lg`), with
-0.022em tracking on titles. Numbers use
tabular figures (`tabular` utility) so counts do not shift as they change.

## Layout

A 256px sidebar on wide screens; a six-tab bar with labels on phones. Content sits on a
12-column grid at `lg`. Touch targets are at least 44px. Home puts the three week results
first: leads and bookings stack beside the taller revenue tile on a wide screen and sit side
by side on a phone.

## Elevation & Depth

Three levels, all from `theme.css`:

- **Page** (`bg`): flat black.
- **Card** (`surface` + `--elev-card`): Cult UI Minimal Card's layered hairline, a white inner
  top highlight and a soft drop shadow.
- **Card on hover** (`--elev-card-hover`): a brighter hairline, a deeper shadow, a 2px spring
  lift, and a pointer light on the edge with a faint glow inside (Magic UI Magic Card).

Rows inside a card use `border-soft` dividers, not their own shadows. Nothing else casts a
shadow.

## Spacing

A 4px base (`spacing` above). Card padding is 16px on a phone and 24px from `lg` (KPI tiles
20px). Gaps between cards are 12px on a phone and 16px from `lg`. Inside a card: 12px between
a value and its caption, 16px between groups, and a hairline before each new group. Page
titles keep 24px (32px from `lg`) above the first card.

## Shapes

`rounded.lg` for cards, `rounded.md` for list rows and nav items, `rounded.pill` for
badges, segmented switches and the tab-bar indicator.

## Components

- **KPI tile** (21st.dev KPI Tile, MIT): value with a rolling number, a change chip and a
  two-point sparkline for this week against the same span last week. Home turns scrubbing off
  (`scrub={false}`): with two points, scrubbing put last week's value beside this week's change.
- **Card** (Cult UI Minimal Card + Magic UI Magic Card, MIT): hairline card with the pointer
  light and spring lift (`card-live`).
- **Avatar** (Cult UI Collab Avatar, MIT): initials on a tinted pop colour picked from the
  name, glossy top light, spring entrance. Inbox, customers, appointments, account.
- **Border beam** (Magic UI, MIT): a blue-to-violet light that travels the edge. One per page,
  on the headline number (Home revenue). Not drawn under reduced motion.
- **Navigation** (21st.dev Animated Sidebar, MIT): a hover pill that glides between items and
  a sliding indicator on the current item; the phone tab bar uses the same indicator.
- **Segmented and view tabs** (Cult UI Halo Tabs, MIT): a sliding pill for pressed-button
  groups and a sliding underline for link tabs.
- **Badge** (Cult UI Halo Badge, MIT): tone pills; `live` adds an opacity-pulse dot.

## Motion

Springs everywhere something moves: nav indicators, segmented pills, KPI values, avatars
(`lib/motion.ts`), and the card lift (`--ease-spring`, a sampled spring for CSS). Colour and
shadow changes use `--motion-fast` (140ms). With reduced motion, `MotionConfig` (driven by a
live media-query hook) turns transforms off, the CSS durations drop to 0, the card lift stops
and the border beam is not drawn.

## Do's and Don'ts

- Do keep the screen monochrome; colour is good news (`success`), status, or an avatar.
- Do keep every label on the phone tab bar.
- Don't add a second border beam or any other looping effect to a page.
- Don't animate page entrances or whole lists; small things (avatars, values, pills) may spring.
