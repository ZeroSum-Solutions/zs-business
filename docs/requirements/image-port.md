# Image port: product image variants

Status: first slice built (2026-10-23); revision 2 (2026-10-24) adds IM-17 to IM-24 for vendor
adapters, HTTP routes, rejection and the dashboard. A change to a numbered rule needs a new
revision of this file first.

Scope: an owner uploads a product photo and asks for a variant from a fixed preset (background
removed, studio background, upscaled). A server worker runs the preset through one image port,
paid per job from the tenant's prepaid wallet, and stages the result. The variant reaches a
site release only after an owner approves it. One port, three adapters: Kie.ai or FAL in
production, Higgsfield in development, and later a self-hosted ComfyUI service. Tests use a
TypeScript fake, so `pnpm -r test` needs no vendor key, no Python and no network.

Out of scope: social posts (`integrations.md`, social publishing), any preset that re-renders
the product itself (Known limits), linking images to catalog items, image search or
recommendations (`future/discovery.md`), and dashboard screens beyond the Site screen's image
section (IM-24).

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

## Revision 2 (2026-10-24): adapters, routes, rejection and the Site screen

Rules IM-1 to IM-16 stand. These rules add to them; where one narrows an earlier rule it says so.

**IM-17. Kie.ai and FAL adapters.** `packages/core/src/images/adapters/{kie,fal}.ts` implement
`ImageWorkflowPort`. Each takes an injected `fetch`, clock and sleep, its API key and its vendor
costs from config (`VendorAdapterOptions`), and sends every request through `vendorFetch`: HTTPS
only, to the adapter's fixed host list (`KIE_HOSTS`, `FAL_HOSTS`), redirects refused. The key goes
only in the vendor's auth header and never into a URL, an error message or a log. A job is
submitted once, with the variant ID as the vendor's idempotency or client reference where the
vendor has one, then polled. Matte presets ask the vendor for a cut-out PNG with alpha at the
source's size; `buildMatteOutput` (adapters/shared.ts) takes the matte from that alpha and builds
our own composite (IM-9). A swap also asks for a background generated from the preset's fixed
prompt at the source's size, as PNG; it is fitted to the source's size if it differs. `upscale_2k`
returns the vendor's PNG or WebP. Result files are fetched once from the vendor's result hosts
(in the host list). A vendor answer that the job failed, a 4xx on submit, or an unreadable result
is `ImageAdapterRefused`; a timeout, a lost connection or a 5xx after submit is
`ImageOutcomeUnknown` with the provider job ID when it is known, and is never resubmitted. A swap
runs two vendor jobs; its provider job ID records both. Tests run only against handwritten
fixtures shaped like each vendor's public API docs (our own values, no copied text); no test,
script or CI job calls a vendor.

**IM-18. Lookup gets the job.** `lookup(providerJobId, input)` receives the same `PresetInput`
the job ran with (IM-5 changed), so an adapter can rebuild the composite after an unknown
outcome. The worker loads the source before it asks; a missing source fails `digest_mismatch`.

**IM-19. Vendor models start unverified.** Each `IMAGE_MODEL_ALLOWLIST` entry gains `verified`.
`findAllowedModel` returns only verified entries, so a listed but unverified model fails
`model_not_allowed` before any reservation or call (IM-8). Each adapter lists its model IDs with
the weights' licence and `verified: false`, marked `TODO verify`, until the owner has checked the
vendor's hosted-use terms. This settles which IDs are named; it does not settle their terms.

**IM-20. Prices and costs from config.** `parseImageConfig` takes `prices` (minor units of the
wallet currency, per preset). Only the fake adapter in the test environment may omit them
(`FAKE_TEST_PRICES`); any other config without prices fails at start-up. The vendor's cost per
preset (`vendorCostMicros`, micros of USD) is adapter config, recorded on the variant as
provenance. No price or cost for a real vendor is written in code; the deploy's values are marked
`TODO verify` until the owner confirms them against the vendor's price page.

**IM-21. Selection fails closed.** `createImageWorkflowPort(config, deps)` builds the configured
adapter. `kie` or `fal` without an API key or without vendor costs throws at start-up;
`higgsfield` and `comfyui` throw as not built. The API reads the adapter, environment, prices,
costs and key from its environment once at start-up (`apps/api/src/config.ts`); when image config
is absent, every `/v1/media` route is 404, as sites are.

**IM-22. HTTP routes.** Under `/v1/media`, member auth, the `publish` permission, every write
through the core session and the dispatcher with the `Idempotency-Key` header:

| Route | Does |
|---|---|
| `POST /v1/media/assets` | Upload: the raw image bytes as the body, its `Content-Type` one of IM-3's. Body limit `MEDIA_LIMITS.fileBytes` (not the 64 KiB JSON limit). 201 `MediaAssetOutput`. |
| `GET /v1/media/assets` | `{items: MediaAsset[]}` |
| `GET /v1/media/assets/:id/content` | The asset's bytes, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. |
| `POST /v1/media/variants` | Generate (IM-4): `{sourceAssetId, preset, params}`. 201 `ImageVariantOutput`, status `queued`. |
| `GET /v1/media/variants` | `{items: ImageVariant[]}` |
| `GET /v1/media/variants/:id` | One variant: the status check. |
| `GET /v1/media/variants/:id/content` | The staged bytes of a `staged`, `approved` or `promoted` variant; 404 otherwise. Headers as above. |
| `POST /v1/media/variants/:id/approval` | `{sha256}`: requests `media.variant.approve` through the approvals path (IM-12). 201 the approval; an owner then approves it at `POST /v1/approvals/:id/approve`. |
| `POST /v1/media/variants/:id/reject` | `{sha256}`: `media.variant.reject` (IM-23). |

