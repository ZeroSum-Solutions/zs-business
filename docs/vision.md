# Vision: the whole company on one phone

Status: recorded 2026-11-22 (ZSB-68) from Devin's product-planning recording of the same day.
Audited against `main` at `adc22ac`, `docs/direction.md`, the B01 to B26 backlog, the requirement
contracts, the ZSB tracker and the ZS Agent Business (ZAB) launch plan, by Claude and,
independently, by GPT-6.2 Sol. Every code claim below was checked in the code.

This file holds the end goal and the verdict on each idea. It does not replace
`docs/direction.md`: that file still sets the order of work and the trust rules, and a numbered
rule still lives in `docs/requirements/`. An idea here becomes scope only when it has a contract
or a ticket. Items marked **D-n** wait on a decision only Devin can make (section 6).

**New to the repo? Read this file first, then `docs/direction.md`, then the contract for your
ticket.**

## 1. The end goal

A person opens one app on their phone. They sign up, tap one button and talk. The product learns
who they are, what they sell and what they want, builds a plan with them, and turns that plan into
the tools and agents they need. From then on they run 80 to 90 percent of the business from the
phone.

**One interface. Hundreds of agents. One password.**

- **One interface:** the phone app is the only tool the owner needs day to day.
- **Hundreds of agents:** many small task types work behind a few visible seats. The owner talks
  to one of them (the Chief of Staff, `direction.md` section 3). The owner never needs to know
  which agent does what.
- **One password:** the owner signs in once. Outside accounts connect through that sign-in by
  OAuth and are never kept as passwords (V-27).

The point is time. The owner and their staff spend it on the product, the customers and the work
that matters, not on running tools.

**The business companion.** The owner talks to one companion. It is the face of the Chief of
Staff. Most work happens by talking: the companion asks, drafts, sets things up and reports back.
When seeing something helps, it shows a card from a fixed catalog: a choice, a draft, a form that
asks for a missing field, a connection to approve. When the conversation moves on, the card goes
away. The owner can also swipe from the talk screen to the canvas and the tools (schedule,
customers, inbox, site, the team of employee agents) and work by hand. Setup should feel like one
conversation that ends with the business, its accounts and its site ready. The reference for this
feel is the OS1 study (`docs/reverse/os1-her.md`, ZSB-82). Ours is for businesses, with many tenants
and the trust rules in `direction.md`. Ideas V-32 to V-38.

This matches the north star in `direction.md` section 1 and widens it in three places: a guided
plan at the start (V-01 to V-07), content and commerce tools for sellers (V-10 to V-21), and a
price that grows with the business (V-22 to V-25).

## 2. The journey

1. **Sign up** on the phone (B09, ZSB-27). Today sign-in cannot create a user
   (`apps/dashboard/src/lib/server/sign-in.ts`, `shouldCreateUser: false`).
2. **Talk.** The companion wakes and asks: "Tell me about yourself, your idea, your
   business." Voice or text; form cards collect the exact facts it needs (V-01, V-32, V-33, D-6)
3. **Route.** The intake picks the next questions. Two starting points: a new idea from zero
   (V-03), or an existing business with its problems and goals (V-04). (V-02)
4. **Research while talking.** The owner gives a website URL. The product reads the public site,
   shows what it found as cards in the chat, and the owner confirms or corrects each finding.
   Confirmed findings become company facts that record their source (V-05, V-06; ZSB-43).
5. **Plan.** The conversation ends in a written plan in phases, with a clear next action (V-07).
6. **Tools follow the plan.** The plan says which tools and agents this owner needs and in what
   order. It also says why each tool is available, blocked or optional (V-07).
7. **Run.** Calendar, store, social, site, search visibility, inbox and follow-up work from the
   phone. Agents do the work; the owner approves it (V-08 to V-31).

## 3. Who it is for first

The recording says sellers: people with a product, software or a service to sell, e-commerce and
SaaS first. The ZAB brief says solo operators who sell online, products or themselves as a
service. `direction.md` keeps the base neutral, and today's code serves leads, bookings and
replies best. **The first cohort is open (D-1).**

Sol's recommendation: start with solo service sellers who take bookings, because the code gives
them the shortest path to value, and make e-commerce the second cohort. If Devin picks e-commerce
first, Shopify catalog work leaves "Park" and moves into the first stage (ZSB-77).

