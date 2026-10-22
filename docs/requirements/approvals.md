# M3b: approval and source records

Status: contract for M3b (2026-10-20), revision 3 (2026-10-22). Revision 2 (review round 1):
A-2, A-6, A-7, A-14, F-5. Revision 3 (audit B1): F-4 limits `observedAt` to UTC years 0001
through 9999, the range CRM consent (crm.md C-9) and booking instants also apply. Records and
replays accept any stored UTC ISO instant, and a derived `fresh_until` or a clock outside the
range fails with `ValidationFailed`.
Code follows this file; a change to a numbered rule needs a new revision of this file first.

Scope: two tenant records the rest of M3 builds on.

- **Approval record.** Someone (a staff member, an owner, later an agent) proposes one exact
  action; an owner approves or rejects it; the approved action then runs through the shared
  dispatcher bound to that record. M3c sends inbox replies only through it; M3d re-checks it
  before delivering an outbox event.
- **Source record.** Where a fact about a customer, deal, booking or calendar came from, and
  until when it counts as fresh. Readers that act on a fact (an agent, a delivery, a sync)
  require a fresh record instead of trusting whatever row is there.

Out of scope: approval UI in the dashboard (M3c renders approvals next to inbox drafts),
multi-step or quorum approvals, automatic expiry jobs, provider syncs (M5).

## Evidence and decisions

- Plan (approved 2026-10-18): M3b "approval/action record and source/freshness record
  (tables, actions, RLS, tests)"; M3c "replies drafted, sent only after approval"; M3d
  "consent and approval re-checked at delivery"; M6 "one inquiry follow-up agent with
  approval, caps and kill switch".
- Shared dispatcher (`packages/core/src/actions/dispatch.ts`, README "Actions"): every
  command carries an approval reference; `resolveApproval` returns the full approved
  binding; the unique index `actions_tenant_approval` allows one committed action per
  approval ID. Until M3b every approval was a direct approval (the caller approving the
  command it submits). This file adds stored approvals beside it; the dispatcher is unchanged.
- Permission matrix (M2a): `ROLE_PERMISSIONS` in `packages/contracts/src/members.ts` and
  `ACTION_PERMISSIONS` in `packages/core/src/edge/session.ts`.

## Approval record

**A-1. Table.** `approvals` (migration `20261020100000_approvals.sql`) holds one proposed
action per row: `tenant_id`, `id`, `action_type`, `target_type`, `target_id`, `payload`
(JSONB), `summary` (1 to 500 characters), `requested_by`, `requested_at`, `expires_at`,
`status`, and the decision columns `decided_by`, `decided_at`, `decision_note`,
`revoked_by`, `revoked_at`, `revoke_note`. The proposed action is the dispatcher binding
without its actor: tenant, action type, target and payload. Tenant FK, forced RLS with the
tenant policy, two-tenant denial under the runtime role (catalog isolation suite).

**A-2. States.** `status` is one of `pending`, `approved`, `rejected`, `revoked`.
Allowed transitions: `pending -> approved`, `pending -> rejected`, `pending -> revoked`
(withdrawn) and `approved -> revoked`. `rejected` and `revoked` are final. CHECK constraints
tie each state to its columns: `pending` has no decision and no revocation; `approved` and
`rejected` have `decided_by` and `decided_at` and no revocation; `revoked` has `revoked_by`
and `revoked_at`, and keeps the decision it had (a withdrawn `pending` request has none, not
even a `decision_note`). No state but `revoked` has any revocation column, not even one of
them. The transition trigger lets the decision columns change only on `pending -> approved`
and `pending -> rejected`. `expires_at > requested_at` always.

**A-3. Standing.** Readers see `standing`, computed against the injected clock: `expired`
when the status is `pending` or `approved` and `now >= expires_at`, else the status. An
expired approval can no longer be decided or run. Expiry is never written by a job.

**A-4. Binding columns are immutable.** The runtime role may INSERT the request columns
and UPDATE only the decision and revocation columns (column grants). No role but the
service role can change what an approval approves.

