# Enrichment: company data for a contact (Treg)

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope (Customers area): an owner asks for the company behind one of the tenant's contacts.
The server calls Treg (a hosted pay-per-call tool gateway) once, pays from the tenant's prepaid
wallet, and turns the answer into proposals; each field reaches the contact only on approval.

Out of scope: person enrichment, email find and verify, bulk search, SEO and social data
(Known limits); EU, EEA and UK contacts; any Treg tool that writes or sends; dashboard screens
beyond E-17's routes; Treg top-ups.

## Evidence and decisions

- `docs/integrations.md`: Treg is "Build: company enrichment only", owned by Customers, step
  4 of the build order. Every spend reserves first (`delivery.md` D-4, D-5, D-11).
- Treg public docs (2026-10-22, our words): `Idempotency-Key` holds 24 hours (replay free,
  409 in flight, 410 unknown); `X-Treg-Route-Max-Cost` refuses dearer routes unbilled; Treg's
  refusals carry `X-Treg-Error: 1`; some providers bill a miss; answers go to a shared public
  archive unless the team turns it off.
- One test call (2026-10-22): a company lookup by domain cost 1,900 micro-USD. Its `output`
  held name, domain, industry, description, employees, founded, location and LinkedIn URL; a
  large `raw` block held much more. Provider prices vary over 100x, so only the cost header counts.
- Repo: contacts hold only a name, an email and a phone
  (`supabase/migrations/20261017170100_crm.sql:14`); the wallet counts integer cents
  (`packages/core/src/wallet/index.ts:9`); an agent principal already inserts approval
  proposals as its own requester (`agents.md` G-1, G-6).
- Archive: Treg's public answer archive is turned off for our team before any call;
  enrichment refuses to run until the repo owner confirms it with a config flag (E-5);
  decided 2026-10-22 (coordinator, standing approval).
- Price: a fixed tenant price per call per op; the Treg route cap header equals that
  price; we absorb billed misses, bounded by the cap (E-8, E-11);
  decided 2026-10-22 (coordinator, standing approval).
- Scope: companies only (`company.enrich`); person enrichment, email find and email verify
  are out, and the allowlist must not contain them (E-2);
  decided 2026-10-22 (coordinator, standing approval).
- Region: no enrichment of EU or UK contacts before a GDPR review; an EU/UK country, phone
  prefix or company ccTLD is refused before any call with a stable code (E-7);
  decided 2026-10-22 (coordinator, standing approval).
- Credential: an org-scoped Treg agent token with a per-call cap, never the owner key (E-1,
  E-5); decided 2026-10-22 (coordinator, standing approval).
- Balance: alert the platform operator, never a tenant, below a $5 Treg balance; no auto
  top-up (E-16); decided 2026-10-22 (coordinator, standing approval).

## Numbered rules

**E-1. Port and token.** All Treg traffic goes through `EnrichmentPort` (`run`, `lookup`,
`balance`, `whoami`, `dedupeWindowMs`) from one call site, the enrichment worker (E-10).
`TregEnrichment` makes one HTTPS `fetch` per call with `X-Treg-Token`, `Idempotency-Key`,
`X-Treg-Route-Max-Cost` and `X-Treg-Meta: tenant=<tenantId>, feature=<op>`. The token is
injected config (`TREG_TOKEN`) read only by the worker. It never reaches a model prompt, the
dashboard, an API response, a table or a log line; a test greps captured logs for it.

**E-2. Allowlist.** `ENRICHMENT_TOOLS` (`packages/core/src/enrichment/tools.ts`) is a frozen
map with exactly one entry: `company.enrich` -> `treg.companies.enrich`. `enrichmentOpSchema`
in `packages/contracts` accepts only `company.enrich`. The adapter refuses any tool id not in
the map before any network call. A test asserts the map's keys and values exactly and that no
value contains `people`, `email` or `search`.

**E-3. Principal and permissions.** Each tenant has one enrichment actor,
`derivedId(tenantId, "enrichment", "actor")`. It is no member and holds no permission. Its
`authorize` admits only `enrichment.attempt.start`, `enrichment.attempt.settle` and
`enrichment.result.record`; every other action is `TenantDenied`, and member sessions cannot
run those three. Its keys start `enrichment:`, which joins `SERVER_IDEMPOTENCY_PREFIXES`. A new
permission `enrich` joins the permission list; owners hold it, staff do not.