## 4. Idea catalog

Verdicts: **Keep** (build it in its stage), **Reshape** (build a safer or cheaper form), **Defer**
(good, waits for a named gate), **Drop**. "Today" names what exists on `main`. ZAB means the
`zs-agent-business` repo (launch, canvas, marketing engine).

### Onboarding and planning

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-01 | Voice-first intake after sign-up | Reshape | No public sign-up (B09). Voice serves only uploaded audio and voicemail (`packages/core/src/transcription`). No owner microphone path | One resumable interview with an editable transcript; voice and text feed the same record (B17, B24, ZSB-75). Whether launch is voice-first or text-first is D-6. Voice never approves a recipient, an amount or a term (`direction.md` rule 5) |
| V-02 | Routing that picks the next questions | Keep | Setup applies one of four templates (`packages/core/src/setup/handlers.ts`, `industry-templates.md`) | ZSB-70: a typed, resumable question graph with two entry points |
| V-03 | New business: idea to plan from zero | Keep | Nothing in ZSB. ZAB-58 builds a guided start flow for 2027-01-14 | ZSB-70 and ZSB-71. Who builds the flow is D-3; records stay in ZSB |
| V-04 | Existing business: problems and goals | Keep | Nothing | ZSB-70: its own first questions; confirm current tools and data before suggesting change |
| V-05 | GenUI cards in the chat | Reshape | Nothing | A fixed set of typed cards only (URL, cited finding, correction, plan step). Never free HTML |
| V-06 | Live website research, owner verifies | Reshape | Company facts with who set each are built (`packages/core/src/business/facts.ts`). No research fetcher | A read-only public-page fetcher. Page text is data, never an instruction (`direction.md` rule 4). Unconfirmed findings never enter company facts or drive an action |
| V-07 | The plan decides which tools each owner needs | Keep, new core | No plan record and no plan-to-tool map. Only Hub plan limits (`plans.md`) | ZSB-70: versioned plan, phases, a capability catalog keyed to scopes, plan limits and dependencies; replanning keeps data and approvals |

### Mobile tool suite

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-08 | Run 80 to 90 percent of the business from the phone | Keep, as the measure | Installable PWA, six areas, tested at 390x844 (`apps/dashboard`) | ZSB-72: a recurring job list per cohort; count handoffs off the phone. Validate before it goes in sales copy |
| V-09 | Calendar and reminders | Keep | Built: booking, Google Calendar, templated reminders (`packages/core/src/templates/send.ts`) | Close the recipient gaps first (ZSB-58, ZSB-59) |
| V-10 | Shopify connection, batch edits, AI descriptions | Keep reads, defer writes | Native and managed tiers read orders only (`shopify/production/shopify.app.toml`, `read_orders`). Listing in review | ZSB-77: one drafted description as a reviewed diff on a test store before batch writes. Depends on D-1 |
| V-11 | Social media management | Keep | Only a deferred Google Business Profile contract (`social-publishing.md`) | Export and human posting first; ZSB-76 for direct posting |
| V-12 | Website from the phone | Keep | Built: edit, preview, versioned publish, roll back (`packages/core/src/sites`, `apps/site-worker`) | Site from the plan and the confirmed facts; ZAB canvas or Mish authors, ZSB publishes (ZSB-71) |
| V-13 | SEO and AEO | Keep basics | Nothing in ZSB. ZAB has an AEO builder (`marketing-engine/03-pipelines/aeo`) and `tools/aeo` | Crawlable pages first. Where customer AEO runs is D-3 |

