# Dashboard directions (L3 proofs, G3 passed: Direction A)

Owner: studio (agent) · Approver: Devin · Revision 1 · 2026-10-21

Two directions for the owner dashboard, proved on Home and Inbox at phone (390×844) and
desktop (1440×900), on the demo tenant's data. They are static HTML proofs, not app code.
After Devin picks one, its tokens go into `apps/dashboard/src/styles/theme.css` and the
components get rebuilt in the app (L5 onward).

- `a-light-tray/index.html`: Direction A, light tray.
- `b-control-room/index.html`: Direction B, black control room.
- `compare.html`: both directions side by side.
- `assets/`: stock portraits (Pexels). Credits are in `CREDITS.md`.
- `shots/`: screenshots of both directions at 390 and 1440 (`-fold` = first screen only).

## Decision (G3, 2026-10-22)

Devin chose **Direction A, light tray**. A also takes two things from B, already in the
proof: the named list of people inside the first Needs-you card, and the + button in the
top bar on phone. A Gemini 4 Argon visual review found 4 BLOCK and 14 WARN items across
both proofs; all were fixed before the decision. B stays here as a reference for a
possible dark theme.

## Evidence (Devin's references, 2026-10-21)

These are the 11 images he shared: the Active agents card, a phone to-do app, a team dashboard, the Sixfold pill
nav, a conversion-rate card, a composer with attachment chips, banking and savings trays,
a comment card with reactions, friends near you, a share dialog and an invite dialog.
The table says what each direction takes from them.

| Reference | A takes | B takes |
|---|---|---|
| Active agents card | grid of work cards with progress and a status dot | the whole idea: live agent cards with progress, ETA in mono, pause |
| Phone to-do app | week strip, grouped checklist, floating pill nav and + button | the floating pill nav with + |
| Team dashboard | to-do list with sub-items beside the schedule; status chips | status chips |
| Sixfold pill nav | lit active pill (accent fill) | lit active pill on black |
| Banking and savings trays | gray tray with a header inside, white inner cards; dimmed cents | dimmed cents, big tabular numbers |
| Conversion card | one KPI with delta chip and a breakdown | KPI breakdown rows with arrows |
| Comment card, reactions | inbox message with a tail and quick reactions | — |
| Composer chips | reply composer with attachment chips | reply composer |
| Share and invite dialogs | avatar rows with role pills | — |

## Demo content (use exactly this; it is what the app shows)

Business: Halden & Rowe (jeweller). Owner: Mara Halden. Today: Wednesday, October 21.

Needs you:
- 4 waiting for you (replies and reviews in Inbox)
- Next: 11:00 AM today, Ring design review, Marguerite Okafor (Showroom)
- 2 connections need you: Reconnect Instagram (access expired 2 days ago; new DMs are not
  reaching your inbox). Allow Google Business Profile (grant review access so review
  requests can link to your profile).

This week, since Mon Oct 19, compared with the same time last week:
- New leads 2 (last week 3, down 33%). Website 1 (last 0), added by your team 1 (last 3).
- Bookings 9 (last week 6, up 50%). Website 4 (last 1), booked by your team 5 (last 5).
- Revenue $13,750 (last week $1,250). 2 deals won this week, 1 last week. By lead source:
  Website $7,350 (last $0), Walk-in $6,400 (last $0), Referral $0 (last $1,250).

Next appointments:
- 11:00 AM Wed Oct 21: Ring design review, Marguerite Okafor, Showroom
- 3:00 PM Wed Oct 21: Watch band resize, Dashiell Moreau, Repair intake
- 10:30 AM Thu Oct 22: Prong re-tip, Wendell Ashby, Repair intake
- 1:00 PM Thu Oct 22: Eternity band fitting, Priya Raman, Showroom

Wallet and usage (prepaid; sending pauses at $0, so there are no surprise bills):
balance $41.18 of a $60 top-up. Text messages 312 of 500, agent replies 1,184 of 2,000,
emails 2,950 of 5,000.

Connections: Instagram needs reconnect, Google Business Profile needs access, Google
Calendar syncing both calendars, Stripe deposits land in your account in 2 days.

Agents: the inquiry follow-up agent drafts replies for owner approval. It has drafted
2 replies waiting for approval (Noor Haddad, Dashiell Moreau).

Inbox threads (newest first):
1. Teo Lindqvist, 5 h ago, website visitor, needs review. "No message" (a booking request:
   Repair intake, Sat Oct 24 at 2:00 PM).
2. M. Okafor, 10 h ago, website visitor, needs review: "Clasp keeps opening." Possible
   match with Marguerite Okafor. Booking request: Repair intake, Fri Oct 23 at 12:00 PM.
3. Linnea Castellanos, 20 h ago, needs reply: "Looking at sapphire halos."
4. Noor Haddad, yesterday, needs reply, 1 draft: "Hi Noor, we'd be glad to. We'll lay out
   hand and matching bands for you to try on Saturday."
5. Celeste Vandermeer, yesterday: "Hi Celeste, I've set aside two emeralds that would suit
   the setting you sketched."
6. Dashiell Moreau, 2 days ago, 1 draft: "Your watch band is resized and ready to collect at
   the counter."
7. Marguerite Okafor, 8 days ago: "Of course. We'll have a thinner halo ready to compare."

Open thread for the proofs: M. Okafor. Message: "Hi, the clasp on the bracelet I bought in
spring keeps opening. Could someone take a look? Friday around noon works." Request card:
Repair intake, Fri Oct 23, 12:00 PM, from the booking widget. Possible match: Marguerite
Okafor (same phone). Actions: Link to Marguerite Okafor, Create new customer, Decline.
Reply composer below.

Navigation: Home, Inbox (badge 4), Calendar, Customers, Site, Agents. Account menu holds
Settings, Connections, Plan. Footer note in demo: "Sample data. Changes reset on reload."

## Hard constraints for both

- Copy meaning stays as above. Short, plain sentences.
- Contrast AA for text, visible focus, 44 px targets, one h1 per page, reduced motion
  respected (all motion off under `prefers-reduced-motion`).
- Both must hold at 390 px wide with no horizontal scroll, and at 1440 px.
- Avatars use the photos in `assets/` (Mara Halden is the owner).
