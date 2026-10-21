---
version: "1.0"
name: "zs-business dashboard"
description: "Calm owner dashboard for a small service business: warm paper neutrals, one deep green accent, Google Sans, hairline cards and short spring motion on navigation only."
provenance: "Redesign of apps/dashboard, 2026-10-20. Tokens live in apps/dashboard/src/styles/theme.css; this file records them and the reasons. Ported MIT components are listed in NOTICE."
colors:
  bg: "#f5f4f0"
  surface: "#ffffff"
  surface-warm: "#efede7"
  fg: "#15171a"
  fg-2: "#363a40"
  muted: "#555a61"
  meta: "#62666d"
  border: "#e2e0d9"
  border-soft: "#ecebe5"
  border-strong: "#868990"
  primary: "#1f5a4c"
  accent: "#1f5a4c"
  accent-on: "#ffffff"
  accent-hover: "#194b3f"
  accent-active: "#143d33"
  success: "#1b7347"
  warn: "#8a5300"
  danger: "#b3261e"
typography:
  page-title:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 500
    lineHeight: 40px
    letterSpacing: "-0.022em"
  kpi-value:
    fontFamily: "Google Sans, system-ui, sans-serif"
    fontSize: 36px
    fontWeight: 600
    lineHeight: 40px
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

Warm paper neutrals (`bg`, `surface-warm`) instead of cold greys, white cards, and one deep
green `accent` for the current place, primary actions and positive trends. `success`, `warn`
and `danger` are status only, never decoration. Every text pair meets WCAG AA in both modes;
`meta` (#62666d on #f5f4f0) is the lowest-contrast text and still passes 4.5:1.

Dark mode (system preference or `data-theme="dark"`): bg #101211, surface #181a19,
surface-warm #202321, fg #ecebe7, fg-2 #cfcfca, muted #a8aba7, meta #969a96, border #2b2e2c,
border-strong #6e736f, accent #7cc8b2 on accent-on #081712, success #5cc995, warn #e2ab4a,
danger #f0857a.

## Typography

Google Sans for everything, self-hosted by `next/font` (no request to Google at run time). The
offline service worker keeps pages, scripts and styles but not fonts, so a cold offline open
shows the system font, which is what the dashboard used before this redesign.
Page titles are 28px on a phone and 36px on a wide screen, with -0.022em tracking. Numbers use
tabular figures (`tabular` utility) so counts do not shift as they change.

## Layout

A 256px sidebar on wide screens; a six-tab bar with labels on phones. Content sits on a
12-column grid at `lg`. Touch targets are at least 44px. Home puts the three week results
first: leads and bookings stack beside the taller revenue tile on a wide screen and sit side
by side on a phone.

## Elevation & Depth

Cards use `--elev-card`, a layered hairline from Cult UI Minimal Card: a 1px ring plus two
soft shadows, with an inner top highlight in dark mode. No other card shadows.

## Shapes

`rounded.lg` for cards, `rounded.md` for list rows and nav items, `rounded.pill` for
badges, segmented switches and the tab-bar indicator.

## Components

- **KPI tile** (21st.dev KPI Tile, MIT): value with a rolling number, a change chip and a
  two-point sparkline for this week against the same span last week. Home turns scrubbing off
  (`scrub={false}`): with two points, scrubbing put last week's value beside this week's change.
- **Navigation** (21st.dev Animated Sidebar, MIT): a hover pill that glides between items and
  a sliding indicator on the current item; the phone tab bar uses the same indicator.
- **Segmented and view tabs** (Cult UI Halo Tabs, MIT): a sliding pill for pressed-button
  groups and a sliding underline for link tabs.
- **Badge** (Cult UI Halo Badge, MIT): tone pills; `live` adds an opacity-pulse dot.

## Motion

Motion marks a change of place only: nav indicators, segmented pills and KPI values. Springs
come from `lib/motion.ts`; colour and shadow changes use `--motion-fast` (140ms). With reduced
motion, `MotionConfig reducedMotion="user"` turns transforms off and the CSS durations drop to 0.

## Do's and Don'ts

- Do keep one accent; status colours mean status.
- Do keep every label on the phone tab bar.
- Don't add gradient rims, glow or looping decoration; the ported components had them and they
  were removed on purpose.
- Don't animate lists, cards or page entrances.
