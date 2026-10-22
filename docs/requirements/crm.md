# F2: CRM transaction slice

Status: implemented. The numbered rules below are the contract the code and tests
follow. The three handlers, their wrappers, the schema and the migration ship in this
repository. At the time of writing, `pnpm --filter @zs/core test:crm` runs 40 tests in
five files (public examples, contact and deal acceptance, email uniqueness and the real
Postgres seam), and all pass.
Revision 2026-10-22 (audit B1-02): C-9 limits `recordedAt` to the supported instant range,
UTC years 0001 through 9999. A time outside it is refused with `ValidationFailed` and
nothing is written; before this, year 0000 passed the boundary and Postgres failed the
request with a 500. Source observations (approvals.md F-4) and booking instants
(booking.md) apply the same range.
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
contacts. Every parent lookup and mutation uses that same tenant. IDs are
tenant-scoped: a create-target ID that exists only in another tenant is unused and
the create succeeds if the other rules pass. `TenantDenied` applies to foreign or
absent existing targets and parents without revealing another tenant's IDs; an
absent create-target ID is expected.

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
entire string. Phone is not trimmed: leading whitespace such as `" +14155550123"`
raises `ValidationFailed`. Do not guess a country, strip punctuation, accept
extensions or pretend to validate whether a number is assigned. `null` means absent.
Require at least one of email or phone for every contact input and stored contact.

**C-4. Desired, boundary/approval order.** Inputs and commands are strict zod
objects with inferred output types. Parse/normalize before requesting approval,
then bind the approval to the exact parsed payload and pre-minted target. An
unparsed raw email and its normalized form are not interchangeable approval
bindings. IDs normalize to lowercase UUIDs. Instants are UTC with exactly three
fractional digits. Labels/sources have 1..200 UTF-16 code units (`String.length`)
passing `isPostgresText`. Whitespace-only names, titles and sources are accepted;
these fields are not trimmed. Reject unknown fields, malformed dates and
out-of-range revisions with `ValidationFailed`.
Feature functions map schema failures to `ValidationFailed` through `safeParse`;
standalone exported schema parsers retain zod's normal error behavior.
For contact create/find, apply this error order: schema failure (`ValidationFailed`),
future-dated supplied evidence (`ValidationFailed`), `split_identity`,
`identity_mismatch`, `id_in_use`, then consent merge. The dispatcher still performs
its shared tenant, target, approval and replay checks; this order governs the
contact-specific checks on a fresh valid dispatch.

**C-5. Desired, no identity match.** `createOrFindContact` accepts a candidate
`contactId`, display name or null, identities, mode and per-channel consent. With
no matching email or phone, insert a contact using that ID and return
`{contact,created:true}` inside the action envelope. Do not replace an unrelated
row when the candidate ID already exists in this tenant; raise `Conflict` with
`details.reason="id_in_use"` and roll back instead.

**C-6. Desired, one identity match.** If either supplied identity resolves to one
contact, or both resolve to that same contact, return its actual ID with
`created:false`. The pre-minted candidate may differ from the returned contact ID;
do not insert a spare candidate row. Fill an absent stored identity from a supplied
unclaimed identity, and fill an absent display name. If the candidate ID is an existing contact other than
the match, raise C-5's `id_in_use` (C-18). Preserve existing non-null
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
payloads find one contact: one reports created, the other found. Apply C-4's error
order if other supplied identities conflict. Protect the racing write with a
`SAVEPOINT`; after a uniqueness race, use `ROLLBACK TO SAVEPOINT` and re-read within
that savepoint in the handler's existing READ COMMITTED transaction. Never continue
an aborted transaction or retry the whole transaction. The wrapper never re-dispatches. A race
that resolves to split identities raises `Conflict`. Same-key retries use the
dispatcher's stored result.

**C-9. Desired, stored consent.** Store email and SMS independently. Each channel
contains either null (no recorded evidence) or `{status,source,recordedAt}` with
status `granted` or `denied`, a nonempty source, and a valid recorded time in UTC years
0001 through 9999 (`supportedInstantSchema`) no later than the dispatcher's injected
now. Never derive permission from having an address, a phone, a deal or a booking. This slice stores evidence; it never sends messages.

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
including entries an import would preserve over; future-dated evidence raises
`ValidationFailed` before identity conflicts, as ordered in C-4. Apply consent only
after all those checks pass.

**C-12. Desired, contact timestamps.** Use the dispatcher's injected now for new
`createdAt` and `updatedAt`. Preserve `createdAt` on find. Bump `updatedAt` to now
only if identity, missing name or consent actually changes; an unchanged find
retains its prior time. A successful find is still an approved action with one
stored result and outbox event. This is an action audit, not evidence of consent.

