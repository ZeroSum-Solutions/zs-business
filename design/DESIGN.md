---
version: "2.0"
name: "zs-business dashboard"
description: "Direction A, light tray: a white page, grey trays that hold white cards, cobalt for the primary action and the current place, an ink pill for navigation, Manrope, and short spring motion. Light is the default; dark is a per-device choice."
provenance: "Redesign of apps/dashboard, 2026-10-20; Direction A (design/directions/a-light-tray) chosen 2026-10-22 and shipped in #30. Tokens live in apps/dashboard/src/styles/theme.css; the code is the truth and this file records it. Ported MIT components are listed in NOTICE."
colors:
  bg: "#ffffff"
  surface: "#ffffff"
  tray: "#eeeef1"
  tray-deep: "#e6e6ea"
  inset: "#f6f6f8"
  fg: "#141418"
  fg-2: "#33333b"
  muted: "#55555f"
  meta: "#62626c"
  border: "#e3e3e8"
  border-soft: "#ececf0"
  border-strong: "#8e8e97"
  primary: "#3047f0"
  primary-on: "#ffffff"
  ink: "#141418"
  ink-on: "#ffffff"
  accent: "#3047f0"
  accent-on: "#ffffff"
  accent-tint: "#ebeeff"
  accent-ink: "#2236c9"
  nav: "#17171c"
  nav-lit: "#5065ff"
  info: "#0a5875"
  success: "#2236c9"
  warn: "#6f4800"
  danger: "#a83020"
typography:
  page-title:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 32px
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  kpi-value:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 32px
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.03em"
  card-title:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
  field:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  ui:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  meta:
    fontFamily: "Manrope, system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
rounded:
  sm: 10px
  md: 14px
  lg: 20px
  tray: 28px
  pill: 9999px
spacing:
  "1": 4px
  "2": 8px
  "3": 12px
  "4": 16px
  "5": 20px
  "6": 24px
  "8": 32px
  "10": 40px
  "12": 48px
---

# zs-business dashboard

## Overview

The owner opens this on a phone between appointments and on a laptop at the end of the day.
The screen has one job: show what needs the owner now and let them act on it. The look is
quiet so the business's own data carries the colour. The brief and before/after evidence are
in `design/BRIEF.md` and `design/evidence/`; the chosen direction is in
`design/directions/a-light-tray/`.

Revised 2026-10-22 (audit U1-11, U3-14, A-20): this file described the retired black theme,
Google Sans and a violet accent. It now records Direction A as shipped in #30.

## Colors

Direction A, "light tray" (chosen 2026-10-22, shipped in #30; it replaced the 2026-10-20
black theme). Light is the default. A white page holds grey trays (`tray`), and the trays hold
white cards. Colour has jobs:

- `primary` (cobalt #3047f0): solid fills for the main action on a screen (Send, New, Save).
- `ink` (near-black): the quiet solid action (Reconnect), counts and the brand mark.
- `accent` (cobalt, the same hue as `primary`): where you are and what you can follow: links,
  focus rings, selected rows, progress and selection. `accent-ink` is its text shade.
- `nav` (ink pill) with `nav-lit` (a lighter cobalt) under the current item.
- `success` (cobalt): good news: up trends, connected, sent. Good news shares the brand hue;
  there is no green.
- `info` (teal): routine work waiting on the owner, such as "Needs reply".
- `warn` (amber) to review or fix; `danger` (coral) for failed or down. Each has a `-tint`
  for chips and icon tiles.
- Avatars take one of eight pops picked from the name.

Every text pair meets WCAG AA on white and on a tray; `meta` is the lowest-contrast text and
`faint` is for large text only. `border-strong` gives component edges 3:1.

**Dark theme.** The owner can pick Dark or Match device in Settings > Appearance; the choice
is saved on the device and set before first paint (`lib/theme-script.ts`). Dark keeps A's
roles on ink: the page is #0e0e11, cards #1d1d23, and the trays sit darker than the cards as in
light. `primary` lifts to #4d62ff, `accent` to #95a2ff, `ink` turns near-white, and the status
colours lighten until each meets AA on the card, the tray and its own tint. The values live in
`src/styles/theme.css` under `:root[data-theme="dark"]`; the YAML above lists light only.

## Typography

Manrope (SIL OFL 1.1) for everything, self-hosted by `next/font` (no request to Google at
run time). The offline service worker keeps pages, scripts and styles but not fonts, so a cold
offline open shows the system font. Page titles and KPI values are 32px on a phone and 40px
from `lg` up, extra bold, with -0.03em tracking. Body copy is 15px; form fields stay 16px so
phones do not zoom. Numbers use tabular figures (`tabular` utility) so counts do not shift as
they change.

## Layout

One content column up to 1360px. On wide screens the header holds the brand, the ink
navigation pill in the centre, and New and the account menu on the right. On phones a
floating ink dock with six labelled tabs sits 16px above the bottom edge. Touch targets are at
least 44px. Home opens with a Needs you row, then the three week results: leads and bookings
stack beside the taller revenue tile on a wide screen and sit side by side on a phone.

## Elevation & Depth

Four levels, all from `theme.css` and `globals.css`:

- **Page** (`bg`): flat white.
- **Tray** (`tray`, 28px radius, 6px padding, 8px from `lg`): a grey well that groups the
  cards of one area, with its header inside. A tray holding cards is the one nesting allowed.
- **Card** (`surface` + `--elev-card`): white, 20px radius, a hairline ring and a soft
  two-step shadow. Lists, threads, bookings and review panels are cards.
- **Inset** (`inset`): a recessed panel inside a card (a draft, a matched customer).
- **Card on hover** (`--elev-card-hover`, pointer devices only): a deeper shadow and a 1px
  lift; reduced motion keeps the shadow and drops the lift.

Menus, sheets, the floating nav and toasts use `--elev-raised`. Inputs are wells
(`--elev-field`, an edge that meets 3:1). Rows inside a card use `border-soft` dividers.

## Spacing

A 4px base (`spacing` above). Card padding is 16px on a phone and 24px by 20px from `lg`.
Cards inside a tray sit 6px apart (8px from `lg`). Inside a card: 12px between a value and its
caption, 16px between groups, and a hairline before each new group. Page titles keep 24px
(32px from `lg`) above the first tray.

## Shapes

`rounded.tray` for trays, `rounded.lg` for cards, `rounded.md` for inner panels and list
rows, `rounded.pill` for badges, buttons, segmented switches, the navigation pill and its
indicator.

## Components

- **KPI tile** (21st.dev KPI Tile, MIT): value with a rolling number and a change chip. Home
  has only two points per number, so it turns the sparkline off and shows two bars (this week
  in cobalt, the same time last week in grey) instead.
- **Needs you** (Home): three linked cards first on every screen: waiting conversations, the
  next appointment, and connections that need action.
- **Card** (Cult UI Minimal Card, MIT): hairline card with a small lift on hover (`card-live`).
- **Avatar** (Cult UI Collab Avatar, MIT): initials on a tinted pop colour picked from the
  name, glossy top light, spring entrance. Inbox, customers, appointments, account.
- **Border beam** (Magic UI, MIT): kept in `components/ui/border-beam.tsx` but not drawn on
  any page since Direction A.
- **Navigation** (21st.dev Animated Sidebar, MIT): the ink pill with a sliding `nav-lit`
  indicator on the current item; the phone dock uses the same indicator.
- **Segmented and view tabs** (Cult UI Halo Tabs, MIT): a sliding pill for pressed-button
  groups and a sliding underline for link tabs.
- **Badge** (Cult UI Halo Badge, MIT): tone pills; `live` adds an opacity-pulse dot.

## Motion

Springs for things that move: nav indicators, segmented pills, KPI values and avatars
(`lib/motion.ts`). The card lift uses `--motion-base` (200ms) with a strong ease-out; colour and
shadow changes use `--motion-fast` (140ms). With reduced motion, `MotionConfig` (driven by a
live media-query hook) turns transforms off, the CSS durations drop to 0 and the card lift
stops.

## Do's and Don'ts

- Do give colour a job from the list in Colors; never colour for decoration alone.
- Do keep every label on the phone tab bar.
- Don't add a looping effect to a page.
- Don't nest a card in a card; a tray holding cards is the only nesting.
- Don't animate page entrances or whole lists; small things (avatars, values, pills) may spring.
