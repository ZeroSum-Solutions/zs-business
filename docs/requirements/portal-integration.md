# Portal integration: how ZAB hands drafts to ZSB

Status: contract, revision 1 (2026-11-28). Work item ZSB-71, paired with ZAB-114 in the
`zs-agent-business` repo (ZAB). A change to a numbered rule (PI-n) needs a new revision of this
file first, and a matching change in ZAB-114.

Scope: the one path by which ZAB (the guided start flow, ZAB-58, and the canvas, ZAB-62) asks
ZSB for work on behalf of a tenant and gets a receipt back. ZSB is the control plane: it owns
tenant records, entitlements, approvals and publish state. ZAB owns canvas authoring and media
jobs. There is one identity and one tenant across both.

Out of scope: payments (see `plans.md`), the agency's own client work, answer tracking for
tenants (D9 below), and anything ZAB runs for its own agency purposes.

## Evidence and decisions

- ADR 0003 (`docs/adr/0003-one-go-live-release.md`): one Go live tap publishes one exact
  release, bound by digest, all or nothing. ZAB's site and AEO producers draft with
  tenant-scoped, draft-only access and never publish.
- ZSB-81, decision D-3 (2026-11-25): ZSB owns the whole first run; ZAB-58 is re-scoped to the
  producers that draft behind the companion.
- Decision D9 (Devin, 2026-11-28): the Jan 14 self-serve scope is the site audit and fix drafts
  only. No answer tracking for tenants on Jan 14.
- Decision D1 (Devin): automated anonymous Google capture is allowed for agency-run work only,
  never in ZSB.
