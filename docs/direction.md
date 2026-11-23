# Direction

Status: proposed direction, written against `main` at `725cc86`. It judges the earlier decisions
in this repo; it does not take them as fixed. Order comes from evidence gates. This file holds no
time estimates. A numbered rule still lives in `docs/requirements/`; this file says which of those
contracts matter now and in what order. The ordered ticket list is `docs/backlog-priority.json`
(ids B01 to B26). It covers stages 0 and 1 and one close-out; tickets for stage 2 and later are
written when the stage before them nears its gate.

The end goal and the verdict on every idea from the 2026-11-22 product recording (one phone
interface, hundreds of agents, one password) are in `docs/vision.md`. Read it first. Where it
names an open decision (D-1 to D-5), this file stays as written until Devin decides.

## 1. North star

A person who starts or runs a small business opens the product on a phone, says or types what
they want, and taps to approve. A team of AI agents sets the business up, answers customers,
finds new ones and keeps the records. The owner does only the steps that need a human: a
decision, a signature, an identity check, a release of money.

**The user** is any new or small business owner. They have a phone, little time and no staff.
They are not technical. They do not know which agent does what, and they should not need to.

## 2. What the product is, and is not

**It is:**
- One system of record for a small business: customers, pipeline, bookings, inbox, site and
  the log of every action.
- A team of agents that work on those records. Each agent has one job, its own limits and its
  own record.
- A phone screen where the owner sees what happened, what needs them and what comes next.
- A setup path that takes a person from "I have an idea" or "I have a business with no
  system" to a working business profile, booking page, pipeline and inbox.

**It is not:**
- A tool that acts without the owner knowing. Every agent starts at "draft, the owner approves".
- A bank, a payment processor, a law firm or a tax preparer. It links to those and tracks the
  step. It never holds customer funds and never stores tax identifiers.
- A lead seller. It makes no promise of customers or income.
- A product for one business type. The base is neutral; a template carries the type.

### Trust and approval model

The repo's action path already enforces part of this (`README.md`, "Actions";
`docs/requirements/approvals.md` A-1 to A-14). The direction makes it the rule for every agent.

**First version: every agent works at "draft, the owner approves".** No agent sends anything
on its own.

| Agents may do alone | Needs one owner tap on the exact action | Not in the first version | Human only, outside the product |
|---|---|---|---|
| Read, sort, label, summarise | Each email to a customer, one approval per message | Outbound SMS started by an agent | Releasing a payment or refund (at the provider) |
| Draft a reply, post or plan | Publishing a site or a public post | Outbound AI calls | Signatures, identity checks, bank and processor sign-up |
| Propose a time, prepare a brief | Any change to customer data from an outside source | Batch or cold outreach by an agent | Choice of entity, tax elections, contract terms |
| Stop itself on doubt | Connecting or changing an outside account | Sends under a standing template approval as an agent power | Legal, tax, insurance or medical advice |

The repo already has standing template approvals (`approvals.md` A-15), SMS templates and an
outreach sequencer. They stay as built for the tenants that use them. They are not powers of
the new team until their own gates open: standing-template sends at stage 4, batch email at
stage 3 with a card that lists every recipient and every rendered message.

Fixed rules:
1. An approval binds one exact action: the recipient's address, the text, the amount, the time.
   A change voids it, and the server checks again right before it acts (`approvals.md` A-10).
   **Gap today:** a send approval binds the contact ID and the wording, not the address. The
   worker sends to the contact's current address (`packages/core/src/delivery/policy.ts`,
   `deliveryContentDigest`; `packages/core/src/delivery/worker.ts`, `recheck`). Ticket B03
   closes this before any new agent ships.
2. Money is read-only. An agent may show a balance and prepare a note. The owner releases money
   in the provider's own screen.
3. Caps, quiet hours, suppression lists and kill switches are code outside the model
   (`docs/requirements/agents.md` G-3 to G-5; `docs/requirements/delivery.md` D-6, D-9). One
   model budget per company sits above the per-agent caps (B11).
4. Text from an email, a web page, a file or a call is data, never an instruction
   (`docs/integrations.md`, rules).
5. Voice can ask, draft and pause. It cannot approve a recipient, an amount or a binding term.
   Those go to a screen.
