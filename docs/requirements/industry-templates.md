# Industry templates

Status: contract, revision 2 (2026-11-07). Approved by delegation: Devin asked for an autonomous
overnight build "suitable for all of the 4 starting industries" (2026-11-07) after naming them on
2026-11-06; Devin confirms or revises this file on review. Code follows this file; a change to a
numbered rule needs a new revision first. Revision 2 applies the spec review by GPT-6.1 Sol and
Gemini 4 Argon (both returned 7 BLOCK on revision 1; see "Changes from revision 1").

Scope: a new business picks what kind of business it is, and the Hub sets up its operating system
for that kind: a sales pipeline with the right stages, one bookable appointment type with
sensible hours, a public booking page, reminder and review-request wording, and the connections
worth making first. Four templates ship: jewelry (custom and bridal work), ceramics and other
crafts (commissions), AI and business agencies, gyms and personal trainers (winning new clients
and booking their first session). One owner action applies a template; it is fast, idempotent
and runs in one transaction. The owner can then take the booking page live or off line, and
create deals from the dashboard. An owner-run script creates a tenant and its first owner, so
Zero Sum Solutions becomes tenant 1 and Devin picks the agency template on first sign-in.

Out of scope: editing a template after it is applied, switching templates, editing resource
hours or adding closures (later revision), several appointment types per business (needs shared
capacity, later revision), custom fields or tags, marketing campaigns (consent-controlled
review requests are in scope), products or catalog seeding, memberships, classes or recurring
bookings, agent auto-enable (agents stay off until the owner turns them on), brand profiles,
sample contacts or deals in a real tenant, changing the demo seed (`seed:demo` keeps its own
data), and any vertical integration beyond the connections catalog (`connections.md`).

## Evidence and decisions

- Devin, 2026-11-06 (`~/Inbox/plans/_unassigned/2026-11/2026-11-06-hub-architecture-decision.md`,
  "Devin's decisions"): curate the OS to the business to reduce decision fatigue; first goal is
  making the client money; scale to thousands of businesses, so every per-tenant step must be
  cheap; first verticals jewelry, ceramics and other crafts, AI/business agencies (Zero Sum is
  tenant 1), gyms and personal trainers.
- Inventory 2026-11-07: no tenant has a type; there is no tenant-creation flow and no first-run
  screen; pipelines, stages, booking resources and booking pages are written only by the demo
  seed, never by an action; the runtime role has SELECT only on those tables; no action publishes
  a booking page; fresh business profiles have a NULL time zone; `crm.deal.create` exists in core
  and the API but the dashboard has no way to call it; the dashboard depends on `@zs/contracts`
  only.
- Booking locks and the overlap constraint are per resource, so two resources for one person can
  be double-booked. Revision 2 ships exactly one resource per template.
- Decided (driver): templates are code, not rows, and live in `@zs/contracts` so the API and the
  dashboard read one copy. A catalog read costs nothing per tenant; a template change ships as a
  reviewed diff with a version bump.

## Numbered rules

- **IT-1 Catalog.** `packages/contracts/src/templates/industry.ts` exports `INDUSTRY_TEMPLATES`, a
  frozen record keyed by template id: `jewelry`, `crafts`, `agency`, `fitness`, and a zod schema
  that a test runs over every template. Each template has `id`, `version` (integer >= 1),
  `label`, `summary` (one sentence an owner reads), `pipeline { name, stages[] }`, `resource`
  (one), `bookingPage { title, description, disclosureText }`, `messages` (one per recommended
  agent), `recommendedConnections` and `recommendedAgents`. Schema rules: 3..8 stages, exactly
  one `won` and one `lost`, the last two in the order won, lost; the resource's weekly hours,
  slot length, step, buffers, notice and horizon pass the existing booking-resource validation;
  each message passes `parseTemplateDraft` for its agent kind; recommended connections come from
  the connections catalog ids or `google_calendar`.