**C-13. Desired, create a deal.** `createDeal` takes a pre-minted `dealId`, an
existing tenant-owned `contactId`, `pipelineId`, `stageId`, and nonempty title.
The stage must belong to that pipeline in that tenant. Insert at revision 1 with
`createdAt=updatedAt=now`. A contact may have several deals, including in the same
pipeline. Do not auto-create a contact, pipeline or stage. Check all parent ownership
first, then validate the stage's pipeline membership. An absent or foreign parent
raises `TenantDenied` before wrong-pipeline `ValidationFailed`, even when both apply.
An owned stage from the wrong pipeline is `ValidationFailed`. Reusing an existing
deal ID in this tenant with another key is `Conflict` with
`details.reason="id_in_use"`; an ID used only in another tenant is unused (C-1).

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
update also raises `Conflict` with `details.reason="stale_revision"` and
`details.currentRevision` re-read from owned state.

**C-15. Desired, successful move.** The destination belongs to the deal's current
pipeline; moving deals between pipelines is outside scope. A different supplied
pipeline or owned stage in another pipeline is `ValidationFailed`. A successful
move increments revision by exactly one, including a move to the existing stage,
sets `updatedAt=now`, and preserves all other fields. Use a conditional SQL update,
not a read followed by an unconditional write. Prevent overflow beyond the safe
integer boundary defined in the schema.

**C-16. Desired, concurrent stage changes.** Two distinct approved moves starting
from the same revision cannot both commit. One returns the next revision and one
raises `Conflict` with C-14's `stale_revision` reason and owned `currentRevision`.
An exact idempotent replay returns its original saved revision, even if later
actions have moved the deal again. Approval reuse with a different
key remains a shared-dispatcher conflict.

**C-17. Desired, one write path.** All three functions use `CrmWriteContext.dispatch`,
a server-only closure `command => sharedDispatch(serverContext, command)` built
from the existing `createDispatcher(handlers)`. The trusted server context owns
actor, tenant, database, clock, config, IDs and approval resolution. HTTP/MCP callers
cannot supply this capability. The wrapper uses the matching command schema's
`safeParse(command)` and forwards its `data` to dispatch exactly once. Invalid input
raises `ValidationFailed` without reaching dispatch. Validate the returned envelope
with the matching output schema's `safeParse`; a parse failure raises
`ValidationFailed`. Return the parsed envelope on success. The shared dispatcher raises
`ValidationFailed` for a non-finite clock; the wrapper propagates every dispatcher error unchanged. The wrapper never re-dispatches; C-8's race
recovery stays inside the handler transaction. `crmHandlers` registers the three handlers (C-23); composition roots supply
them to `createDispatcher` without changing the dispatcher or its types.

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
`Conflict` codes. `NotImplemented` marks an unregistered action.
Exported error aliases describe typed domain errors; unexpected infrastructure
errors still propagate. No failed command leaves partial consent, an incremented
revision, a contact/deal row, action history or an outbox event.

**C-20. Desired, schema ownership.** The schema lives in
`packages/db/src/schema/crm.ts` and the SQL in
`supabase/migrations/20261017170100_crm.sql`. Use `timestamptz` for times and require these tables:

| Table | Required columns and constraints |
| --- | --- |
| `crm_contacts` | `tenant_id`, `id`, `display_name` nullable, `normalized_email` nullable, `e164_phone` nullable, `created_at`, `updated_at`; PK `(tenant_id,id)`, tenant FK, at least one identity, canonical email/phone checks, partial unique `(tenant_id,normalized_email)` and `(tenant_id,e164_phone)` where non-null |
| `crm_contact_consent` | `tenant_id`, `contact_id`, `channel` (`email`/`sms`), `status` (`granted`/`denied`), `source`, `recorded_at`; PK `(tenant_id,contact_id,channel)`, composite contact FK, nonempty source; absent row renders as null |
| `crm_pipelines` | `tenant_id`, `id`, `name`; PK `(tenant_id,id)`, tenant FK, nonempty name |
| `crm_stages` | `tenant_id`, `id`, `pipeline_id`, `name`, `position`; PK `(tenant_id,id)`, composite pipeline FK, unique `(tenant_id,pipeline_id,id)`, nonnegative integral position and unique position per pipeline |
| `crm_deals` | `tenant_id`, `id`, `contact_id`, `pipeline_id`, `stage_id`, `title`, `revision`, `created_at`, `updated_at`; PK `(tenant_id,id)`, composite contact and pipeline FKs, triple FK `(tenant_id,pipeline_id,stage_id)` to stages, nonempty title, revision integer >=1 and <=9007199254740991 (use bigint storage, safe numeric serialization) |

Every "nonempty" text check above is exactly `char_length(col) BETWEEN 1 AND 200` with no
trimming; whitespace-only values are valid (C-4).

Pipeline/stage provisioning gets separate future dispatcher actions. It is fixture
setup, not an implicit side effect of these functions. Consent storage must preserve
its source/time independently of contact update times.