### AI content and marketing

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-14 | Phone video, an agent edits it into clips | Keep, in ZAB | ZAB cut pipeline handles phone footage, revisions and exports (`marketing-engine/03-pipelines/cut`) | ZSB holds media records and publish approvals (ZSB-71, ZSB-74). Measure render cost; check footage, music and likeness rights |
| V-15 | Publish to Instagram, TikTok and X | Defer direct posting | Nothing | ZSB-76. Instagram needs professional accounts and permission; TikTok keeps unaudited direct posts private; X charges for API use and has automation rules |
| V-16 | Trend research and content calendar | Reshape | Nothing in ZSB. ZAB has an internal calendar pipeline | ZSB-74: sourced ideas, a film list, scripts and a calendar the owner approves |
| V-17 | Teleprompter and filming notes | Keep, after a device test | Nothing | ZSB-75 proves recording and upload recovery on real phones, then ZSB-74 |
| V-18 | "$20k-grade" website | Keep the workflow, drop the claim | Site publishing built | Use it as an internal quality bar only. A public dollar comparison needs proof |
| V-19 | Brand identity, marketing copy, email templates | Keep, as drafts | `marketing-email.md` is a deferred contract; Resend sends text only (`resend.md` R-4) | Drafts from confirmed facts. Branded HTML email needs a `resend.md` revision |
| V-20 | Entity setup | Reshape | `direction.md` stage 2: a checklist of human steps | A checklist with official links and a human handoff. No legal or tax advice, no stored tax IDs |
| V-21 | Site telemetry and an agent that A/B tests to a threshold | Reshape telemetry, defer the agent | No analytics (`apps/site-worker` serves pages only) | ZSB-80: consent, a defined lead or purchase event, minimum traffic, stop rules and roll back. The owner approves each experiment (D-5) |

### Pricing and accounts

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-22 | About $49 to start and try | Reshape | Three sources disagree. Code: Solo $49, Studio $99, Pro $199, a card-required 14-day trial (`packages/contracts/src/plans.ts`, `plans.md`). ZAB: Solo $49, Pro $99, Enterprise $499, no trial, 14-day money back. The recording: "try" for about $49 | One price source (D-2). Solo has no model agents today (ZSB-69) |
| V-23 | Unlock fee per phase plus a small monthly price | Defer | Hub plans only | ZSB-78, after the first cohort shows which milestones carry value |
| V-24 | Revenue share by phase (examples 8, 6, 4, 2 percent) | Defer | No read of the owner's own sales | ZSB-78: counsel and finance. One definition of revenue, refunds, chargebacks, offline sales, audit rights and exit. The example phase ranges overlap |
| V-25 | Detect several accounts per person under contract | Drop phone-based enforcement; keep abuse controls | Sign-in rate limits, free-tier allowances (PL-27) | Phone numbers are shared and recycled, and one owner may run several real businesses. Cap free usage, allow one owner across tenants, review and appeal (ZSB-78) |

### Integrations, security and agents

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-26 | QuickBooks, no tax | Defer the connector, keep the boundary | Nothing | Stage 3 money view, read only, operations enforced on the server (ZSB-73) |
| V-27 | One vault, one login | Keep one login; drop password collection | OAuth through Composio's managed tier; credential fields never leave the adapter (`packages/core/src/connections/composio.ts`). Sealed Shopify and Calendar tokens | ZSB-73: one ZS login with passkey or MFA, OAuth grants, sealed tokens; never store an owner's third-party passwords |
| V-28 | One MCP that holds every tool ("code mode") | Reshape | One scoped remote `/mcp` endpoint with about 40 tools (`apps/api/src/mcp`, `packages/mcp`, `hub-access.md`) | ZSB-79: benchmark deferred tool search, Composio Tool Router and composed calls before adding a gateway |
| V-29 | Agent-driven texts and emails | Reshape | Email follow-up drafts with one approval each; templated sends; opted-in missed-call text-back; allowlisted outreach | Keep `direction.md` stages. Agent SMS stays stage 4: consent proof, carrier registration, quiet hours, a stop that reaches unsent work |
| V-30 | Agents with their own computers; "Malspot" | Defer | "Malspot" is OpenMausBot. ZAB piloted it (`marketing-engine/02-stack/openmausbot/PILOT.md`); the approval route failed and the trial closed. Browser tasks parked (`browser-tasks.md`) | Out of the release path. A later pilot runs one isolated job with an expiry, a spend cap and a full receipt |
| V-31 | A base that takes more tools later | Keep | Connections catalog, `/mcp` and the action path extend | Tools register in the capability catalog (ZSB-70) |

### The business companion (added 2026-11-22, ZSB-82)

From the OS1 study (`docs/reverse/os1-her.md`). Contract: ZSB-83 (`companion.md`).

