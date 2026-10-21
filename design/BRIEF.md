# Dashboard redesign — brief (L0)

Owner: studio (agent) · Approver: Devin · Revision 1 · 2026-10-21 · Route: redesign (L0, L2, L5–L9)

## Ask
Devin, 2026-10-20: after the Google Calendar connect screen (#26) lands, redesign the owner
dashboard (`apps/dashboard`) with real components from 21st.dev and Cult UI.

## Product and audience
- Owners and staff of small service businesses (salon, studio, jeweller, trades). The
  demo tenant is Halden & Rowe, a jeweller.
- Phone first (390×844), desktop second (1440×900). Six areas: Home, Inbox, Calendar,
  Customers, Site, Agents; account menu holds Settings, Connections and Plan.
- Job: see what needs me today, answer people, keep the calendar full, never be surprised by a bill.

## What stays (hard constraints)
- Every behaviour, label used by tests, route, role rule and state stays. The redesign is
  visual and structural only: no API, contract or copy-meaning changes.
- Accessibility bar stays: axe clean (no serious/critical), 44px targets, visible focus,
  `label[for]`, reasons on disabled buttons, one h1 per page, reduced motion respected.
- Offline PWA keeps working; no runtime font or script from a third-party origin.
- Licences: only MIT (or compatible) component code; each ported file keeps a header
  naming its source and licence, and `NOTICE` lists them (docs/licenses.md).

## Evidence (L0)
- Before screens: `design/evidence/before/` (9 areas × phone and desktop).
- References (zs-design run `mvhk9m8h-f10a7c040a`, study only, no reuse): Fresha home and
  appointment feed, Jobber "Today's appointments" + to-do, TidyCal greeting + KPI strip,
  GlossGenius / Mangomint calendars, Acuity booking, HoneyBook home.
- What they teach: a greeting plus a short KPI strip beats stacked cards; "today" comes
  first; the to-do list (what needs you) sits next to the schedule; status is a quiet
  pill, not a coloured block; numbers are large and tabular.

## Before: problems seen
1. Home on phone is a long stack of equal cards; nothing says what needs action first.
2. System font and one flat blue accent: competent but generic; no hierarchy in numbers.
3. Desktop sidebar is plain; the phone tab bar is a plain row of icons.
4. KPI cards repeat the same row pattern with small, low-contrast comparison text.

## Components (all MIT, licence checked 2026-10-21)
| Need | Component | Source |
|---|---|---|
| Desktop sidebar, phone sheet | Animated Sidebar | 21st.dev @starc007 (MIT) |
| Phone tab bar / segmented switches | Expanding Tabs | 21st.dev @aicanvas (MIT) |
| KPI tiles with sparkline | KPI Tile | 21st.dev @konsstepnov (MIT) |
| Status pills (live dot) | Halo Badge | Cult UI (MIT) |
| Tabs (Contacts / Pipeline) | Halo Tabs | Cult UI (MIT) |
| Quiet content cards | Minimal Card | Cult UI (MIT) |
| Pipeline board | Kanban Board | Cult UI (MIT), only if it keeps keyboard moves |
Rejected: 21st.dev Bottom Nav Bar (no licence stated).

## Success
- Home answers "what needs me now" in the first phone screen.
- Every existing e2e, a11y and unit test passes unchanged in meaning.
- Devin signs G4 on the rendered first journey (shell + Home + Connections), then G5.

## Open risks
- Motion adds a dependency (`motion`); keep it to transform/opacity and honour reduced motion.
- Snapshot-style e2e assertions on classes or layout may need updates; behaviour must not.