- **IT-2 Contents.** Revision 2 contents (wording may be polished in code; structure may not
  change without a revision):

  | Template | Pipeline (stages; won, lost) | Resource (slot minutes) | Booking page title |
  |---|---|---|---|
  | jewelry | "Custom & bridal": Inquiry, Consultation, Design approved, Deposit paid, In production; Delivered, Lost | Consultation (45) | Book a consultation |
  | crafts | "Commissions": Inquiry, Quote sent, Deposit paid, In the studio; Delivered, Lost | Studio visit (30) | Visit the studio |
  | agency | "Client pipeline": Lead, Discovery call, Proposal sent, Negotiation; Won, Lost | Discovery call (30) | Book a discovery call |
  | fitness | "New clients": Lead, Intro booked, Intro done, Offer made; Signed up, Lost | Free intro session (30) | Book a free intro |

  Hours: jewelry and crafts Monday to Friday 09:00 to 17:00 and Saturday 10:00 to 16:00; agency
  Monday to Friday 09:00 to 17:00; fitness Monday to Friday 06:00 to 20:00 and Saturday 08:00 to
  14:00. Slot step 15 minutes for all. Buffers 0 before and 15 after for jewelry, crafts and
  fitness; 0 and 0 for agency. Minimum notice 12 hours (fitness 2 hours); horizon 60 days.
  Page descriptions say where the appointment happens: jewelry and crafts "at our studio, or by
  video if you ask in your note"; agency "by video call; we email the link before the call";
  fitness "at the gym; wear training clothes". Messages: `appointment_reminder` by email 24 hours
  before; `review_request` by email 24 hours after the appointment, worded about the visit, not a
  delivered product. Recommended connections: jewelry and crafts `shopify` then
  `google_calendar`; agency and fitness `google_calendar`. Recommended agents:
  `appointment_reminder` for all; `review_request` for jewelry, crafts and fitness.

- **IT-3 Setup record.** Migration adds `public.tenant_setups` (`tenant_id` PK and FK to tenants,
  `template_id text NOT NULL` checked against the four ids, `template_version integer NOT NULL
  CHECK (template_version >= 1)`, `action_id uuid NOT NULL` FK `(tenant_id, action_id)` to
  `actions`, `applied_at timestamptz NOT NULL`). No FK to `tenant_members`, so removing a member
  stays possible. RLS forced; `authenticated` may SELECT its tenant's row and INSERT it;
  `service_role` may SELECT and INSERT (fixtures); nobody may UPDATE or DELETE. The table joins
  `packages/db/test/tenant-tables.ts` with valid fixture values and gets a two-tenant test under
  the runtime role: tenant B cannot read, insert for, or reference tenant A, and UPDATE and
  DELETE fail for runtime and service.