**A-5. Request: `approval.request`.** Payload `{approvalId, action: {actionType, target:
{type, id}, payload}, summary, expiresInMinutes}`; target `{type: "approval", id:
approvalId}`. The edge mints `approvalId` from the idempotency key. `expiresInMinutes` is
1 to 43200 (30 days), default 10080 (7 days); the handler sets `expires_at = now +
expiresInMinutes` with the dispatcher's clock, so a replay rebuilds the same command. The
requester must be a member holding the action's request permission (A-9). The proposed
action type must be registered in `ACTION_PERMISSIONS` and must not be an `approval.*`
action; otherwise `ValidationFailed`. The target tenant is the caller's tenant. The handler
records `requested_by = actor`. Payloads are not validated against the proposed action's
schema here; the action's own handler validates them when the approval runs (A-7).

**A-6. Decide: `approval.approve` and `approval.reject`.** Payload `{approvalId, note?}`
(note 1 to 500 characters); target the approval. Only a member holding `approve` (owners)
may decide. The row is locked `FOR UPDATE`; it must be `pending` and unexpired, else
`Conflict` with reason `approval_not_pending` or `approval_expired`. The decider is
recorded in `decided_by` and becomes the **executor**: the approved binding's actor is
`decided_by`. An owner may approve their own request.
Retry: when the caller is the recorded decider of an `approved` approval whose action has
not committed (its run failed), the edge `approve` call skips the decision, whatever key and
note it carries, returns the stored decision action, and goes to the run (A-7). Any other
`approve` of a decided approval is `approval_not_pending`.

**A-7. Run.** `approvedDispatch(deps, tenantId, actorId)` runs the stored action through the
same `createDispatcher` registry as direct writes, with:
- command = the stored action type, target (with tenant) and payload, approval reference
  `{tenantId, id: approvalId}`, idempotency key `approval:<approvalId>`;
- `authorize`: the caller is a member holding `ACTION_PERMISSIONS[actionType]`;
- `resolveApproval`: reads the approval `FOR SHARE` (so it serializes with A-8) and returns
  the binding only when the record exists in the tenant, its status is `approved`, `now <
  expires_at` with `now` read from the injected clock after the lock is granted (a wait on
  the lock counts toward expiry), and `decided_by` is the caller. Otherwise `Conflict`: `approval_not_approved`
  (pending, rejected, revoked) or `approval_expired`; a missing record is `TenantDenied`.
Before dispatching, the edge reads the record as the caller: a record the caller may not see
(A-11) or that does not exist answers `NotFound`.
The dispatcher then compares the full binding as for every action, so a different actor,
target or payload is `BindingMismatch`. The unique approval index allows one committed
action per approval; a replay with the same key returns the stored result.
The edge `approve` call decides (A-6) and then runs (A-7) in a second transaction. If the
run fails, the approval stays `approved`; the decider repeats `approve`, with the same key or
a fresh one, and the run is retried under the same run key (A-6 retry). Once the action has
committed, the first key replays both steps.

**A-8. Revoke: `approval.revoke`.** Payload `{approvalId, note?}`. A `pending` or `approved`
approval becomes `revoked` with `revoked_by` and `revoked_at`. Owners may revoke any
approval; the requester may withdraw their own `pending` request. Revoking an approval whose
action already committed does not undo that action; it stops later delivery (A-10).
Anything else is `Conflict` with reason `approval_not_revocable`.

**A-9. Policy.** `APPROVAL_POLICIES` (`packages/core/src/approvals/policy.ts`) maps an action
type to `{request: Permission, required: boolean}`. Without an entry the request permission
is the action's own `ACTION_PERMISSIONS` entry and `required` is false. `required: true`
means a member session may not run the action directly: `memberAuthorize` refuses it with
`TenantDenied`, so it only runs through A-7. M3c adds `inbox.reply.send` here with
`{request: "inbox.drafts", required: true}`.

**A-10. Delivery re-check.** `checkApproval(tx, tenantId, approvalId, now)` returns
`{kind: "stored", standing, binding}` for a stored approval and `{kind: "direct"}` when no
record has that ID (direct approvals have none). `approvalForAction(tx, tenantId, actionId,
now)` does the same from an `actions` row, for outbox workers that hold `outbox.action_id`.
A worker delivers an event whose action ran under a stored approval only while its standing
is `approved` (not `revoked`, not `expired`).