| ID | Idea | Verdict | Today | Next |
|---|---|---|---|---|
| V-32 | The companion is the home screen: a calm, voice-first presence, not a chat log | Keep | Dashboard home is a briefing page; no command entry (`direction.md` §4, gap 3) | ZSB-83. Talk is home. Voice-first or text-first at launch is D-6 |
| V-33 | Generative UI: cards from a typed catalog, including form cards that ask for missing information | Keep | Nothing. V-05 already limits cards to a fixed typed set | ZSB-83: catalog with a schema per card (choice, draft preview, form, connect, plan step, read-back). The server validates each card. No free HTML |
| V-34 | Every control can be said; a phrase match runs before any model | Keep | Nothing | ZSB-83. Navigation and simple commands resolve without a model call. A tap and a phrase take the same path |
| V-35 | Swipe from talk to canvas and tools | Keep | Installable PWA with six areas at 390x844 | ZSB-83. Talk, canvas, schedule, customers, inbox, site, team |
| V-36 | Employee agents the owner sees, assigns, pauses and stops from the phone | Keep | Agent runs, kill switches and cost exist (`packages/core/src/agents`) | ZSB-83 view over B11 and B12. Each agent shows its work, its next approval and a stop |
| V-37 | The companion sets up the environment: accounts, connections, site, in the right order | Keep, inside the trust table | Setup templates, Composio OAuth, site publish | ZSB-70 orders the steps; ZSB-83 runs them by conversation. Each connection and each publish still takes one owner tap (`direction.md` trust table). No stored third-party passwords (V-27) |
| V-38 | The companion's words match the records | Keep, a hard rule | The action path already commits before it reports | ZSB-83: the companion never says done, open, connected or booked until the record says so. OS1's first run broke this repeatedly |

## 5. Conflicts with the current plan

1. **First cohort.** Recording: e-commerce and SaaS. `direction.md`: neutral base, parks Shopify
   and catalog work. ZAB: solo online sellers. D-1.
2. **The Stage 0 gate cannot pass as written.** It asks a fresh sign-up to approve an
   agent-drafted reply, but Free and Solo have `modelAgents: false` and the plan gate refuses it
   (`packages/core/src/billing/plan-gate.ts`). ZSB-69 (B26).
3. **Setup timing.** `direction.md` puts the setup interview in stage 2. The recording makes it
   the front door, and ZAB-58 wants a guided flow by 2027-01-14. ZSB owns the records and the
   actions either way; the handoff is ZSB-71. D-3.
4. **Price.** Three sources, three models (V-22). D-2.
5. **Autonomy.** The recording says the conversion agent and the texts run "automatically".
   `direction.md` and the ZAB brief keep a person on every send, post and spend. The stricter rule
   wins; autonomy is earned per task type at stage 4. D-5.
6. **Agent count.** "Hundreds of agents" means hundreds of task types under a few seats, not
   hundreds of standing agents. `agents.md` still rules out delegation; B12 revises it first.
7. **Agent computers.** Parked; the OpenMausBot pilot already failed on approvals (V-30).
8. **Voice first.** Devin wants talking to the companion to be the main way to work. V-01 said
   text first, voice later, and rule 5 keeps approvals on a screen. Voice can do everything except
   approve; the approval is a tap on the card the voice prepared. D-6.
9. **"Just do it" with undo.** OS1 runs low-stakes actions at once with a 60-second undo. Our
   trust table allows that only for reading, sorting, labelling and drafting. A send, a publish, a
   connection or money never runs on undo alone. D-7.

## 6. Decisions for Devin

Run as one grill session (ZSB-81). D-6 to D-8 were added from the OS1 study (ZSB-82). Record each answer here with its date.

- **D-1** The first cohort and its first valuable phone job. Recommended: solo service sellers
  who take bookings, e-commerce second.
- **D-2** One price source: the self-serve price and what the $49 tier includes (model drafts or
  not), trial or money back, phase fees, and whether revenue share is worth counsel time.
- **D-3** Who builds the guided start and customer AEO: ZAB (with ZSB as the control plane) or ZSB.
  What the Jan 14 self-serve flow must do on day one.
