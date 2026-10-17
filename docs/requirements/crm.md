# F2: CRM transaction slice

Status: frozen requirements and interfaces; feature logic is not implemented.
This slice covers contact identity, consent storage, deal creation and stage moves.
It provides no messaging, contact merge, general contact edit or pipeline editor.

## Evidence and decisions

The local HighLevel notes dated 2026-10-17 describe contacts within a client account
and deals organized by pipeline/stage. The saved feature map's object-model section
and the teardown informed this scope. The saved calendar guide also exposes consent
capture as a distinct input. These are behavior references; none of their wording,
code or assets is reproduced here.

The product assembly plan dated 2026-10-17, sections 1, 2, 6 and 8, calls for tenant
isolation, approved writes and consent-aware customer work. Its section 3 SeldonFrame
table is void. A browser visit to `http://localhost:3000` on 2026-10-17 reached only
sign-in, so this document makes no authenticated-app behavior claim. No source or
bundle was inspected. cal.diy and the scheduler inform F1, not CRM identity policy.

**Desired** below means our chosen requirement. These notes do not establish an
upstream normalization, collision, revision or import-consent algorithm; none is
claimed. The policies below give implementers one explicit answer to those gaps.

## Numbered rules

**C-1. Desired, tenant scope.** Match identities only inside the authenticated
tenant. Identical email/phone values in different tenants represent independent
contacts. Every parent lookup and mutation uses that same tenant. A foreign or
unavailable parent/target is `TenantDenied` without revealing another tenant's IDs.

**C-2. Desired, email normalization.** Trim leading/trailing ECMAScript whitespace,
then require ASCII and at most 254 characters before lowercasing without a locale.
Reject non-ASCII input before folding, so a Unicode lookalike cannot become another
contact's ASCII identity. Validate the result with the frozen email schema
and use it as the equality key. Do not remove plus suffixes or dots, substitute
domains, or infer provider aliases. `null` means absent. Empty/whitespace-only or
malformed supplied email is `ValidationFailed`, not absence. The default zod email
syntax defines this slice's accepted addresses; international-address expansion
requires a future interface change.

**C-3. Desired, phone normalization.** Accept only canonical E.164 syntax:
`+`, a nonzero first digit, then digits, with 2..15 digits total. Equality uses the
entire string. Do not guess a country, strip punctuation, accept extensions or
pretend to validate whether a number is assigned. `null` means absent. Require at
least one of email or phone for every contact input and stored contact.

**C-4. Desired, boundary/approval order.** Inputs and commands are strict zod
objects with inferred output types. Parse/normalize before requesting approval,
then bind the approval to the exact parsed payload and pre-minted target. An
unparsed raw email and its normalized form are not interchangeable approval
bindings. IDs normalize to lowercase UUIDs. Instants are UTC with exactly three
fractional digits. Labels/sources have 1..200 valid Postgres text units. Reject
unknown fields, malformed dates and out-of-range revisions with `ValidationFailed`.
Feature functions map schema failures to `ValidationFailed` through `safeParse`;
standalone exported schema parsers retain zod's normal error behavior.

**C-5. Desired, no identity match.** `createOrFindContact` accepts a candidate
`contactId`, display name or null, identities, mode and per-channel consent. With
no matching email or phone, insert a contact using that ID and return
`{contact,created:true}` inside the action envelope. Do not replace an unrelated
row when the candidate ID already exists; raise `Conflict` with
`details.reason="id_in_use"` and roll back instead.

**C-6. Desired, one identity match.** If either supplied identity resolves to one
contact, or both resolve to that same contact, return its actual ID with
`created:false`. The pre-minted candidate may differ from the returned contact ID;
do not insert a spare candidate row. Fill an absent stored identity from a supplied
unclaimed identity, and fill an absent display name. Preserve existing non-null
identity/name values. If a supplied non-null identity differs from an already
non-null identity on the matched row, raise `Conflict` with
`details.reason="identity_mismatch"`, rather than silently ignore or replace it.
An omitted identity (null) never erases the stored value.

**C-7. Desired, split identity conflict.** When email resolves to contact A and
phone resolves to contact B in the same tenant, with A != B, raise typed `Conflict`
with `details.reason="split_identity"`. Do not choose a winner, merge rows, move
deals, write consent or leave an action/outbox record. Resolve identity merges
through a separate future approved workflow.

**C-8. Desired, concurrent identity claims.** Enforce partial tenant/email and
tenant/phone unique indexes for non-null keys. Serialize/retry relevant identity
lookups and inserts inside the transaction so concurrent separately approved,
different-key commands with identical normalized identity sets and compatible
payloads find one contact: one reports created, the other found. Apply C-6/C-7 if other supplied identities
conflict. Re-read after a uniqueness race using a savepoint or whole-transaction
retry; do not continue a failed Postgres transaction. A race that resolves to split
identities raises `Conflict`. Same-key retries use the dispatcher's stored result.

