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

This matches the north star in `direction.md` section 1 and widens it in three places: a guided
plan at the start (V-01 to V-07), content and commerce tools for sellers (V-10 to V-21), and a
price that grows with the business (V-22 to V-25).

## 2. The journey

1. **Sign up** on the phone (B09, ZSB-27). Today sign-in cannot create a user
   (`apps/dashboard/src/lib/server/sign-in.ts`, `shouldCreateUser: false`).
2. **Talk.** One tap opens a text or voice intake: "Tell us about yourself, your idea, your
   business." (V-01)
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
| V-01 | Voice-first intake after sign-up | Reshape | No public sign-up (B09). Voice serves only uploaded audio and voicemail (`packages/core/src/transcription`). No owner microphone path | Text first with an editable transcript, then tap-to-talk on the same resumable interview (B17, B24, ZSB-75). Voice never approves a recipient, an amount or a term (`direction.md` rule 5) |
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

## 6. Decisions for Devin

Run as one grill session (ZSB-81). Record each answer here with its date.

- **D-1** The first cohort and its first valuable phone job. Recommended: solo service sellers
  who take bookings, e-commerce second.
- **D-2** One price source: the self-serve price and what the $49 tier includes (model drafts or
  not), trial or money back, phase fees, and whether revenue share is worth counsel time.
- **D-3** Who builds the guided start and customer AEO: ZAB (with ZSB as the control plane) or ZSB.
  What the Jan 14 self-serve flow must do on day one.
- **D-4** Native app or PWA. Decide after the device spike (ZSB-75).
- **D-5** How far the conversion agent may act on a live site without a tap per change.

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
| ZSB-81 | Grill: D-1 to D-5 | urgent |

Order: ZSB-81 first (it unblocks ZSB-69, ZSB-71 and ZSB-77), then the Stage 0 base as
`direction.md` orders it, with ZSB-69 and ZSB-71 alongside because the Jan 14 launch depends on
them.