- **D-4** Native app or PWA. Decide after the device spike (ZSB-75).
- **D-5** How far the conversion agent may act on a live site without a tap per change.
- **D-6** Launch with the companion voice-first (talk is home, text as fallback) or text-first
  with voice added after the device spike (ZSB-75). Voice-first raises the case for a native app
  in D-4 and raises the cost per active account (ZSB-72).
- **D-7** Which companion actions run at once with an undo, and which need a tap. Recommended:
  only the "agents may do alone" column of the trust table runs with undo; everything else stays
  one tap on the exact action.
- **D-8** The companion's identity: one product-named companion for every tenant, or a companion
  each owner names and gives a voice, as OS1 does. Any voice must be licensed or original.

D-3 now carries more weight: the guided start is the companion's first run, so whoever builds it
builds the front door.

### Decisions taken (ZSB-81 grill, 2026-11-24)

Terms are defined in `GLOSSARY.md`; hard-to-reverse choices have ADRs in `docs/adr/`.

**Principles (Devin)**
- **P-1** Build each part whole, once. Friction is a defect. Security is folded into the flow,
  not added as gates. A full rebuild is allowed where the base is wrong.
- **P-2** Each feature is also a standalone service, marketed while it is built to earn income and
  recruit testers, and sold through the same app, login and records.

**D-1 Cohort.** Both cohorts at once: solo service sellers who take bookings, and makers and
e-commerce sellers who take orders. Makers lead the brand and marketing (Plaud 2026-11-24). Any
stage is welcome, from an idea to a large seller; the success measure counts only owners with a
real business.

**Q2 First e-commerce job.** Read-only order replies: the customer quotes an order number, an agent
reads it, checks that the requester placed it, takes tracking from the store's fulfillment
records and drafts a reply for one tap. Store writes stay in ZSB-77.

**Connections before 2027-01-05 (Plaud round 1).** Shopify, Etsy, Stripe, Shippo and Klaviyo, each
built whole. Faire is a candidate. Pirate Ship is out (no API). QuickBooks stays at Stage 3.
Etsy and Faire review app access by hand: apply in the first week so review runs during the build.

**D-2 Price (Q4–Q10).**
- `plans.ts` is the one price source: Solo $49, Studio $99, Pro $199, annual and founding prices as
  they are. Stripe and Shopify prices are reconciled to it. Enterprise is an agency quote. The ZAB
  brief is fixed through a ZAB ticket. Meagan's "$37 or less" is a recorded dissent.
- Sign-up needs a verified email and no card. Free has no AI drafting. Paid features start with the
  14-day card-required trial, once per tenant (Shopify: per shop, verified before it is
  advertised). The app discloses the conversion date, the charge and how to cancel. No money-back
  at launch; refunds stay human-run and never delete data (rule 10). ADR 0005.
- Solo includes AI drafting at $1 per day per agent kind, under the company ceiling (B11).
- Testers redeem a single-use, email-bound invite code for a 14-day Solo grant with no card and no
  operator step. Devin authorises each batch up front. PL-21..24 are revised to fit.
- The existing $10/month Stripe connection add-on stays. New bundles (stacks, single agents) wait
  until after 2027-01-27.
- Tiers against a revenue share (about 2%, possibly falling by phase) is research again, raised in
  ZSB-78 (Plaud round 1). This replaces the earlier "defer until after Stage 3".

**D-3 First run (Q11).** One app, one login, one conversation. ZSB builds the whole first run: both
entry points, the full question graph (ZSB-70, pulled from Stage 2), reading the owner's public
site with confirmed findings, facts, plan, booking or store connection, first agent on. ZAB's site
and AEO producers draft behind the companion through ZSB-71. One Go live tap publishes the bound
release all or nothing (ADR 0003). Jan 14 stays the agency and canvas soft launch; self-serve
launches whole to the cohort by Jan 27. ZAB-58 is re-scoped to the producers.

**D-4 Client (Q12).** Keep the server core. Rebuild the owner client as one Expo native app for iOS
and Android; retire `apps/dashboard` after parity (ADR 0001). ZSB-75 verifies the native build in
parallel. If Apple in-app purchase rules are unresolved, the public store release slips and the
cohort stays on TestFlight.

**D-6 Voice (Q13).** Voice-first at launch, typing in the same conversation (ADR 0002). Voice can do
everything except approve.