**C-9. Desired, stored consent.** Store email and SMS independently. Each channel
contains either null (no recorded evidence) or `{status,source,recordedAt}` with
status `granted` or `denied`, a nonempty source, and a valid recorded time no later
than the dispatcher's injected now. Never derive permission from having an address,
a phone, a deal or a booking. This slice stores evidence; it never sends messages.

**C-10. Desired, import preservation.** For mode `import`, preserve every existing
non-null channel record byte-for-byte, including status, source and recorded time,
regardless of the incoming status/time. Import may populate a previously null
channel with supplied evidence. Null input never clears a channel. This deliberate
conservative policy neither withdraws an existing grant nor resurrects an existing
denial. Even newer imported evidence cannot replace an established record.

**C-11. Desired, interactive consent.** For mode `interactive`, null input leaves
the channel unchanged. Fill a missing channel; otherwise accept later recorded
evidence, ignore older evidence, and on equal timestamps let denial take precedence.
If timestamp/status are identical, retain existing provenance. Only later explicit
interactive grant evidence may replace a denial. Validate all supplied evidence,
including entries an import would preserve over; future-dated evidence fails the
whole command. Apply consent only after identity conflicts have been ruled out.

**C-12. Desired, contact timestamps.** Use the dispatcher's injected now for new
`createdAt` and `updatedAt`. Preserve `createdAt` on find. Bump `updatedAt` to now
only if identity, missing name or consent actually changes; an unchanged find
retains its prior time. A successful find is still an approved action with one
stored result and outbox event. This is an action audit, not evidence of consent.

**C-13. Desired, create a deal.** `createDeal` takes a pre-minted `dealId`, an
existing tenant-owned `contactId`, `pipelineId`, `stageId`, and nonempty title.
The stage must belong to that pipeline in that tenant. Insert at revision 1 with
`createdAt=updatedAt=now`. A contact may have several deals, including in the same
pipeline. Do not auto-create a contact, pipeline or stage. An unavailable/foreign
parent is `TenantDenied`; an owned stage from the wrong pipeline is
`ValidationFailed`. Reusing an existing deal ID with another key is `Conflict`
with `details.reason="id_in_use"`.

**C-14. Desired, compare-and-set stage move.** `moveDealStage` takes `dealId`,
`pipelineId`, destination `stageId`, and integral `expectedRevision` >= 1.
In the dispatcher transaction, update only the owned row whose pipeline and revision
match. A stale revision raises typed `Conflict` with
`details.reason="stale_revision"`; report `details.currentRevision` from owned
state. No state/history/outbox write survives the failure. Current revision on a
foreign row must not be exposed. Check ownership first, then validate the supplied
pipeline and destination membership, then compare revision. A wrong pipeline and
stale revision together yield `ValidationFailed`; absent/foreign parents take
precedence as `TenantDenied`. Once validation succeeds, a zero-row conditional
update caused by a racing revision change is `Conflict`.

**C-15. Desired, successful move.** The destination belongs to the deal's current
pipeline; moving deals between pipelines is outside scope. A different supplied
pipeline or owned stage in another pipeline is `ValidationFailed`. A successful
move increments revision by exactly one, including a move to the existing stage,
sets `updatedAt=now`, and preserves all other fields. Use a conditional SQL update,
not a read followed by an unconditional write. Prevent overflow beyond the safe
integer boundary defined in the schema.

**C-16. Desired, concurrent stage changes.** Two distinct approved moves starting
from the same revision cannot both commit. One returns the next revision and one
raises `Conflict`. An exact idempotent replay returns its original saved revision,
even if later actions have moved the deal again. Approval reuse with a different
key remains a shared-dispatcher conflict.

**C-17. Desired, one write path.** All three functions use `CrmWriteContext.dispatch`,
a server-only closure `command => sharedDispatch(serverContext, command)` built
from the existing `createDispatcher(handlers)`. The trusted server context owns
actor, tenant, database, clock, config, IDs and approval resolution. HTTP/MCP callers
cannot supply this capability. Validate the command, dispatch exactly once and
validate the returned stored result. Feature stubs register no handler; future
composition roots supply handlers without changing the dispatcher or its types.

**C-18. Desired, target verification.** Action/target pairs are
`crm.contact.create-or-find`/`contact`, `crm.deal.create`/`deal`, and
`crm.deal.move-stage`/`deal`. Target ID equals the payload contact/deal candidate ID
or the existing deal ID. The unchanged `resolveTarget(tx,target)` has no payload.
For contact create/find, it verifies the owned tenant creation scope for an unused
candidate or loads/verifies an existing owned contact. Payload-dependent identity checks belong
in `handle`: an owned candidate already in use is allowed only when it is the
identity match; otherwise C-5's `id_in_use` conflict applies. For pure deal creation,
the resolver confirms the ID is unused before returning the target; finding an
existing owned deal ID instead throws C-13's typed `Conflict` / `id_in_use` directly
from the resolver. Never return an existing deal as a valid create target or return
null for this domain conflict. A unique insert race after resolution still raises
`Conflict` with SQL constraint details; the `id_in_use` reason is optional for that
race. Returning null from any resolver means `TenantDenied`. An unused contact candidate can resolve
to an existing different contact through C-6; the action retains its approved
candidate target and stores the actual result. Verify contact/pipeline/stage
parents in the same transaction. Echoing unverified input is not ownership proof.

