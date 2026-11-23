# Business profile

Status: built. First slice 2026-10-23 (PR #48: BP-1 to BP-12, migration
`supabase/migrations/20261023100000_business_profiles.sql`, `packages/core/src/business/handlers.ts`,
`apps/api/src/routes/business.ts`). Revision 2 (2026-11-20, ZSB-4) adds the description and services
fields (BP-13 to BP-15). Revision 3 (2026-11-22, ZSB-43) adds the company facts agents read:
opening hours, a tone of voice note and a short list of policies, each with who set it and when,
and the one read every agent prompt builder uses (BP-16 to BP-21). Code follows this file; a change to a numbered rule needs a new revision of
this file first.

Scope: one profile per tenant that says who the business is: the name customers see, the legal
name, a phone number, a time zone, a default currency, a postal address, a short description of
the business, the list of services it offers, its opening hours, a tone of voice note and its
policies (cancellation, refunds, deposits and the like). The owner edits it
in Account → Settings. Other features read it: the deal value field (BP-8), marketing footers
(`marketing-email.md`), and any screen that needs the business's own day rather than the
viewer's.

Out of scope: per-location profiles, tax settings, logos and brand colours, booking
availability (the booking resources keep their own zone and availability, `booking.md`; the
opening hours of BP-16 are a fact agents quote, never what a booking checks), and changing the
wallet currency (fixed by its first credit, `stripe.md`).

## Evidence and decisions

- Audit 2026-10-22 (U1/U2 visual reviews, U2 follow-ups): the Settings screen shows "Business
  name" and "Time zone" fields that save nothing, because no settings route and no business time
  zone exist. `tenants` holds only `tenant_id` and `name`
  (`supabase/migrations/20261017150322_shared_actions.sql:28`). Fix PR #42 made the screen say
  plainly that nothing saves; this contract replaces that with a real profile.
- Audit V-20: the deal dialog takes Currency as free text next to real selects. Currency
  becomes a select of ISO 4217 codes, defaulting to the business profile's currency: decided
  2026-10-22 (coordinator, standing approval).
- `crm.md` C-14 and `inbox-home.md` H-1 already require deal currencies to be ISO 4217 codes and
  refuse to move a deal stored under another code (`invalid_currency`). This contract keeps that.
- Time zones follow the booking resources' rule: `UTC` or an IANA name the database knows
  (`booking_resources_time_zone_known`, `supabase/migrations/20261018090000_function_hardening.sql:10`).
- Deploy order: the API and the dashboard deploy on their own. `GET /v1/me?include=profile`
  (PR #42) showed the pattern: new response fields are opt-in or optional, and readers ignore
  unknown keys, so either deploy order works (BP-10).
- `marketing-email.md` needs a postal address before any marketing send; the profile is where
  it lives.

## Rules

**BP-1. One row per tenant.** `business_profiles(tenant_id PK → tenants, display_name,
legal_name, phone_e164, time_zone, currency, postal_address jsonb, revision, updated_by,
updated_at)` with forced RLS by `tenant_id`. The row is created with the tenant: `display_name`
copies `tenants.name`, `currency` is `USD`, every other field is null and `revision` is 1. A
migration backfills a row for every existing tenant.

**BP-2. Field shapes.** `display_name` 1..120 characters after trimming. `legal_name` null or
1..200. `phone_e164` null or an E.164 number (`+` and 8..15 digits). `time_zone` null or a zone
BP-3 accepts. `currency` a three-letter ISO 4217 code BP-4 accepts. `postal_address` null or
`{ line1, line2?, city, region?, postalCode?, country }` with `country` an ISO 3166-1 alpha-2
code and each line 1..120 characters. Text passes the repo's Postgres text check (no NUL, no
lone surrogates). A value outside these shapes is `ValidationFailed` with the field's path.

**BP-3. Time zone.** `UTC` or an IANA name in `pg_timezone_names`, checked by a trigger as
booking resources are. Null means "not set": screens then use the viewer's zone for display and
booking resources keep their own zone. Setting it never changes a resource's zone, a booking, a
quiet-hours setting or a stored instant.