6. Every action leaves a redacted receipt the owner can read (B05).
7. A stop halts tasks and sends that are queued but not yet sent (B12).
8. A task type earns more freedom only from release tests and a measured record, and only when
   the owner agrees. Any incident returns it to "draft, approve".
9. No agent approves its own work. A different check verifies it.
10. The owner can export their records and delete them (B13, B14).

## 3. The AI team: first real version

Six seats. The owner talks to one of them (the Chief of Staff); the others receive typed tasks.

| Seat | Job | Repo modules it uses | State today |
|---|---|---|---|
| **Chief of Staff** | Takes the owner's request, turns it into tasks, writes the briefing, runs the approvals queue | `packages/core/src/home`, `packages/core/src/approvals`, `packages/core/src/agents` (runs, switches, cost) | No orchestrator, no task record, no command entry. `agents.md` rules out "an agent org chart or agent-to-agent delegation" |
| **Assistant** | Sorts the inbox, drafts replies, proposes times, chases open loops | `packages/core/src/inbox`, `packages/core/src/intake`, `packages/core/src/booking`, `packages/core/src/calendar` | One narrow agent drafts follow-ups to unanswered website requests (`agents.md` G-1 to G-13). Inbound email is a contract only (`docs/requirements/inbound-email.md`) |
| **Sales and follow-up** | Moves leads through the pipeline, follows up, prepares proposals | `packages/core/src/crm`, `packages/core/src/deals`, `packages/core/src/outreach`, `packages/core/src/enrichment` | CRM and pipeline built. The outreach sequencer exists only for tenants on an allowlist with operator-connected mailboxes (`docs/requirements/outreach-sequencer.md` OS-1, OS-2) |
| **Front desk** | Booking page, reminders, review requests, missed calls | `packages/core/src/booking`, `packages/core/src/templates`, `packages/core/src/voice`, `packages/core/src/delivery` | Booking, self-service links and templated reminders exist. Missed-call text-back has a first slice. The voice receptionist is not built |
| **Marketer** | Site, newsletter, posts | `packages/core/src/sites`, `apps/site-worker`, `packages/core/src/images` | Site publishing built. Marketing email and social publishing are contracts only |
| **Bookkeeper (view)** | Shows money in, money due and what to release | `packages/core/src/home` (results), `packages/core/src/connections` | Home shows leads, bookings and revenue from deals. No money view, no read of a payment provider for the tenant's own sales |

A seventh role, the **Setup guide**, runs once at the start (section 6, stage 2). It is a
workflow more than a standing seat.

## 4. Fit check

"Foundation" means the first version cannot work without it. "Later" means it is good and it
waits for a named gate. "Park" means stop adding to it until a stage calls for it; nothing is deleted.