**E-4. Request: `enrichment.request`.** Permission `enrich`. Payload `{requestId, op,
contactId}`; target `{type: "enrichment_request", id: requestId}`; the edge mints `requestId`
from the idempotency key; the contact must be in the caller's tenant (`TenantDenied`). The only
Treg input is a domain: the profile's `company_domain` (E-14) when set, else the domain of the
stored email. No email, a placeholder or a consumer mailbox domain (`CONSUMER_MAIL_DOMAINS`:
`gmail.com`, `outlook.com` and the like) is `Conflict` `enrichment_no_company_domain`. Name,
email and phone never leave the server. Once E-5 to E-9 pass, one transaction (runtime role)
inserts `enrichment_requests` (`pending`, with the price) and commits the action with outbox
event `enrichment.requested`. It holds no money: the worker reserves (E-8, E-10). A refusal
writes, calls and spends nothing.

**E-5. Service gates.** A request, and every attempt (E-10), is refused with `Conflict`
`enrichment_unavailable` unless `ENRICHMENT_PROVIDER` is `treg` or `fake`,
`TREG_ARCHIVE_CONFIRMED_OFF` is exactly `true` (set by the repo owner after turning the archive
off; checked for `fake` too) and the kill switch `ENRICHMENT_DISABLED` is unset. The worker also
calls `whoami` at start and daily: while the token's role is `owner`, every attempt is refused
the same way and `treg_token_is_owner` is reported to the operator (E-16).

**E-6. Do not enrich.** `Conflict` `enrichment_blocked` when the profile's
`do_not_enrich_at` is set or the contact's email or phone is suppressed (`delivery.md` D-9,
read each time). `contact.enrichment.block` (permission `customers`) sets the flag with a
reason; `contact.enrichment.unblock` (permission `enrich`) clears it.

**E-7. EU, EEA and UK check.** `ENRICHMENT_REFUSED_REGION`
(`packages/core/src/enrichment/region.ts`) lists the EU 27, the EEA states Iceland,
Liechtenstein and Norway, and the UK with its Crown Dependencies and Gibraltar. From it the code
derives ISO country codes, E.164 calling prefixes (including EU outermost regions such as +262,
+590, +594, +596) and ccTLDs (with `.uk` for GB and `.eu`). Signals, checked in this order:
1. Region signal, refused `enrichment_region_blocked`: the contact's phone starts with a listed
   prefix; or `crm_contact_profile.country` is listed; or the company domain, or the email
   domain, ends in a listed ccTLD (`.co.uk` counts). An owner mark never overrides this.
2. Known outside: a phone with an unlisted prefix, an unlisted `country`, or the owner's mark
   `contact.region.attest` (permission `enrich`, payload `{contactId}`), which stores
   `outside_eu_uk_attested_by` and `_at` on the profile.
3. Anything else is unknown and is refused `enrichment_region_unknown`.
Unknown is refused because an email and a `.com` domain say nothing about where a person lives,
GDPR follows the person, and Treg has no DPA: the default costs one owner click, the opposite
error an unlawful transfer. A change to the contact's email or phone clears the owner mark
(crm.md revision, E-14). Tests cover every listed prefix and ccTLD and each signal order case.

**E-8. Price, reservation and cap.** `ENRICHMENT_PRICES` holds one fixed price per op in
whole USD cents. The request reads the wallet and refuses with `Conflict`
`insufficient_funds` when the available balance is below the price or the wallet is not in
USD; this read is a courtesy and holds nothing. The money is held by the worker: in
`enrichment.attempt.start` (service role) it calls `reserveForJob` (`delivery.md` D-11) with
kind `enrichment` and job id `requestId`, after the request row has committed and before any
Treg call. When that returns null the request ends `insufficient_funds` with no call. Retries of
the same request reuse the one hold; D-11's index refuses a second. The runtime role gets no
new wallet grant.
Every call sends `X-Treg-Route-Max-Cost` equal to that price, converted exactly to dollars, so
Treg never bills more than was reserved. The token's own per-call cap is at least the top price.