**A-11. Reads.** `GET /v1/approvals` (newest first, keyset cursor, optional `status`) and
`GET /v1/approvals/:id`. Members holding `approve` see every approval; other members see
only the ones they requested (another member's approval answers `NotFound`). Each record
carries `standing` and `executedActionId` (the action that ran under it, or null).

**A-12. Summary is the requester's text.** The approver UI must render the action type,
target and payload; `summary` is a hint written by the requester and is never the only thing
an approver sees.

**A-13. Permission.** `approve` joins the permission list; owners hold it, staff do not.

**A-14. Reserved keys.** Idempotency keys are unique per tenant, and the run key
`approval:<approvalId>` shares that space with caller keys. `idempotencyKeySchema` therefore
refuses any caller key that starts with a prefix in `SERVER_IDEMPOTENCY_PREFIXES`
(`packages/contracts/src/http.ts`, compared case-insensitively), with `ValidationFailed`, on
every HTTP route and MCP tool. M3d adds its own server prefixes to the same list.

## Source record

**F-1. Table.** `source_records` (migration `20261020100100_source_records.sql`): `tenant_id`,
`id`, `subject_type`, `subject_id`, `source`, `source_ref`, `observed_at`, `fresh_until`,
`revision`, `recorded_by`, `recorded_at`, `updated_at`. One row per tenant, subject and source
(`UNIQUE (tenant_id, subject_type, subject_id, source)`). Tenant FK, forced RLS, two-tenant
denial under the runtime role.

**F-2. Subjects.** `subject_type` is one of `contact`, `deal`, `booking`,
`booking_resource`, `intake_item`. The subject must exist in the caller's tenant
(`TenantDenied` otherwise). Recording needs the subject's permission: `customers` for
contacts and deals, `calendar` for bookings and resources, `intake` for intake items.

**F-3. Source names.** `source` matches `^[a-z][a-z0-9_.-]{0,62}$` (for example `owner`,
`website`, `import`, `google_calendar`). `source_ref` is an optional opaque reference (1 to
500 characters), for example a provider's record ID or a booking page ID.

**F-4. Observe: `source.observe`.** Payload `{sourceRecordId, subject: {type, id}, source,
sourceRef?, observedAt?, freshForMinutes?}`; target `{type: "source_record", id:
sourceRecordId}`. The edge derives `sourceRecordId` from tenant, subject and source, so the
same subject and source always name the same record. `observedAt` defaults to the
dispatcher's clock and may not be later than it (`ValidationFailed`). It must lie in UTC
years 0001 through 9999 (`supportedInstantSchema`); a time outside is refused with
`ValidationFailed` and nothing is written. `freshForMinutes` is 1 to 525600 (one year);
absent means the fact does not go stale (`fresh_until` NULL).
`fresh_until = observedAt + freshForMinutes`; it and the dispatcher's clock must lie in the
same range, or the request fails with `ValidationFailed` and nothing is written. Records and
replayed results accept any stored UTC ISO instant.

**F-5. Monotonic.** The first observation inserts the row with `revision = 1`. A later one
with `observedAt` after the stored `observed_at` replaces `source_ref`, `observed_at` and
`fresh_until`, increments `revision` and sets `updated_at` to the dispatcher's clock, or to
`recorded_at` when that is later (the clock is read before the record lock, so a writer that
read it earlier can take the lock after a later insert). An observation that is not newer
(late or replayed out of order) changes nothing and returns the stored record with
`applied: false`. The row is locked `FOR UPDATE` before the comparison.

**F-6. Freshness.** A record is fresh when `fresh_until` is NULL or `now < fresh_until`,
against the injected clock. `requireFresh(tx, tenantId, subject, now, {source?})` returns the
freshest matching record or throws `Conflict` with reason `stale_source` (no record, or none
fresh).

**F-7. Reads.** `GET /v1/sources?subjectType=&subjectId=` lists a subject's records, most
recently observed first, each with `fresh`. Same permission as F-2.

**F-8. Immutability.** The runtime role may INSERT a record and UPDATE only `source_ref`,
`observed_at`, `fresh_until`, `revision` and `updated_at`; it may not DELETE.

## Tests

- Catalog isolation (`packages/db/test/isolation.test.ts`) covers both tables.
- `packages/core/test/approvals.test.ts`: request, approve and run, reject, revoke before and
  after a run, expiry against the injected clock, staff denied deciding, staff sees only own
  requests, two-tenant denial, required actions refused directly, one action per approval,
  concurrent approve-run and revoke, binding immutability under the runtime role, partial
  revocation and decision columns refused, the clock read after the row lock, a failed run
  retried with a fresh key, reserved run keys refused.
- `packages/core/test/sources.test.ts`: observe, monotonic replays, freshness edges, subject
  ownership, permission per subject, `requireFresh`, lock order that differs from clock order.
- API and MCP tests cover the routes and tools.