**BP-4. Currency.** An active ISO 4217 code from one list shared by the contracts package and
the dashboard (`packages/contracts/src/currency.ts`, generated from a pinned ISO list, not from
the runtime's `Intl`), so the API and every browser agree. Changing it changes only the default
for new values (BP-8); it never converts or rewrites a stored amount, a deal value or the
wallet.

**BP-5. Read.** `GET /v1/business` returns the profile and its `revision` to any member of the
tenant (staff need the time zone and currency to work the calendar and deals). `phone_e164` and
`postal_address` are included; nothing else about the tenant is.

**BP-6. Write.** `business.profile.update` with `{ expectedRevision, changes }`, where `changes`
holds only the fields being set (a field set to null clears it, except `display_name` and
`currency`, which cannot be null). Owner only: it needs a new `business` permission that
staff do not hold (`packages/contracts/src/members.ts`). It runs through the dispatcher with an
idempotency key like every action, so a replay returns the first result.

**BP-7. Compare and set.** The update applies only when `expectedRevision` equals the stored
revision, then increments it. Otherwise it is `Conflict` with `details.reason =
"stale_revision"` and `details.currentRevision`, and the dashboard reloads the saved values and
says someone else changed them, as the deal dialog does.

**BP-8. Currency select (audit V-20).** The deal dialog's Currency field is a select of the
BP-4 codes, labelled with the code and its English name ("EUR · Euro"). A deal with no value
starts at the profile's currency; a deal with a value shows its stored currency. A stored code
that is not in the list (an old deal) shows as an extra option marked "not supported", and
saving a value under it is refused, matching C-14's `invalid_currency`.

**BP-9. Display name.** `display_name` is the name the dashboard header, the account menu and
`GET /v1/me?include=profile` show as `businessName`. Updating it also updates `tenants.name`
in the same transaction, so older readers see the same name.

**BP-10. Deploy order.** New response fields are optional for readers; the dashboard treats a
missing `GET /v1/business` (404 from an older API) as "profile not available yet" and keeps the
Settings form read-only with that reason. The API never requires a field an older dashboard
does not send.

**BP-11. Demo mode.** The demo adapter stores the profile in its in-memory store, so Save
works there and says it is sample data that resets, never "saved to your business".

**BP-13. Description.** `business_profiles.description` is null or 1..2000 characters, not blank,
passing the same text check as BP-2. Null means "not written yet". It is set and cleared through
`business.profile.update` like every other field (`changes.description`, null clears), so
BP-6's owner-only permission, BP-7's compare and set and the idempotency key all apply. A new
profile row starts with a null description; the migration adds the column and changes no row.

**BP-14. Services.** `business_profiles.services` is a JSON array of 0..20 service names (the
column is `jsonb NOT NULL DEFAULT '[]'`). Each name is 1..80 characters after trimming, has no
leading or trailing whitespace and no control characters, and no two names match when compared
without regard to case. A database CHECK enforces the count and the length, and the contract
schema enforces the rest with the field's path in `ValidationFailed`. `changes.services` replaces
the whole list (an empty list clears it); it never merges. The list is free text for the owner
and customers to read: it is not a booking resource, a price list or a template, and it does
not create or rename a resource.

**BP-15. Read and write notes.** `GET /v1/business` returns `description` and `services` to
every member, like the other fields (BP-5). The runtime role may `UPDATE` only the columns the
action writes: the migration grants `UPDATE (description, services)` to `authenticated` beside
the existing column grants, and the table keeps forced RLS by `tenant_id`. An older API that
does not send the fields is read as `description: null` and `services: []` by the dashboard
(BP-10), and a `business.profile.update` saved before this revision replays with them empty
(the stored result is upgraded on replay, never rewritten). The MCP `get_business` tool is read-only and returns the new fields; there is no MCP
write tool for the profile, so none is added for them.

**BP-16. Opening hours.** `business_profiles.hours` is null (not known) or a JSON object with all
seven days `mon`..`sun`. A day is null (closed) or `{ open, close }` in 24-hour `HH:MM`, with
`open` before `close`; `close` may be `24:00` for midnight. One range per day. At least one day is
open, so "closed every day" is never stored in place of "not known"; the Settings form saves
null when every day is off. The form never fills in times: a day the owner turns on starts blank,
and both times are required. Days left off are saved as closed, and the form says so.

**BP-17. Tone of voice.** `business_profiles.tone` is null (not known) or 1..500 characters, not
blank (whitespace alone is blank): how agents should sound when they write for the business.
The form asks owners to leave customer details out of the tone and the policies, since agents
read them.

**BP-18. Policies.** `business_profiles.policies` is a JSON array of 0..10 policies, each a
one-line title of 1..60 characters and a text of 1..1000, trimmed, titles unique ignoring case.
`changes.policies` replaces the whole list as `[{ title, text }]` (an empty list clears it). A
policy whose title and text are unchanged keeps its stored mark; any other policy gets the mark
of this save. Settings shows each saved policy's own mark under it.

**BP-19. Who set a fact.** Every company fact carries a mark `{ setBy, setAt, revision }`: the
member ID of the owner who saved it, the action's clock instant and the profile revision that
save made. `fact_marks` holds the mark of each fact's last change, keyed by field (`displayName`,
`description`, `services`, `timeZone`, `hours`, `tone`, `policies`); each policy also carries its
own mark. A save marks every fact whose value it changed, clearing included, so a mark can sit on
a fact that reads as not known: it records who cleared it. A change to `hours`, `tone` or
`policies` without a new mark is refused (BP-20). Any other marked fact that changes without its
mark (a setup step writing the time zone, or an operator script) loses the mark: the value
stays, and who set it reads as not recorded. The trigger runs on insert as well as update.
`GET /v1/business` returns `hours`, `tone`, `policies` and `factMarks`.