**C-19. Desired, atomic history and errors.** Contact/consent changes or deal
changes, one action result and one outbox event commit together. Preserve shared
`ValidationFailed`, `TenantDenied`, `BindingMismatch`, `IdempotencyConflict` and
`Conflict` codes. `NotImplemented` marks the public stubs/unregistered actions.
Exported error aliases describe typed domain errors; unexpected infrastructure
errors still propagate. No failed command leaves partial consent, an incremented
revision, a contact/deal row, action history or an outbox event.

**C-20. Desired, schema ownership.** Implement schema in
`packages/db/src/schema/crm.ts` and migrations in `supabase/migrations/*_crm.sql`.
This scaffold adds neither. Use `timestamptz` for times and require these tables:

| Table | Required columns and constraints |
| --- | --- |
| `crm_contacts` | `tenant_id`, `id`, `display_name` nullable, `normalized_email` nullable, `e164_phone` nullable, `created_at`, `updated_at`; PK `(tenant_id,id)`, tenant FK, at least one identity, canonical email/phone checks, partial unique `(tenant_id,normalized_email)` and `(tenant_id,e164_phone)` where non-null |
| `crm_contact_consent` | `tenant_id`, `contact_id`, `channel` (`email`/`sms`), `status` (`granted`/`denied`), `source`, `recorded_at`; PK `(tenant_id,contact_id,channel)`, composite contact FK, nonempty source; absent row renders as null |
| `crm_pipelines` | `tenant_id`, `id`, `name`; PK `(tenant_id,id)`, tenant FK, nonempty name |
| `crm_stages` | `tenant_id`, `id`, `pipeline_id`, `name`, `position`; PK `(tenant_id,id)`, composite pipeline FK, unique `(tenant_id,pipeline_id,id)`, nonnegative integral position and unique position per pipeline |
| `crm_deals` | `tenant_id`, `id`, `contact_id`, `pipeline_id`, `stage_id`, `title`, `revision`, `created_at`, `updated_at`; PK `(tenant_id,id)`, composite contact and pipeline FKs, triple FK `(tenant_id,pipeline_id,stage_id)` to stages, nonempty title, revision integer >=1 and <=9007199254740991 (use bigint storage, safe numeric serialization) |

Pipeline/stage provisioning gets separate future dispatcher actions. It is fixture
setup, not an implicit side effect of these functions. Consent storage must preserve
its source/time independently of contact update times.

**C-21. Desired, RLS and isolation.** Every table has `tenant_id NOT NULL`, a
tenant FK, enabled and forced RLS, and tenant-matching `USING`/`WITH CHECK` policies.
All relationship constraints include the tenant. Runtime credentials cannot bypass
RLS or write action/outbox history directly. Add two-tenant read/write denial tests
under `zs_runtime`; a service-role test is insufficient. Use local Postgres or a
Supabase branch for future integration tests and clean up their data.

**C-22. Desired, public test scope.** Run six ordinary feature tests, separate from
baseline `test`. Public JSON examples show creation with normalized email, import
preservation, split identity conflict, deal creation, a revision bump and a stale
move. Write tests use a scripted bound dispatcher to check command/result/error
forwarding; they are boundary examples and do not prove handler algorithms or
database persistence. All six currently fail with `NotImplemented`. Later real
Postgres acceptance must prove C-1, C-6 through C-16 and C-19 through C-21, including
uniqueness races, RLS, concurrent moves, idempotency and rollback. Hidden tests
exercise cases beyond these public examples. Never replace failures with skips,
`todo`, expected-failure flags or assertions that a stub throws.

## Frozen API and examples

`packages/contracts/src/crm.ts` exports zod schemas and inferred types for identity
inputs, consent, contact/deal records, all three inputs/commands/outputs, and the
contact create/find result. Exported function signatures are `CreateOrFindContact`,
`CreateDeal`, and `MoveDealStage`, with `CrmWriteContext` and typed error aliases.
The contracts/core root indexes export these APIs.

Fixtures in `packages/core/fixtures/public/crm/`: `contact-created.json`,
`contact-import-preserves-consent.json`, `contact-split-identity.json`,
`deal-created.json`, `deal-stage-moved.json`, and `deal-stage-stale.json`.
All data is synthetic. A fixture's `state` explains the expected transaction
scenario; the boundary tests do not claim to seed a real database from that state.