**E-9. Daily caps.** Before inserting, the request counts its own tenant's
`enrichment_requests` created in the current UTC day (injected clock) under a
transaction-scoped advisory lock keyed by tenant; at `ENRICHMENT_TENANT_DAILY_CAP` it is
`Conflict` `enrichment_daily_cap`. The runtime role cannot see other tenants, so the global cap
is checked by the worker: in `enrichment.attempt.start` (service role), under one advisory lock
for all tenants, it counts attempts started that day across tenants, and at
`ENRICHMENT_GLOBAL_DAILY_CAP` the request ends `enrichment_daily_cap` with no hold and no call.
A test starts attempts for two tenants concurrently at the global cap minus one and finds
exactly one call.

**E-10. Worker and re-check.** The worker (service role) claims `pending` or due `uncertain`
requests with a lease token under `FOR UPDATE SKIP LOCKED`, as in `delivery.md` D-3. In
`enrichment.attempt.start` it re-checks E-5, E-6 and E-7 against current rows, then reserves
(E-8) if no hold exists yet; a failed check ends the request `blocked` with that reason and
releases any hold, with no call. The
attempt stores the exact domain and price it sends, and every retry repeats them.

**E-11. Outcomes and settlement.** `enrichment.attempt.settle` stores the Treg call id, the
provider and `treg_cost_micro` (from `X-Treg-Cost-Micro`, on every status), then:
- `hit` (at least one allowlisted field, E-13), a same-key replay included: captures the
  reservation once and records the result (E-13). The tenant pays for the lookup, whatever the
  owner later decides about the fields.
- `miss`, `rejected` (provider 4xx on our input): releases; the request ends `no_match` or
  `rejected`. Any billed cost is ours and cannot exceed the price (E-8).
- `failed` (429, 5xx, or a Treg refusal): keeps the hold and retries with backoff, after
  `retry_after_s` when given, up to `ENRICHMENT_MAX_ATTEMPTS`, then releases and ends `failed`.
  `route_max_cost` and `insufficient_balance` end `failed` at once; the second also reports
  `treg_balance_empty` to the operator.
A reservation moves from held to captured or released once (`delivery.md` D-11 partial unique
indexes).

**E-12. Unknown outcome.** A timeout or dropped connection keeps the hold and marks the
request `uncertain`. Retries reuse `Idempotency-Key: enrichment:<requestId>` and send only
before `first_attempt_at + dedupeWindowMs - margin` (24 hours). A 409 waits with backoff. After
the window, or on a 410, `lookup(callId)` decides: charged means the answer is lost, so the
hold is released (the cost is ours) and the request ends `answer_lost`; not found releases and
ends `failed`; no answer is a dead letter `outcome_unknown`, hold kept, for an operator.

**E-13. Results and minimization.** The adapter keeps only `output.name`, `domain`,
`industry`, `description`, `employees`, `founded`, `location` and `linkedin_url`; it never
stores or logs `raw` or the body. Text is 1 to 200 characters (description 1,000), `employees`
a non-negative integer, `founded` a year from 1000 to now, `linkedin_url` an `https://`
LinkedIn company URL; a failing value is dropped. A `location` in the refused region (E-7)
discards the result: nothing is stored, the reservation is released, the request ends
`region_blocked_after_call`, and the profile gets that `country`. `enrichment.result.record`
writes one immutable `enrichment_results` row per kept field (`request_id`, `contact_id`,
`field`, `value`, `provider`, `treg_call_id`, `fetched_at`, `expires_at` = fetched + 30 days).
Values are untrusted text, never instructions.

**E-14. Proposals and apply.** The same action inserts one approval per result row
(`approvals.md` A-1): `contact.profile.apply`, target the contact, payload `{contactId,
resultId}`, `requested_by` the enrichment actor, the result's `expires_at`, and a summary
naming the field, not its value. `APPROVAL_POLICIES` gets `contact.profile.apply` `{request:
"enrich", required: true}`, so it runs only through A-7 after an owner approves. The handler
re-checks E-6 and that the result exists, matches the contact and is unexpired (`Conflict`
`enrichment_result_expired`), writes the field to `crm_contact_profile`, and observes a source
record (`approvals.md` F-4) with source `enrichment.treg` and `source_ref` the call id.
`crm_contact_profile` is new, one row per contact: the eight `company_*` fields, `country`,
`do_not_enrich_at` and `_reason`, `outside_eu_uk_attested_by` and `_at`, `revision`,
`updated_at`. A crm.md revision lands with this slice. Enrichment never writes `crm_contacts`
identity columns or consent (`crm.md` C-9).