**D-5 Experiments (Q14).** One tap per experiment card binds the variants, split, event, sample,
stop rules, deadline and a conditional promotion of the winner. Code checks the conditions and
rolls back on harm. No new copy, prices or offers without a new card. Visitors opt in to tracking.
Built after Jan 27 on ZSB-80. Once proven per task type, it becomes automatic (Stage 4). Sold
standalone as a conversion optimiser.

**Agents (Plaud round 1).** The companion is the CEO agent and delegates through durable tasks
(ADR 0004). A stack is a sold bundle of task types. Zero Sum runs its own business as tenant zero
in the same app; internal dev tooling (Grok Bot, T3, LazyGurl) stays outside ZSB.

**Business formation (Plaud round 2, 2026-11-24).** Sold as factual research only: name, domain,
handle and federal trademark availability, each with its source and date, plus official links for
the state the owner picks. It never recommends a state or calls a name legally clear. Counsel
reviews the wording before it is sold. Filing for the owner waits until after Jan 27 (V-20).

**Visitor analytics (Plaud round 2, 2026-11-24).** A funnel check on first-party site analytics
(ZSB-80) shows where visitors drop off between catalog, cart and checkout, and tracks only visitors
who opt in. Session replay and third-party replay tools (Clarity and similar) wait. It feeds the
experiment cards (D-5) and is sold standalone.

### Success measure

By 2027-01-27, 10 outside owners (5 service, 5 e-commerce) use the app on their own phones, with no
laptop and no operator, and:
- median time from sign-up to setup done (booking page live or store connected) is under 15
  minutes, timed per cohort;
- the first agent draft is ready within 2 hours of the tenant's first real customer message
  outside quiet hours (new tenants start with `waitHours` = 1);
- at least one approved reply per owner is delivered once, to the bound address.

## 7. Gaps neither plan covered

- **Activation and retention** (ZSB-72): first value event, time to first approved action, return
  use, approval load, support time.
- **Plan and capability records** (ZSB-70): interview revisions, confirmed facts, goals, and
  suggestions that move through proposed, approved, connected, blocked and done.
- **One account across portal, canvas and hub** (ZSB-71): identity, tenant choice, roles,
  ownership transfer, refunds, export and deletion across both repos.
- **Phone reliability** (ZSB-75): draft persistence, microphone denial, interruption, background
  upload, push only after a Home Screen install on iOS.
- **Abuse, recovery and support**: sign-up quotas, account recovery, connection revoke, incident
  ownership. Free-tier gaps are ZSB-50 to ZSB-52.
- **Cost per active account** (ZSB-72): model, speech, render, storage, email, SMS, workers and
  human support, measured from the first cohort, not at stage 3.

## 8. Tickets from this audit

| Key | What | Priority |
|---|---|---|
| ZSB-69 | B26: first-agent entitlement so the Stage 0 gate can pass | high |
| ZSB-70 | Contract: `business-planning.md` | high |
| ZSB-71 | Contract: `portal-integration.md` (ZAB to ZSB) | high |
| ZSB-72 | Contract: `mobile-activation.md` | medium |
| ZSB-73 | Connections revision: one login, no passwords, QuickBooks boundary | medium |
| ZSB-74 | Content studio: ideas, calendar, film list, scripts, teleprompter | medium |
| ZSB-75 | Research: phone device and speech spike | medium |
| ZSB-76 | Research: direct publishing to Instagram, TikTok and X | medium |
| ZSB-77 | Research: Shopify catalog write tier | medium |
| ZSB-78 | Research: phased pricing and revenue share | low |
| ZSB-79 | Research: one MCP for every tool | medium |
| ZSB-80 | Research: site analytics and approved A/B tests | low |
| ZSB-81 | Grill: D-1 to D-8 | urgent |
| ZSB-82 | Reference study: OS1 voice companion and generative UI (`docs/reverse/os1-her.md`) | high |
| ZSB-83 | Contract: `companion.md` (talk home, card catalog, phrase match, swipe, team view) | high |

Order: ZSB-81 first (it unblocks ZSB-69, ZSB-71 and ZSB-77), then the Stage 0 base as
`direction.md` orders it, with ZSB-69 and ZSB-71 alongside because the Jan 14 launch depends on
them.