| Module or contract | Verdict | Reason |
|---|---|---|
| Action path, idempotency, outbox (`README.md`) | Foundation | It is the trust layer. Every agent acts through it |
| Tenancy, RLS, members (`AGENTS.md` hard rules) | Foundation | Built and tested. Missing only the public door |
| `approvals.md` | Foundation | Approvals bind the action and wording. They do not bind the address, and there is no single queue screen |
| `agents.md` | Foundation, needs a revision | Good controls. Scope is one agent kind family; the goal needs seats and tasks |
| `inbox-home.md` | Foundation | Inbox is where triage lands; Home becomes Today |
| `business-profile.md` | Foundation, needs a revision | Holds name, description and services. Hours, tone, policies and provenance are missing |
| `industry-templates.md` | Foundation, needs a general template | Four types only; a business outside them has no path |
| `crm.md`, `booking.md`, `booking-customer.md`, `booking-self-service.md`, `public-intake.md` | Foundation | Built. The seats work on these records |
| `delivery.md`, `resend.md` | Foundation | Every send goes through consent, suppression and the outbox |
| `connections.md`, `google-calendar.md` | Foundation | The owner connects accounts once; agents use scoped access |
| `apps/dashboard` (phone-first PWA, six areas) | Foundation | The mobile shell exists and is tested at 390x844 (`apps/dashboard/README.md`) |
| `inbound-email.md` | Foundation, not built | The Assistant cannot triage mail it cannot see |
| `transcription.md` | Later, re-scope | Built for voicemail on a local worker. Owner voice needs a hosted path |
| `plans.md`, `stripe.md` | Later | Billing works. A tenant with no plan is comped and several PL-1 limits are not enforced (`plans.md`, Known limits); allowances come before public sign-up (B08). Reset the catalog after cost per active account is measured |
| `hub-access.md`, `activepieces.md`, `packages/mcp` | Later | A way for outside agents to plug in. The built-in team comes first |
| `twilio.md`, `voice-receptionist.md` | Later | Gate: inbound email and triage work, consent flow reviewed, a hosted media host exists |
| `marketing-email.md`, `social-publishing.md` | Later | Marketer seat, after the first three seats pass their gate |
| `outreach-sequencer.md` | Later | Cold outreach is the highest-risk contact. Gate: self-serve mailbox connect and batch approval cards |
| `enrichment.md` | Later | Useful to Sales; not base |
| `conformance.md` | Keep as a practice | Extend the matrix to each contract a stage touches |
| `document-intake.md` | Park | Serves catalog businesses only. Finish the open bug, add nothing |
| `image-port.md` | Park | Product photo variants. Not on the path to the first team |
| `browser-tasks.md`, `services/browser-runner` | Park | Runs on one pilot machine; cannot serve every tenant |
| Shopify native tier and embedded page (`connections.md` C-18 to C-30) | Park after the listing review | One business type. Keep it working; add nothing |
| `docs/future/discovery.md` | Park | A second product for stores with a catalog |
| `docs/build-vs-buy.md` | Revise | "Self-build as much as we can" pulls work away from the base. Keep what is built; build new commodity parts only when a stage needs them; always integrate regulated parts |

### Where the repo points away from the goal

1. **No public door.** Supabase sign-ups are off (`apps/api/README.md`, "Hosted deploy" notes)
   and an operator script creates each tenant (`industry-templates.md`, scope). A person
   starting a business today cannot get in. The only self-serve path is a Shopify install.
2. **No team.** There is one drafting agent, and hosted deploys run it with no model provider
   (`README.md`, "Off until their settings exist"). The contract excludes an org chart.
3. **No voice and no command entry.** The dashboard has no microphone input and no place to
   type a request. The specced voice work answers callers; it does not listen to the owner.
4. **Approvals are scattered and do not bind the address.** The API lists approvals
   (`approvals.md` A-11) but the dashboard shows them inside Inbox, Agents, Customers and Site,
   and a send goes to the contact's current address, not the one approved.
5. **No setup for a new business.** Setup today is "pick one of four templates". Nothing
   interviews the owner, and nothing tracks the human steps (registration, bank, payments).
6. **Pilot-machine workers.** Transcription, browser tasks and the receptionist are designed
   to run on one Mac (`docs/integrations.md`). That cannot serve any business.
7. **Breadth before base.** Recent work went to the Shopify listing, billing edge cases, site
   publishing tokens and document intake. Each is sound. None moves a new owner closer to a
   working team on a phone.

Where this file differs from the master plan: the plan suggests an outside CRM. The repo
already has a tested CRM, booking and inbox on the action path, so they stay the system of
record. The plan's discipline of proving one flow end to end before widening is adopted in full.

## 5. The foundation

Everything else depends on these. Each has a check and its tickets.

| # | Capability | Done when | Tickets |
|---|---|---|---|
| F1 | **Identity and tenancy with a public door** | A new person signs up on a phone, gets a tenant as owner with enforced allowances, and lands on setup. No operator runs a script. A two-tenant denial test covers the path | B08, B09 |
| F2 | **Company facts** | Every agent prompt reads name, services, hours, tone and policies from one read, and each fact shows who set it | B06 |
| F3 | **Minimal setup for any business type** | A fresh owner reaches a published booking page and a pipeline from one phone screen | B07 |
| F4 | **Exact approvals, one queue, receipts** | An approval binds the address and content. One screen lists every pending approval with those values. Every action is readable in one redacted log | B03, B04, B05 |
| F5 | **Agent runtime** | A real model lane runs behind one company budget. Seats and durable typed tasks exist. A stop halts tasks and queued sends. The release checks show zero critical failures | B10, B11, B12, B15 |
| F6 | **Owner control of data** | The owner can export the tenant's records and delete a customer or the tenant under a written retention rule | B13, B14 |
| F7 | **Connections** | An owner connects mail and calendar from the phone. Each seat gets only the scopes its job needs | built for calendar; mail arrives with B19 to B21 |
| F8 | **Inbox and triage** | Customer email reaches the customer's thread. Each waiting thread carries a label and, where useful, a draft that waits for approval | B19 to B21, B23 |
| F9 | **One front door on the phone** | Home shows the briefing, the approvals count and one box to type or speak. An alert tells the owner when something waits | B17, B18, B22, B24 |