- **IT-4 Apply action.** `tenant.template.apply { templateId, timeZone }` is a member action
  through the dispatcher, permission `business` (owners only; staff get 403), idempotency key
  `template:<templateId>` reserved by the server (`template:` joins `SERVER_IDEMPOTENCY_PREFIXES`)
  and listed in `NEVER_APPROVED_ACTIONS`. `timeZone` is an IANA zone. In one transaction it: sets
  the business profile's time zone when it is NULL (an existing zone wins, and the resource uses
  the profile's zone); inserts the setup row, the pipeline and its stages, the resource, the
  booking page (published) with its resource link (the existing disclosure trigger writes the
  first disclosure version), and, for each recommended agent whose message template the tenant
  lacks, the template and its first revision together (deferred FK) with no standing approval;
  then writes the action and outbox rows like every action. It never overwrites or deletes an
  existing record. The migration grants `authenticated` the INSERT (and, for the profile zone,
  UPDATE of `time_zone`) privileges this needs, under the existing forced tenant RLS.
  Replays: the API reads the setup row before dispatch. Same template already applied: 200 with
  `replayed: true` and the stored result, for any owner, with no new rows. Different template:
  409 `template_already_applied`. A concurrent second apply that loses (PK violation or the
  dispatcher's binding mismatch on this key) gets the same answers. Unknown id: 404. The page is
  published at apply because the owner has just confirmed the exact hours on the preview (IT-7);
  IT-11 takes it off line.

- **IT-5 Efficiency.** The apply handler issues at most 10 `tx.query` calls of its own (counted
  inside the handler, excluding the dispatcher's calls and transaction scaffolding), whatever the
  number of stages or messages (multi-row inserts), and reads no catalog rows from the database.
  A test counts them. A timing test applies all four templates to four fresh tenants after one
  warm-up apply on the local test database and asserts under 2 seconds in total; the query-count
  test is the hard gate.

- **IT-6 Read.** `GET /v1/setup` returns `{ applied: null | { templateId, templateVersion,
  appliedAt, bookingPageId, published }, timeZone: string | null, templates: [preview] }` for any
  member, where each preview is resolved: pipeline name and stages, the resource with its hours,
  step, buffers, notice and horizon, booking page title, description and disclosure text, message
  subjects and timing, recommended connections and agents. `POST /v1/setup/apply { templateId,
  timeZone }` runs IT-4. `setup` joins both the single-segment and multi-segment route lists in the
  dashboard API proxy.

- **IT-7 Dashboard first run.** `/setup` shows the four templates as cards (label, summary, stage
  list, appointment type and hours, booking page title, recommended connections). The owner picks
  one, sees the full resolved preview, confirms or changes the time zone (prefilled from the
  profile, else the browser), and confirms; on success the dashboard goes to Home. While the
  tenant has no setup row, Home shows one line linking to `/setup` for owners and "Your owner
  hasn't finished setup yet" for staff. Staff see `/setup` read-only. After apply, `/setup` shows
  the applied template, the booking page link with its live or off-line state, a line that agents
  stay off until turned on in Agents, and links to Calendar, Customers, Connections and Agents.
  The demo adapter supports both states. Copy follows the dashboard's existing plain style.

- **IT-8 Recommended connections.** After apply, the connections screen lists the template's
  recommended connections first, in template order, with a "Recommended for <label>" line. A
  recommended id that the catalog does not offer in this environment is left out. Nothing
  connects automatically.

- **IT-9 Owner-run tenant creation.** `pnpm --filter @zs/api tenant:create --key <slug> --name
  <name> --owner-email <email> [--time-zone <zone>] [--dry-run]` (local) and
  `db:hosted-tenant-create` (hosted; adds `--apply --backup <file> --receipt <file>` and the
  checked target and runtime connections of `hosted-provision-owner`) create the tenant row with an
  id derived from `--key`, set the business profile's time zone when given, and provision the
  owner (`provision-owner.ts`, pending until first sign-in). They do not apply a template: the
  owner does that at `/setup` after first sign-in. Each phase checks what exists, so a rerun
  resumes and replays. A rerun with the same key but a different name or owner email refuses
  before writing anything. `--dry-run` prints the plan and writes nothing. Agents run it locally
  only; the hosted run is owner-run.

- **IT-10 Deals from the dashboard.** A customer's page gets "New deal" (title, optional value),
  which calls the existing `crm.deal.create` path into the first open stage of the tenant's
  pipeline. Existing stage moves then take it to won or lost.

- **IT-11 Booking page on and off.** `booking.page.set_published { pageId, published }` is an
  owner action (permission `business`) that changes only `published`; the migration grants
  `authenticated` UPDATE of that column. `/setup` after apply shows a toggle.

## Acceptance

1. Catalog test: all four templates pass the IT-1 schema; ids, versions and IT-2 contents match.
2. For each template, on a fresh local tenant through the API: apply succeeds as the owner with a
   time zone; the public booking page lists slots on a weekday inside the template's hours,
   starting at the opening time, and none outside; a booking commits; two back-to-back bookings
   are possible where the buffer allows; a deal created through IT-10's path moves through every
   open stage to won; each recommended message template renders with the business's display name
   (rendering only; sending still needs the owner's standing approval).
3. Apply twice replays (no new rows); a second owner's apply of the same template replays; two
   concurrent applies leave one setup, one action and one outbox group; a different template
   answers 409; staff get 403; an unknown id 404; an existing pipeline, resource and page survive
   apply; the IT-3 isolation tests pass.
4. IT-5 query-count and timing tests pass.
5. IT-11: publishing off makes the public page 404; on restores it; staff get 403.
6. Dashboard tests: `/setup` renders four cards, the preview shows hours and time zone, the
   confirm flow applies and lands on Home, the Home line shows only before setup, the staff view
   is read-only, recommended connections are ordered (IT-8), "New deal" creates a deal, the page
   toggle works. A Playwright demo run completes setup for each template.
7. `tenant:create --dry-run` prints the plan; a local run creates "Zero Sum Solutions" (key
   `zero-sum`) with a pending owner; a rerun replays; a rerun with another owner email refuses.
8. `pnpm -r typecheck` and every touched package's suite pass; CI is green on the PR.

## Known limits (revision 2)

- One template per tenant, applied once; one appointment type per tenant; hours cannot be edited
  in the dashboard yet.
- Templates do not create contacts, deals, products, marketing content or agent enablement.
- The demo seed keeps its own pipeline and resources.
- The hosted run of `tenant:create` (Zero Sum as tenant 1 in production) is owner-run.

## Changes from revision 1

One resource per template (cross-type double booking); `timeZone` in apply (NULL profile zone);
runtime grants named; page published at apply plus IT-11 (no publish path existed); IT-10 deal
creation in the dashboard; `tenant:create` keyed by `--key` and no longer applies the template
(a pending owner cannot act); `applied_by` FK replaced by `action_id`; demo seed change dropped;
15-minute step; crafts Saturday hours; message channel, timing and wording; disclosure via the
existing trigger; replay across owners and concurrent applies defined; reserved prefix and
never-approved listing; proxy lists; resolved preview; IT-5 counting boundary; isolation tests
widened; hosted flags.
