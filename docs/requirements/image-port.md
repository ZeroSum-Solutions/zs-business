# Image port: product image variants

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: an owner uploads a product photo and asks for a variant from a fixed preset (background
removed, studio background, upscaled). A server worker runs the preset through one image port,
paid per job from the tenant's prepaid wallet, and stages the result. The variant reaches a
site release only after an owner approves it. One port, three adapters: Kie.ai or FAL in
production, Higgsfield in development, and later a self-hosted ComfyUI service. Tests use a
TypeScript fake, so `pnpm -r test` needs no vendor key, no Python and no network.

Out of scope: social posts (`integrations.md`, social publishing), any preset that re-renders
the product itself (Known limits), linking images to catalog items, image search or
recommendations (`future/discovery.md`), and dashboard screens beyond the approval view.

## Evidence and decisions

- `integrations.md`, row "Image port": build Kie.ai or FAL in production billed to the tenant
  wallet, Higgsfield in development, product pixels locked. Owner area: Site.
- Production image jobs run on Kie.ai or FAL (both approved metered vendors), priced per job
  and billed to the tenant's prepaid wallet: reserve before the call, capture once, release on
  failure (`delivery.md` D-11, reservations for any priced job, being added in the same
  revision set). Higgsfield (subscription credits) is used in development only and never
  serves tenant production traffic. Decided 2026-10-22 (coordinator, standing approval).
- ComfyUI is a later adapter behind the same port, run unmodified as a separate service
  (GPL-3.0, never bundled or linked). Decided 2026-10-22 (supervisor brief).
- Background swap locks the product's pixels: the product is cut out with an alpha matte and
  composited unchanged over the generated background; no relighting or re-rendering of the
  product. A variant whose product pixels differ from the source inside the matte fails a
  check. Decided 2026-10-22 (coordinator, standing approval).
- Only commercial-safe weights run, from an allowlist that records each licence. FLUX dev
  weights (FLUX.1-dev, FLUX.1-Fill-dev, FLUX.1-Redux-dev, FLUX.2-dev, non-commercial licence)
  and non-commercial background removers (for example BRIA RMBG-1.4) are forbidden. Decided
  2026-10-22 (supervisor brief).
- Image jobs never change catalog facts. Product facts come from approved store data, never
  from an image model (`future/discovery.md` rule 5, line 181). Decided 2026-10-22
  (supervisor brief).
- Licences (from public project pages, in our own words): the Higgsfield CLI is MIT; ComfyUI is
  GPL-3.0, whose copyleft attaches to distribution, so a separate unmodified service we call
  over HTTP adds no obligation to this repo. Weights carry their own licences, separate from
  the engine.
- Repo facts this file builds on: blobs are content-addressed under `t/<tenantId>/` by
  `siteObjectKeys` (`packages/contracts/src/sites.ts:245`); a site file is at most
  `SITE_LIMITS.fileBytes` (10 MiB, `sites.ts:12`); `site.*` actions can never be approved
  (`isSiteAction`, `packages/core/src/approvals/policy.ts:30`), so image actions use the
  `media.` prefix; generating needs `publish` (`packages/contracts/src/members.ts:21`).

## Numbered rules

**IM-1. Tables.** `media_assets` holds images a tenant may publish: `tenant_id`, `id`, `sha256`,
`content_type`, `byte_length`, `width`, `height`, `origin` (`upload` or `variant`),
`variant_id` (null for uploads), `created_by`, `created_at`, with `UNIQUE (tenant_id, sha256)`.
`image_variants` holds one job each: `tenant_id`, `id`, `source_asset_id`, `source_sha256`,
`preset`, `params` (JSONB), `status`, `failure_reason`, `sha256`, `matte_sha256`, `adapter`,
`model_id`, `model_license`, `workflow_hash`, `prompt_text`, `provider_job_id`,
`price_minor`, `currency`, `vendor_cost_micros`, `created_by`, `created_at`, `staged_at`,
`expires_at`, `approved_at`, `promoted_at`. Tenant FK, forced RLS with the tenant policy, and
both tables in the catalog isolation suite (`packages/db/test/isolation.test.ts`).

**IM-2. States.** `status` is one of `queued`, `running`, `staged`, `approved`, `promoted`,
`failed`, `expired`. Allowed moves: `queued -> running -> staged -> approved -> promoted`,
`queued | running -> failed`, `staged -> expired`. A transition trigger refuses any other move,
and CHECK constraints tie each state to its columns (`staged` and later have `sha256` and
`staged_at`; `failed` has `failure_reason`).

**IM-3. Upload: `media.asset.upload`.** Needs `publish`. Accepts `image/png`, `image/jpeg` and
`image/webp` up to `SITE_LIMITS.fileBytes`, at most 8192 px a side and 40 megapixels decoded;
anything else is `ValidationFailed` before any byte is stored. The server computes the SHA-256,
stores the bytes at `mediaObjectKeys.asset(tenantId, sha256)` =
`t/<tenantId>/media/assets/<sha256>` (put only if absent), then commits the row. A second
upload of the same bytes returns the existing asset.