**BP-20. The owner is the only writer.** The action needs the `business` permission, which only
owners hold (BP-6). The database enforces it too: a trigger refuses any new or changed mark or
policy whose `setBy` is not an owner member of the same tenant, and any change to hours, tone or
policies that carries no new mark, with `check_violation` `business_profiles_fact_owner`. So a
direct write as the runtime role cannot set, change or clear those facts unmarked, or in a staff
member's name or another tenant's. The database has no actor setting and cannot tell which owner
is acting; the action stamps the acting owner's own member ID. A malformed `fact_marks` or
`policies` value fails its own CHECK (`business_profiles_fact_marks`,
`business_profiles_policies`), which match the contract: marks need a UUID, an instant with
milliseconds and a whole revision from 2.

**BP-21. One read for agents.** `readCompanyFacts(tx, tenantId)` in `packages/core/src/business`
is the only way an agent prompt builder reads the business: it returns the name, description,
services, time zone, hours, tone and policies. Each single fact is `{ status: "known", value,
setBy, setAt }` or `{ status: "not_known" }`; policies are `{ status: "known", value }` with the
list of policies, each carrying its own `setBy` and `setAt`, or not known. A null value or an empty
list is not known, whatever mark it carries; a fact with no mark is known with null provenance.
`companyFactsForPrompt` turns it into the prompt form, where a missing fact is the words `not
known`, and every system text of a prompt that carries company facts carries `COMPANY_FACTS_RULE`,
which tells the model never to guess a fact that is not known. A prompt with no business in it
(the browser planner) carries neither. Provenance stays out of the prompt. A static test in
`packages/core/test/company-facts.test.ts` finds every prompt builder in core (a `TextModelRequest`,
a `system` text, a `.complete(` call or a `*Prompt` input) and fails when the builder, or a
helper it imports from its own feature folder, reads `business_profiles`, the tenant's name or
`getBusinessProfile` in any other way, or when a builder puts the facts in a prompt without the
rule. The dashboard checks each fact the API sends: when an older API sends none, or a newer one
sends a shape it does not know, the facts read as not known, Settings shows them read-only, and a
save never sends them, so it cannot wipe facts it did not see (BP-10). A save stored before this
revision replays with them empty.

**BP-12. Tenancy.** A member of tenant A cannot read or update tenant B's profile through the
route, the action or direct SQL as the runtime role: a two-tenant denial test covers all three.

## First slice

Migration (`business_profiles`, backfill, time zone trigger, RLS), the currency list in
contracts, `GET /v1/business`, `business.profile.update` with the `business` permission, the
Settings form wired to both, and the deal dialog's currency select.

Acceptance test: an owner saves legal name, time zone `Europe/London` and currency `EUR`; the
response carries revision 2 and `GET /v1/business` returns the values. A second save with
`expectedRevision: 1` is `Conflict` `stale_revision` with `currentRevision: 2`. A staff member's
save is 403. Time zone `Mars/Base` and currency `XXZ` are `ValidationFailed` with their paths.
A new deal's currency select starts at `EUR`; an existing USD deal still shows USD. Tenant B
cannot read tenant A's profile. The dashboard e2e saves the form in demo mode and the Home
header shows the new display name.

Acceptance test for revision 2: an owner saves a description and three services in one
`business.profile.update`; the response carries the next revision and `GET /v1/business` returns
both for the owner and for staff; a replay with the same key returns the first result; a
description of 2001 characters, a blank description, two services that differ only by case and a
21st service are `ValidationFailed` with their paths; staff are 403; tenant B reads
`description: null` and `services: []` and cannot update tenant A's row as the runtime role.

Acceptance test for revision 3: an owner saves hours, a tone and two policies; the response marks
each with the owner's member ID, the save's instant and revision. A second owner who changes one
policy and the tone marks only those; the unchanged policy keeps the first mark. Clearing the
tone marks who cleared it, and the tone reads as not known. Staff are 403. As the runtime role, a
direct update of hours, tone or policies without a new mark, or whose mark names a staff member,
an unknown member or a member of tenant B, is refused with `business_profiles_fact_owner`, and
tenant B cannot read or update tenant A's facts. The
follow-up draft prompt and the template suggestion prompt both read the facts through
`readCompanyFacts`, with `not known` for each missing fact. The dashboard e2e, at phone width,
turns on Monday, types its times, sets a tone and adds a policy; after the save each shows "Set by
an owner".

## Known limits

- Booking availability and per-location details stay on booking resources; the opening hours
  are one range per day, with no breaks, holidays or seasonal hours.
- The Settings screen says "Set by an owner" and the date; it does not yet name which owner.
- The database cannot tell which owner is acting (there is no actor setting), so a direct write
  as the runtime role could name another owner of the same tenant. The action always stamps the
  acting owner.
- The template suggestion runs on the `no_personal_data` lane and carries the description, tone
  and policies as the owner wrote them. The form asks owners to keep customer details out; it does
  not check.
- Rolling the API back past this revision: an older API refuses a retried save that names the new
  fields, and replays a stored result with the new keys only if its reader accepts extra keys.
- Changing the profile currency does not touch the wallet; a tenant whose wallet is in another
  currency sees prices in the wallet's currency (`delivery.md` D-5).
- The Home screen still shows the viewer's zone for dates; moving business-day logic (for
  example "today" on Home) to the profile zone is a later revision of `inbox-home.md`.