## 6. Ordered stages and exit gates

A stage that misses its gate is repeated or changed, not skipped. Each gate result is recorded
in `docs/gates/stage-<n>.md` with its proof.

**Stage 0: Base (B01 to B16, B26).** Stable CI. Address-bound approvals, the queue and the action
log. Company facts and a general setup. Allowances, then public sign-up on preview. The model
lane on preview under one company budget. Seats and durable tasks. Export and deletion.
Release checks. Promotion to production last.
*Exit gate:* the release checks show zero critical failures (stale approval, changed
destination, duplicate, stopped queue, unknown provider outcome, withdrawn consent,
cross-tenant, interrupted session). A person who did not build the product signs up on a phone
on preview, completes the general setup and approves one agent-drafted reply from the queue;
it is delivered once, to the bound address. Cost per agent run is recorded.

**Stage 1: The first team on a phone (B17 to B24).** Command box in text, then voice. Today
briefing. Inbound email in its three contracted slices. A push alert for approvals, before
more than one agent runs unattended. Assistant triage. Every agent stays at "draft, approve";
email only, one approval per message.
*Exit gate:* test owners complete three jobs by phone alone: answer a customer, book or move
an appointment, and stop all agents. Approval accuracy is measured (did they approve what they
thought?). Interrupted sessions resume. Queue load per owner is known.

**Stage 2: Setup for a new business.** A resumable interview by text or voice that fills the
company facts and proposes a template. A checklist of the human steps (registration, tax
number, bank, payments) with official and partner links, with no advice and no stored
identifiers. A Team screen with one tile per seat. Site from the offer.
*Exit gate:* a person with no business system reaches a live booking page, a pipeline and a
working inbox by phone, and the checklist shows each human step as done, waiting or not
needed. Counsel has reviewed the setup wording before any paid offer.

**Stage 3: Growth and money view.** Marketer seat (newsletter, posts). Sales seat with
self-serve mailbox connect and batch email under a full-batch approval card. Bookkeeper
read-only view from a connected payment provider.
*Exit gate:* opt-outs are honoured at once across channels; complaint rate stays under the
set limit; money figures match the provider's record; cost per active account is known at the
median and the high end, and the plan catalog is reset from it.

**Stage 4: Earned autonomy and voice at the front desk.** First task types move from "draft,
approve" to "runs inside limits", standing-template sends among them. SMS to opted-in
contacts. Voice receptionist on a hosted path. More templates.
*Exit gate:* each new power passes its own release checks and a legal review before general release.

## 7. In-flight work

State on 2026-11-22 (ZSB-68). The earlier rows of this table are closed.

| Ticket | State |
|---|---|
| B01, B02 (ZSB-21, ZSB-24) | Done |
| B03, B05, B06, B08, B10, B19 (ZSB-41 to ZSB-46) | Done. Follow-ups are ZSB-53 to ZSB-66 |
| B25 (ZSB-13) | Done |
| ZSB-17 (PDF retention sweep) | Done: Devin shipped document intake to production with the sweep on. Intake stays parked for new scope (ZSB-47, ZSB-48 wait) |
| ZSB-69 (B26) | Open, blocks the Stage 0 gate: Free and Solo have no model agents (`packages/contracts/src/plans.ts`), so a fresh sign-up cannot approve an agent-drafted reply until the entitlement is agreed |
| ZSB-70 to ZSB-83 | Filed from `docs/vision.md`. ZSB-81 (decisions D-1 to D-8) comes first. ZSB-82 is the OS1 companion study; ZSB-83 the `companion.md` contract |
| C-17 (Shopify measurement) | Record the scheduled measurement once, then close. It gates nothing |