- Decision D10 (pending Devin's yes): a small prepaid Cerebras amount for tenant drafts that
  read business facts. No tenant draft that reads business facts runs before it.
- `docs/integrations.md`, "Model lanes for tenant work": subscription lanes never carry tenant
  production traffic.

## Scope on Jan 14 (D9)

On 2027-01-14 self-serve opens by invitation. The portal path that is enabled is exactly:

1. **Site audit.** A deterministic check of the tenant's own public site, run in ZSB (PI-14).
2. **Fix drafts.** Draft files that fix what the audit found, written by ZAB producers or ZSB
   itself, held as draft release files until the owner taps Go live (ADR 0003).

Everything else is off on Jan 14 and returns `not_enabled`:

- answer tracking and the AI Visibility Check for tenants;
- any capture of Google or AI-assistant answers;
- any publish by ZAB;
- media jobs (ZAB-62) that publish or post. Canvas drafting that produces draft release files
  is in scope; canvas posting is not.

Turning a second path on needs a new revision of this file and an entry in the go/no-go list.

## Identity and tenant

- PI-1. The tenant is derived on the server from the job claim, never from the request body or
  from the envelope's `tenant_ref`. ZSB ignores `tenant_ref` and stores the claim's tenant.
- PI-2. ZAB calls ZSB with a service credential scoped to one tenant and one job. The
  credential grants draft-only access: read the job, post a result, post draft files. It cannot
  approve, publish, roll back or read another tenant's rows.
- PI-3. Every table that holds portal data has `tenant_id`, forced RLS and a two-tenant denial
  test that runs under the runtime role, not the service role.

## Routes (names are binding; paths may be adjusted only through ZAB-114)

All routes sit under `/internal/portal/` and take the service credential from PI-2.

| Purpose | Route |
|---|---|
| ZAB asks for work and takes a job claim | `POST /internal/portal/jobs/claim` |
| ZAB posts a result envelope for a claimed job | `POST /internal/portal/jobs/:job_id/result` |
| ZAB reads a receipt again | `GET /internal/portal/receipts/:receipt_id` |

ZAB calls ZSB only through these three routes. Storage uploads use the object keys that ZSB
issues in the claim (PI-9); there is no fourth route.

## Job claim and idempotency

A job claim is how ZSB hands one unit of work to one producer for one tenant.

- PI-4. ZSB creates the job when the owner starts a flow (for example "audit my site"). A
  producer asks for it with `jobs/claim`. The response names `job_id`, `kind`, the tenant's
  confirmed facts the kind may read, the input digest, an expiry and the object-key prefix for
  uploads. The tenant is held server-side and is not echoed for the producer to send back.
- PI-5. A claim is exclusive and expires. A producer that does not post a result before expiry
  loses the claim; the job returns to the queue and a later result for the stale claim
  stores nothing and gets an error receipt (`claim_expired`).
- PI-6. `job_id` is the id from the claim. A producer never invents one for tenant work.
- PI-7. Every result is an envelope of contract `zs.aeo` v1 with these fields (the full schema
  and fixtures live in ZAB under `tools/aeo/contract/v1/` and are mirrored in
  `packages/contracts/src/aeo.ts`, SS-051):

| Field | Rule |
|---|---|
| `schema_version` | Semver. An added field bumps the minor version. ZSB rejects an unknown major version. |
| `kind` | For Jan 14: `audit` or `work_order`. Any other kind returns `not_enabled`. |
| `job_id` | The claim's id (PI-6). |
| `idempotency_key` | SHA-256 hex of `job_id`, `kind`, producer version and the input digest. |
| `status` | `ok`, `partial` or `failed`. |
| `errors[]` | `{ code, where, message }`. Empty only when `status` is `ok`. |
| `producer` | `{ name, version, git_sha }`. |
| `subject` | `{ domain, brand, tenant_ref }`. `tenant_ref` is ignored (PI-1). |
| `payload` | The kind's body. |
| `evidence[]` | Evidence records (PI-10). |
| `draft_release_files[]` | Draft files (PI-12). Empty except for `work_order`. |

- PI-8. Idempotency: ZSB stores one row per `(tenant, idempotency_key)`. A repeat of the same
  key is a no-op and returns the first receipt. The same `job_id` with a different key and a
  stored result is a conflict (`job_already_resulted`); nothing new is stored.
- PI-8a. Status semantics: `ok` when every part ran; `partial` when at least one part ran and
  at least one failed; `failed` when nothing usable ran. `errors[].code` is a short fixed code.
  Raw model or page output never goes in `errors[]`. A `failed` result is stored and the owner
  sees a plain "could not finish" state, never a half result presented as complete.
- PI-8b. Validation: ZSB stores nothing and returns an error receipt on an unknown major
  version, a failed schema check or a hash mismatch (evidence or draft file digest).

## Receipt and storage evidence keys

- PI-9. Storage keys come from ZSB. The claim returns an object-key prefix in ZSB storage.
  ZAB uploads evidence and draft file bytes under that prefix, then names each object by key in
  the envelope. A `storage_key` is never a disk path and never a ZAB or Studio path; ZSB rejects
  any key outside the claim's prefix.
- PI-10. Each `evidence[]` entry carries `id`, `sha256`, `media_type`, `bytes` and
  `storage_key`. ZSB reads the stored object, recomputes `sha256` and `bytes`, and refuses on a
  mismatch.
- PI-11. A receipt is ZSB's answer to a result. It carries `receipt_id`, `job_id`,
  `idempotency_key`, `accepted` (true or false), `status` echoed from the envelope,
  `error` (a fixed code when `accepted` is false: `claim_expired`, `schema_invalid`,
  `unknown_major`, `hash_mismatch`, `key_outside_prefix`, `job_already_resulted`,
  `not_enabled`), the accepted evidence ids, the accepted draft file paths with digests, the
  release id the drafts joined (or null), and `stored_at`. A repeat of an accepted result
  returns the same receipt. The receipt holds no tenant data beyond ids and digests, so ZAB may
  log it.

## Draft release files

- PI-12. `draft_release_files[]` is empty except for `work_order` results that carry fix
  drafts. Each entry is `{ path, mediaType, sha256, bytes, storage_key }`. The first four fields
  match `siteFileSchema` in `packages/contracts/src/sites.ts`. The list is sorted by path, each
  path appears once, and the total size stays under the release limits, as `siteFilesSchema`
  requires.
- PI-13. Accepted draft files become draft files of the tenant's one open release. They are
  not public. Nothing is public before the owner's Go live tap (ADR 0003), which publishes the
  whole release, bound by digest, all or nothing. ZAB cannot approve, publish or roll back.
  The digests in the receipt equal the digests in the envelope (the SS-054 test).
- PI-13a. A draft that reads business facts is written on the Cerebras lane
  (`docs/integrations.md`), and only after D10 is approved. A draft that reads no business facts
  may use the cheapest approved lane. No tenant draft uses a subscription lane.

## What runs where

| Runs on the agency Mac Studio (ZAB, agency work only) | Runs in ZSB (tenant path) |
|---|---|
| Camoufox capture of Google AI Overview, AI Mode and Places (D1) | Tenant records, entitlements, approvals, publish state |
| The Python audit with the bot probe, behind written consent | The deterministic audit, ported to TypeScript (SS-052), no bot probe, no browser |
| The evidence store, the priority queue and the daily schedule | Job creation, job claims, idempotent ingest, receipts, storage |
| Answer tracking and monthly reports for agency clients | Draft release files and the one Go live release |
| Subscription model lanes for agency work | Only approved metered lanes for tenant work (Cerebras for business facts) |

- PI-14. The tenant audit runs in ZSB, so a Studio outage cannot block a tenant. The Studio
  never receives tenant secrets or tenant site credentials.
- PI-15. Agency evidence and prospect data never enter ZSB or this repo.
- PI-16. The tenant path has no subscription lane, no browser capture and no Studio host. A
  guard test (SS-055) fails when it gains one.

## No Google capture in ZSB (D1)

- PI-17. No code in ZSB runs Google capture, scrapes Google results, drives a browser against a
  search engine, or stores captured search answers for a tenant. Capture is anonymous, runs on
  the agency machine for agency-run work only, and is never resold as data. The tenant path
  fetches the tenant's own public pages and nothing else.
- PI-18. Camoufox never signs in, and ZSB holds no cookies or accounts for it. Logged-in
  browser work runs only in a person's browser session.

## Jan 13 go or no-go

Decided on 2027-01-13 for the 2027-01-14 invitation-only opening, in the ZAB-44 go/no-go. Each
check below is a command or a stored artifact with a pass or fail. Any fail means no-go for
that path, and the path stays off.

| # | Check | Pass |
|---|---|---|
| G1 | Contract merged both sides | This file is on `main`; ZAB-114 is done and ZAB-58 and ZAB-62 call only the three routes above |
| G2 | Golden fixtures agree | `pnpm --filter @zs/contracts test` passes with the pinned fixture checksums; the ZAB export verifies with `shasum -a 256 -c SHA256SUMS` |
| G3 | Audit parity | `pnpm --filter @zs/core test` passes the TypeScript-versus-Python parity test on every golden site |
| G4 | Tenant isolation | The ingest tests pass: tenant B cannot read tenant A's audit under the runtime role; the same envelope twice returns the same receipt and stores one row; the tenant comes from the job claim, not the envelope |
| G5 | Nothing public before Go live | The drafts tests pass: draft digests equal the envelope's, and nothing is public before Go live |
| G6 | Lane guard | The lanes test passes: the tenant AEO path has no subscription lane, no browser capture and no Studio host |
| G7 | Drafts lane approved | D10 has Devin's yes and the Cerebras lane is funded, or drafts that read business facts stay off |
| G8 | Receipt round trip, hosted | On the hosted preview, one test tenant runs claim, result, receipt and a repeat of the same result; the repeat returns the same receipt. Cleanup leaves no rows |
| G9 | Stale claim | A result after claim expiry returns `claim_expired` and stores nothing |
| G10 | Disabled paths answer | A `track` or `check` envelope returns `not_enabled` and stores nothing |
| G11 | ZAB cannot publish | The credential in PI-2 is refused on approve, publish and roll back |
| G12 | Public repo clean | No tenant data, prospect data, client names or secrets in fixtures or docs (`docs/licenses.md`, AGENTS.md) |

The go/no-go record names the exact enabled path: the site audit and fix drafts, through the
three routes, and nothing else. Jan 27 is the public launch and gets its own review.

## Known limits

- Route paths and the receipt field names are fixed here; ZAB-114 may only add fields.
- Answer tracking for tenants returns after Jan 14 under a new revision.
- The audit port covers the deterministic checks only; checks that need a bot probe or a
  browser stay agency-only.