Generating never reserves or calls a vendor: the worker reserves before its call (IM-7). Object
keys come from the session's tenant, never from the path. Another tenant's ID is `NotFound`.

**IM-23. Rejection.** `media.variant.reject` (payload `{variantId, sha256}`, needs `publish`, a
direct action, not approvable) moves a `staged` variant to the new state `rejected` with
`rejected_at` (IM-2 gains `staged -> rejected`). A digest that differs is `Conflict`
`variant_changed`; any other state is `Conflict` `variant_not_staged`; a repeat on a rejected
variant returns it unchanged. The expiry sweep deletes a rejected variant's staging file as it does
an expired one's. The reservation was captured at staging and stays captured: the vendor ran.

**IM-24. Site screen.** The dashboard's Site screen gains an Images section: upload a photo, pick
a preset (and a background description for a swap), see each variant's status, and for a staged
one the source and the variant side by side with its provenance and price, with Approve (request
then approve, as one owner action) and Reject. It uses the light-tray tokens
(`apps/dashboard/src/styles/theme.css`) and existing UI components, and the demo API adapter
serves it with no backend.

## Second slice

Build IM-17 to IM-24. Migration timestamps 20261024300000 to 20261024399999 (`rejected`,
`rejected_at`, the guard's new move), runs on PG 15 and 16, keeps forced RLS, and the isolation
suite still covers both tables.

Acceptance tests:
1. Route tests (`apps/api/test/media.test.ts`, fake port, two tenants): upload over HTTP, generate,
   run the worker, read the status and the staged bytes, request and approve, and the variant
   becomes `promoted`; tenant B's token gets `NotFound` for A's asset, variant and content; a
   member without `publish` is `Forbidden`; a generate with `params.modelId` is 400; a repeat with
   the same `Idempotency-Key` returns the same variant; with an empty wallet the variant fails
   `insufficient_funds` and the port saw no call; reject moves a staged variant to `rejected`.
2. Adapter fixture tests (`packages/core/test/images/{kie,fal}.test.ts`): each preset end to end
   against fixtures; the request goes to the fixed host with the key in its header only; a
   redirect and a result URL on another host are refused; a vendor failure is
   `ImageAdapterRefused`; a poll that runs past the timeout is `ImageOutcomeUnknown` with the job ID
   and no second submit; `lookup` finishes a job that was pending; a missing key fails at
   construction; the adapter's model IDs are on the allowlist, unverified, with no forbidden weights.
3. Config tests: `kie` without prices fails; `createImageWorkflowPort` without a key fails.
4. Dashboard unit tests for the image section's state logic, and a Playwright spec
   (`apps/dashboard/e2e/site-images.spec.ts`) in demo mode: upload, generate, see `staged`,
   approve, see `approved`; reject another.

## Known limits

- Open question: whether any preset that re-renders the product (a lifestyle scene) is ever
  allowed. It would break the pixel lock, so it is out until decided.
- Open question: the hosted-use terms of the Kie.ai and FAL model IDs the adapters name. They
  are listed unverified (IM-19) until the owner checks them.
- Open question: per-job prices per preset (config since IM-20, values `TODO verify`), and whether a failed check should charge the
  tenant. This file releases the reservation, so we absorb the vendor cost of a failed check.
- `upscale_2k` changes pixels by design; only the side-by-side review guards fine details
  such as prongs and hallmarks.
- Uploads are owner-only (`publish`). Staff uploads need a new permission.
- An object stored by IM-3 whose row never commits stays as an orphan until a sweep exists.

## First slice: what was built (2026-10-23)

Built: IM-1 to IM-5 and IM-7 to IM-16 with the fake adapter, and the IM-6 start-up check
(`parseImageConfig`). No vendor adapter, HTTP route or dashboard screen is in this slice, so the
site screen is unchanged. Differences from the text above:

- `image_variants` gains `background_sha256` (the generated background, kept so the composite can
  be rebuilt and compared).
- The runtime role holds column grants to update provenance on `image_variants`; the guard
  trigger makes each provenance column set-once and fixes the state moves (IM-15).
- `aspectRatio` accepts only `source` in this slice.
- Prices in `IMAGE_PRICES` are provisional (see Known limits).
- The matte presets decode PNG only; JPEG and WebP uploads are stored but a matte job on them
  fails `source_undecodable`.
- `upscale_2k` has no pixel lock, as it is not matte-based; the output header and size are
  checked (`output_invalid`, `size_changed`).
- The IM-14 publish gate refuses any `image/*` file that is not a tenant media asset. That also
  covers SVG and ICO files, so a release with a favicon needs it uploaded first or must drop it.
  This is an open risk for site specs that carry vector art.
- A worker crash between the hold and the vendor call is an unknown outcome and is never resent:
  after `outcomeWaitMs` the variant fails `outcome_unknown` and the hold stays for an operator.
- Uploads check the PNG is whole (chunks, image data, IEND) but a JPEG or WebP is checked by its
  header only: there is no decoder for either yet. Matte presets decode 8-bit non-interlaced
  grey, RGB, grey+alpha and RGBA PNG; other legal PNGs upload but fail `source_undecodable`.
- Two variants with identical output bytes share one asset (IM-1 keys assets by content), so the
  `media_asset` source record names the first variant that was promoted.
- Expiry deletes the staging file and retries recent expiries (7 days) on each pass; an older
  failed delete stays an orphan until the sweep named below exists.
- Acceptance step 8 checks `business_profiles` unchanged: no `catalog_items` table exists yet.