**E-15. Retention.** A daily purge (service role) deletes `enrichment_results` past
`expires_at`; applied values live on in the profile with their source record. Approval payloads
hold ids only, so no copy of a value remains. Deleting a contact cascades to its requests and
results.

**E-16. Balance alert.** At most once an hour, after a settled call, the worker reads
`EnrichmentPort.balance()`. Below $5 it sends `{code: "treg_balance_low", balanceMicro}` to its
injected `report` hook, the operator log (as `packages/core/src/calendar/worker.ts:193`), on
each check while below. No tenant table, notification, response or Inbox item carries it.
Nothing tops up; calls go on until Treg answers `insufficient_balance` (E-11).

**E-17. Reads and errors.** `POST /v1/enrichment/requests` (Idempotency-Key),
`GET /v1/enrichment/requests/:id` and `GET /v1/contacts/:id/enrichment` (requests, results and
their approval ids). Reads need `enrich` or `customers`. Tenants see only the codes in
`ENRICHMENT_ERROR_CODES` (`packages/contracts`). Treg bodies, headers, balance and team-level
errors never reach a tenant: they map to `enrichment_unavailable`, and the worker reports the
detail to the operator, cut to 200 characters.

**E-18. Tenancy.** `enrichment_requests`, `enrichment_results` and `crm_contact_profile` have
`tenant_id`, a tenant FK, forced RLS with the tenant policy, and a two-tenant denial test under
the runtime role in the catalog isolation suite. The worker names `tenant_id` in every
statement. The Treg tag is the tenant UUID, never a name or an email.

**E-19. Reconcile (after the first slice).** Once a day the worker sums `treg_cost_micro` per
tenant and compares it with Treg's usage by tag. A difference, or any untagged usage, is
reported to the operator as `treg_usage_mismatch`.

**E-20. Tests without Treg.** `FakeEnrichment` plays scripted outcomes and records each
call's key, cap header, tag and the reservation state at call time. Tests and CI build only the
fake, hold no Treg token, and never call Treg; the adapter test stubs `fetch`.

## First slice

`company.enrich` only: E-1 to E-18 and E-20. Port, fake and Treg adapter (stubbed `fetch`),
migrations for `enrichment_requests`, `enrichment_results` and `crm_contact_profile` (with the
crm.md revision), the `enrich` permission, the actions, the worker, the purge and the routes.
It needs `delivery.md` D-11 built first.

Acceptance test (fake, real Postgres): tenant A's owner enriches the company of a `+1`
contact with an `acme.example` email. The fake sees the call after the hold, with cap header =
price, tag A and input `{domain}` only. The hit captures once; fields land as pending approvals
with provider and call id; the contact is unchanged. Approving two fields writes only those two,
each with a source record. Tenant B reads none of it (`NotFound`). No fake call for: a `+44`
phone, a `.de` domain, unknown location, `do_not_enrich`, a suppression, the archive flag unset,
an `owner` token, low funds, the daily cap. A miss releases; a timeout then same-key replay
captures once; a French `location` discards and releases; a 499-cent balance reports
`treg_balance_low` to the injected reporter and to no tenant.

## Known limits

- SEO research (keyword volume and ideas, SERP, backlinks) and social data (profiles, posts)
  are later ops, each needing its own revision of this file that adds its tools to E-2.
- Person enrichment, email find and email verify stay out; EU, EEA and UK contacts wait for a
  GDPR review (`docs/integrations.md` open question 3).
- Open: the price and the daily cap defaults. Proposed: 5 cents (the test call's cap), 50 per
  tenant and 200 globally per day. Open: whether Switzerland joins the refused region.
- Open: whether an org-scoped agent token may read the balance and usage endpoints; if not,
  E-16 and E-19 need a separate read-only credential and a new setup step.
- The code cannot see Treg's archive setting; E-5 trusts the owner's flag. With the archive
  off, Treg still keeps answers 24 hours for replays and keeps hashed inputs.
- Treg is early access, US-hosted, with no SLA and no DPA. The tenant is the controller; any
  notice to the person enriched is the tenant's duty.
- No contact erasure exists yet; when it lands it must delete results and set
  `do_not_enrich_at`. Treg's docs disagree on whether a provider 4xx bills; E-11 records the
  cost header on every status either way.