**IM-4. Presets only.** `media.variant.generate` (needs `publish`) takes `{variantId,
sourceAssetId, preset, params}`. `preset` is one of `background_remove`,
`studio_background_swap`, `upscale_2k`. `params` is a strict schema per preset: an aspect ratio
from a fixed list and, for `studio_background_swap`, a background description of 1 to 300
characters that passes `isPostgresText`. A caller cannot pass a model, a workflow graph, a
node, a weights file or a vendor option; an unknown field is `ValidationFailed`. The action
commits a `queued` variant, its price (IM-7) and an outbox event `media.variant.requested`.

**IM-5. The port.** `ImageWorkflowPort.runPreset(input)` in `packages/core/src/images/port.ts`
takes the tenant, variant, preset, params, source bytes and source SHA-256, and an idempotency
key equal to the variant ID. It returns the output bytes (`image/png` or `image/webp`),
width, height, SHA-256, the matte for presets that cut the product out, and provenance:
adapter (`kie`, `fal`, `higgsfield`, `comfyui` or `fake`), model ID, workflow hash, resolved
prompt, provider job ID and vendor cost. The worker recomputes every digest from the bytes and
refuses a mismatch as `failed` (`digest_mismatch`). `createFakeImageWorkflowPort()` is
deterministic, records `.calls`, and can be told to fail, to time out or to alter product
pixels, so every branch below has a test.

**IM-6. Adapters by environment.** The deploy names one adapter in injected config. Production
accepts only `kie` or `fal`; config naming `higgsfield` or `fake` in production fails at
start-up, so Higgsfield credits never serve tenant traffic. Adapter HTTP calls go only to the
vendor's fixed HTTPS host, refuse redirects, and read their key from config, never from a
request. The `comfyui` adapter, when built, submits a server-frozen graph per preset to a
separate ComfyUI service over authenticated HTTPS; ComfyUI is never imported, vendored or
shipped in this repo.

**IM-7. Paid per job from the wallet.** Each `(adapter, preset)` has a server price in the
tenant wallet's currency, in minor units, recorded on the variant at generate time. Before
the vendor call the worker reserves that price under `delivery.md` D-11 (job kind `image_job`,
job id the variant id; no funds: the
variant fails `insufficient_funds` and nothing is called). A staged variant captures the
reservation once; a definite failure, including a failed check (IM-9), releases it. A call
whose outcome is unknown (timeout, lost connection) keeps the reservation held and is never
sent again: the worker asks the vendor for the recorded provider job ID, and without an answer
by `outcomeWaitMs` the variant fails `outcome_unknown` with the reservation held for an
operator, as `delivery.md` D-8 does for messages.

**IM-8. Commercial-safe weights only.** `IMAGE_MODEL_ALLOWLIST` (`packages/core/src/images/
allowlist.ts`) lists each `(adapter, modelId)` with its weights' licence and, for self-hosted
weights, the file's SHA-256. The worker refuses any model not on the list before it reserves
or calls (`failed`, `model_not_allowed`). The list never holds FLUX dev weights or a
non-commercial background remover, and a unit test fails if it does. Self-hosted weights load
only from `.safetensors` files whose digest matches; `.ckpt`, `.pt` and other pickle formats
are refused.

**IM-9. Product pixel lock.** For `background_remove` and `studio_background_swap` the
adapter returns the matte and, for a swap, the generated background; our own code (not the
vendor) builds the output. The worker first validates the matte: it must have the source's
width and height, and its product region (alpha above 0) must cover between 2% and 98% of the
pixels, or the variant fails `matte_invalid` (an empty or full matte never passes). The matte
and the background are stored with their SHA-256 (`matte_sha256`). The output is a fixed
composite: each pixel is `source × alpha + background × (1 − alpha)`, with transparency as the
background for `background_remove`, at the source's width and height. After every job the
worker recomputes that composite from the stored source, matte and background and requires
byte equality with the output over every pixel whose alpha is above 0, partial alpha included.
Any difference fails the variant with `product_pixels_changed`, and a size change fails it with
`size_changed`. No preset relights, recolours or re-renders the product. Tests: an empty matte
and a full matte fail `matte_invalid`; an output with one changed partial-alpha pixel fails
`product_pixels_changed`. Whether the matte follows the product's real edge is for the owner's
approval (IM-12); no automatic check proves it.

**IM-10. Catalog facts are out of reach.** The image worker's principal holds only
`media.variant.stage` and `media.variant.fail`. No image action writes catalog, knowledge or
CRM tables, and `promptText` is never copied into them. A test runs a variant end to end
and proves no catalog row changed.