**C-21. Desired, RLS and isolation.** Every table has `tenant_id NOT NULL`, a
tenant FK, enabled and forced RLS, and tenant-matching `USING`/`WITH CHECK` policies.
All relationship constraints include the tenant. Runtime credentials cannot bypass
RLS or write action/outbox history directly. Add two-tenant read/write denial tests
under `zs_runtime`; a service-role test is insufficient. Use local Postgres or a
Supabase branch for integration tests and clean up their data.

**C-22. Desired, public test scope.** `test:crm` runs the CRM folder, separate from
baseline `test`. Seven of its tests are the public examples described here. Public JSON examples show creation with normalized email, import
preservation, split identity conflict, deal creation, a revision bump and a stale
move. Write tests use a scripted bound dispatcher to check command/result/error
forwarding; they are boundary examples and do not prove handler algorithms or
database persistence. A seventh test in `packages/core/test/crm/integration.test.ts`
uses the C-23/C-24 seam with the real `@zs/db/testing` database, two-tenant fixture
and `zs_runtime` scoped database. It seeds a pipeline and stages with service-role
SQL, calls `createOrFindContact`, and checks the committed contact. This is a
template, not the acceptance set. All seven pass at the time of writing. Real Postgres
acceptance lives in `packages/core/test/crm/contact.acceptance.test.ts`,
`deal.acceptance.test.ts` and `email-uniqueness.test.ts`. It must keep proving C-1, C-6
through C-16 and C-19 through C-21, including uniqueness races, RLS, concurrent moves,
idempotency and rollback. Separate hidden tests may exercise cases beyond these public
examples. Never replace failures with skips, `todo` or expected-failure flags.

**C-23. Desired, handler export and composition.**
`packages/core/src/crm/index.ts` exports
`crmHandlers: Readonly<Record<string, ActionHandler>>`, keyed by action types
`crm.contact.create-or-find`, `crm.deal.create` and `crm.deal.move-stage`.
`ActionHandler` uses the default `DispatchConfig`; handlers require no config keys
because all feature settings live in tables. The map contains exactly
those three keys and no other key, so it is disjoint from `bookingHandlers`. Direct
dispatch of an unregistered action raises the shared dispatcher's `NotImplemented`.
Export `crmHandlers` through
`packages/core/src/index.ts` as well. A server composes both features with
`const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers })`.
It supplies a trusted `DispatchContext` named `ctx`, with `db` set to the runtime
scoped database (in tests, `TestDatabase.db`, backed by `zs_runtime`), `config: {}`,
the injected clock/ID generator, actor/tenant and caller-supplied `resolveApproval`.
Bind `CrmWriteContext.dispatch = command => dispatch(ctx, command)`; booking uses
`BookingWriteContext.dispatch = command => dispatch(ctx, command)` at the same
server boundary. No dispatcher or shared action-type changes are required.

**C-24. Desired, SQL fixture and inspection contract.** Tests use
`withTestDatabase` and `createTwoTenantFixture` from `@zs/db/testing`. After the
fixture provisions tenants, tests seed `crm_pipelines` and then `crm_stages` as
`service_role` using plain SQL through `fixture.service`. INSERTs supply only the
C-20 required columns with these exact Postgres types:

| Table | Column types |
| --- | --- |
| `crm_pipelines` | `tenant_id uuid`, `id uuid`, `name text` |
| `crm_stages` | `tenant_id uuid`, `id uuid`, `pipeline_id uuid`, `name text`, `position integer` |
| `crm_contacts` | `tenant_id uuid`, `id uuid`, `display_name text NULL`, `normalized_email text NULL`, `e164_phone text NULL`, `created_at timestamptz`, `updated_at timestamptz` |
| `crm_deals` | `tenant_id uuid`, `id uuid`, `contact_id uuid`, `pipeline_id uuid`, `stage_id uuid`, `title text`, `revision bigint`, `created_at timestamptz`, `updated_at timestamptz` |

All listed columns are NOT NULL except those marked NULL. `revision` retains
C-20's safe-integer range and numeric API serialization. Every extra column an
implementer adds must be nullable or have a default. No extra NOT NULL table or
mandatory related row may be required for the pipeline/stage seed INSERTs; only
their tenant and pipeline parents listed in C-20 may be prerequisites. This seed
limit preserves C-20's contact, pipeline and stage FKs on `crm_deals`. Tests may SELECT
`crm_contacts` and `crm_deals` as `service_role` using any subset of exactly their
C-20 columns listed above; grant that access. The same service-role seed/read
access applies to pipelines and stages. Consent remains in C-20's separate
`crm_contact_consent` table; no extra contact column is part of this inspection
contract. Inspection does not establish RLS: tenant-denial tests still run under
`zs_runtime` (C-21). For those tests, inside `fixture.a.run`, `zs_runtime` may
INSERT a `crm_contacts` row that supplies exactly the listed contact columns; grant
that INSERT. It succeeds for the current tenant and fails only through RLS
`WITH CHECK` (SQLSTATE `42501`) when `tenant_id` is another tenant's. node-pg
returns `bigint` as a string, so tests read `revision::integer` when comparing.

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