**IM-11. Staging.** A finished variant's bytes go to `mediaObjectKeys.staging(tenantId,
variantId, sha256)` = `t/<tenantId>/media/staging/<variantId>/<sha256>` and the row becomes
`staged` with `expires_at = staged_at + 14 days`. Keys are built from the server-derived
tenant, never from a request. A variant past `expires_at` cannot be approved (`Conflict`,
`variant_expired`), and a sweep deletes its staging objects and sets `expired`. Vendor
temporary URLs are fetched once into staging and never stored or shown.

**IM-12. Approval gate.** `media.variant.approve` (payload `{variantId, sha256}`) joins
`APPROVAL_POLICIES` (`policy.ts:15`) as `{ request: "publish", required: true }`, so it runs
only through `approvedDispatch` (`approvals.md` A-7, A-9). The approver sees the source and the
variant side by side with the full provenance (A-12). The handler checks the variant is
`staged`, unexpired and its `sha256` equals the payload's (`Conflict`, `variant_changed`), sets
`approved` and commits an outbox event `media.variant.approved`. The handler touches no object
store.

**IM-13. Promotion.** A promotion worker consumes `media.variant.approved`, copies the staged
bytes to `mediaObjectKeys.asset(tenantId, sha256)` (put only if absent; an existing object must
have the same digest), inserts a `media_assets` row with `origin = variant`, and sets
`promoted`, in one transaction after the copy. A repeat event changes nothing.

**IM-14. Site release check.** The site publish path (`packages/core/src/sites/publish.ts`)
refuses a release in which any compiled file with an `image/*` media type has a SHA-256 that is
not a `media_assets` row of the same tenant: `Conflict` with reason `image_not_approved`, and no
file is stored. A staged, failed or expired variant, and another tenant's asset, are refused.

**IM-15. Provenance is immutable.** The runtime role may INSERT variants and UPDATE only
`status`, `failure_reason` and the time columns. `source_*`, `adapter`, `model_*`,
`workflow_hash`, `prompt_text`, `provider_job_id`, `sha256` and price columns are fixed once
set (column grants plus the trigger). `sourceSubjectTypeSchema` (`packages/contracts/src/
sources.ts:12`) gains `media_asset` (permission `publish`), and each promotion records a source
record `{source: "image_variant", sourceRef: variantId}`.

**IM-16. Reserved keys and tenancy outside Postgres.** Worker writes use idempotency keys
`image-job:<variantId>:<step>`, and `image-job:` joins `SERVER_IDEMPOTENCY_PREFIXES`
(`packages/contracts/src/http.ts:27`), so a member key cannot take a worker step first
(`approvals.md` A-14). Scratch files live under a per-tenant, per-variant temp directory deleted
after each job. A two-tenant test proves a worker step for tenant A cannot read or write tenant
B's objects or rows.

## First slice

Build IM-1 to IM-5, IM-7 to IM-16 with the fake adapter only (IM-6 config check included; no
vendor adapter yet). Needs `delivery.md` D-11 first.

Acceptance test (`packages/core/test/images.test.ts`, fake port, injected clock, two tenants):
1. Halden & Rowe's owner uploads a ring photo; a second upload of the same bytes returns the
   same asset.
2. `media.variant.generate` with a model ID in `params` fails `ValidationFailed`.
3. A `studio_background_swap` job reserves the price, stages a variant and captures once; the
   wallet ledger shows one capture.
4. A fake that alters one product pixel fails `product_pixels_changed`, releases the
   reservation and stages nothing.
5. Publishing a release that holds the staged variant fails `image_not_approved`.
6. The owner requests and approves `media.variant.approve`; after promotion the same publish
   succeeds and a `media_asset` source record exists.
7. A direct member call of `media.variant.approve` is `TenantDenied`; approving after 14 days
   is `variant_expired`.
8. No `catalog_items` row changed; tenant B cannot read A's variants under the runtime role.

Unit tests: the allowlist holds no forbidden weights; production config with `higgsfield` fails
start-up; a key starting `image-job:` is refused by `idempotencyKeySchema`.

## Known limits

- Open question: whether any preset that re-renders the product (a lifestyle scene) is ever
  allowed. It would break the pixel lock, so it is out until decided.
- Open question: which hosted model IDs on Kie.ai and FAL, and their licence terms for hosted
  use, go on the allowlist. That is settled when the first vendor adapter is written.
- Open question: per-job prices per preset, and whether a failed check should charge the
  tenant. This file releases the reservation, so we absorb the vendor cost of a failed check.
- `upscale_2k` changes pixels by design; only the side-by-side review guards fine details
  such as prongs and hallmarks.
- Uploads are owner-only (`publish`). Staff uploads need a new permission.
- An object stored by IM-3 whose row never commits stays as an orphan until a sweep exists.
