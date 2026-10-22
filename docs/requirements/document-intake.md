# Document intake: PDF to catalog and agent knowledge

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: an owner uploads a PDF (a price list, line sheet or product catalog). A Docling worker
extracts its tables offline, with page and bounding-box provenance for every row. The server
turns the rows into one reviewable diff against the tenant's catalog (or, later, its agent
knowledge). The owner toggles rows in or out and approves the diff once; only then does any row
become live. Docling runs as a separate Python service behind a typed port; a TypeScript fake
implements the same port, so `pnpm -r test` needs no Python, no model weights and no network.

This file also introduces the first catalog tables, `catalog_items` and `knowledge_entries`.
They are new and kept minimal on purpose: only what intake needs to insert, update and compare
rows. Store sync, variants, stock and images wait for their own contracts.

Out of scope: `.xlsx` and `.docx` (later), scanned forms and handwriting, any language model in
the extraction path, Shopify or other store connections (`integrations.md`), catalog editing
screens, and linking images to items (`image-port.md`).

## Evidence and decisions

- `integrations.md`, row "Docling": build, PDF first, rows approved as one diff. Owner areas:
  Site (catalog) and Agents. Build order step 5; it feeds the `document_intake` agent kind.
- Document intake accepts PDF only in the first slice; `.xlsx` and `.docx` come later. Decided
  2026-10-22 (coordinator, standing approval).
- Docling runs offline, with no remote services and no plugins, as a Python service behind a
  port with a TypeScript fake. It may run on the pilot Mac, pulling jobs over HTTPS with no
  inbound port. PDFs are untrusted data. Only commercial-safe weights run, from an allowlist
  with licences. Decided 2026-10-22 (supervisor brief).
- The owner reviews intake rows as one diff, toggles rows in or out, and approves the job once
  (`catalog.intake.apply`), rather than approving each row. Decided 2026-10-22 (supervisor
  brief).
- Docling (from its public project pages, in our own words): MIT code; converts PDFs into a
  document model whose items carry a page number and bounding box. Its default layout, table
  and OCR models are published under Apache-2.0, MIT or CDLA-Permissive-2.0. Its converter
  takes a page and file-size cap and a per-document timeout, and its pipeline options can turn
  off remote services and external plugins and point at a local model folder. Option names are
  checked against the pinned version when the service is written.
- Self-hosted, so no metered vendor and no wallet reservation. Sizing from the research report:
  2 to 4 CPU cores and 4 GiB of memory, no GPU.
- Repo facts this file builds on: `sourceSubjectTypeSchema` (`packages/contracts/src/
  sources.ts:12`), `APPROVAL_POLICIES` (`packages/core/src/approvals/policy.ts:15`),
  `SERVER_IDEMPOTENCY_PREFIXES` (`packages/contracts/src/http.ts:27`), permissions `publish`
  and `agents` (`packages/contracts/src/members.ts:21`), and the outbox lease pattern
  (`delivery.md` D-2, D-3).

## Numbered rules

**DL-1. Tables.** Four new tables, each with tenant FK, forced RLS with the tenant policy, and a
place in the catalog isolation suite (`packages/db/test/isolation.test.ts`):
- `catalog_items`: `tenant_id`, `id`, `sku`, `title`, `description`, `price_minor`,
  `currency`, `attributes` (JSONB, flat string map, at most 30 keys), `active`, `revision`,
  `created_at`, `updated_at`; `UNIQUE (tenant_id, sku)`.
- `knowledge_entries`: `tenant_id`, `id`, `slug`, `section_title`, `body_text`, `active`,
  `revision`, `created_at`, `updated_at`; `UNIQUE (tenant_id, slug)`.
- `document_intake_jobs`: `tenant_id`, `id`, `target_kind` (`catalog` or `knowledge`),
  `source` (`upload`, or `browser:<runId>` when the owner sends a browser-task artifact,
  `browser-tasks.md` BT-13), `filename`, `file_sha256`, `byte_length`, `page_count`, `status`, `failure_reason`,
  `parser_version`, `diff_digest`, `attempts`, `lease_token`, `lease_expires_at`,
  `created_by`, `created_at`, `finished_at`.
- `document_intake_rows`: `tenant_id`, `id`, `job_id`, `row_index`, `diff_op`,
  `invalid_reason`, `existing_target_id`, `existing_revision`, `proposed_payload` (JSONB),
  `page_no`, `bbox` (JSONB), `source_snippet`, `included`.

**DL-2. Catalog rows change only through intake.** In this contract no action but the apply
actions (DL-13) writes `catalog_items` or `knowledge_entries`, and no route copies a request body
into them. The runtime role has no DELETE grant on either; an item is retired with `active =
false`. `revision` starts at 1 and grows by one on every write. A test proves that a job in
`review` leaves both tables untouched.

**DL-3. Upload: `catalog.intake.upload`.** Needs `publish` (`knowledge.intake.upload` needs
`agents`). Its input is either uploaded bytes (`source` `upload`) or `{ browserRunId,
artifactId }` (`source` `browser:<runId>`, `browser-tasks.md` BT-13): the run and its artifact
must belong to the caller's tenant (`TenantDenied` otherwise), and the server copies the
artifact's bytes from that tenant's storage, then applies the same checks. It accepts one file whose declared type is `application/pdf` and whose bytes start with
`%PDF-`, at most 20 MiB (20,971,520 bytes); anything else, including `.xlsx` and `.docx`, is
`ValidationFailed` before any byte is stored. The filename is kept only as display text (1 to
200 characters, `isPostgresText`). The server stores the bytes at
`t/<tenantId>/intake/<jobId>/<sha256>.pdf`, then commits a `queued` job.

**DL-4. Job states.** `status` is one of `queued`, `claimed`, `review`, `applied`,
`discarded`, `failed`. Allowed moves: `queued -> claimed -> review -> applied`, `review ->
discarded`, `claimed -> queued` (lease lost), `queued | claimed -> failed`. A trigger refuses
any other move. A job whose lease expires three times fails `worker_error`.

**DL-5. The worker pulls; nothing pushes to it.** The Python service (`services/docling-
worker`) calls the API over HTTPS with a server-minted worker token:
`POST /v1/workers/document-intake/claim` (one job, a lease token, an expiry),
`GET /v1/workers/document-intake/jobs/:id/file` and
`POST /v1/workers/document-intake/jobs/:id/result`. The token's principal can call these three
routes and nothing else; it holds no member permission. File and result calls need the job's
live lease token (`Conflict`, `lease_lost`, otherwise). The server takes the tenant from the
job row, never from a request body. The host running the worker, such as the pilot Mac, opens
no inbound port.

**DL-6. Offline sandbox.** The service runs Docling with remote services off, external plugins
off and models loaded only from a local folder baked in at build time. Its only network
destination is the API host. At start-up it checks these settings and refuses to run if any is
wrong; a test of the service (run on the Mac, not in CI) proves an outbound call to any other
host fails.

**DL-7. Pinned, permissive models.** The service pins its Docling version and every Python
dependency with hashes. `DOCLING_MODEL_ALLOWLIST` lists each model with its licence: layout,
table structure and figure classifier models under Apache-2.0, MIT or CDLA-Permissive-2.0, and
RapidOCR, EasyOCR or Tesseract for OCR. GPL or non-commercial models (for example Surya OCR)
are forbidden. No vision-language model runs in the first slice. The start-up check refuses a
model folder holding anything off the list.

**DL-8. Limits.** The worker refuses more than 50 pages (`too_many_pages`) and stops any
document after 90 seconds (`timeout`); either fails the job and writes no rows. A result holds
at most 5,000 rows. Scratch files live under a per-job temp directory deleted when the job ends,
pass or fail.

**DL-9. The port and its fake.** `DoclingPort.extract(input)` in
`packages/core/src/document-intake/port.ts` takes `{tenantId, jobId, fileSha256, bytes,
maxPages}` and returns `{pageCount, parserVersion, tables}`: each table has header cells and
rows of cells, and each row has a page number, a bounding box and a source snippet. The JSON
shape is a zod schema in `packages/contracts/src/document-intake.ts`, which the Python service
also implements. `runDocumentIntakeWorker({ api, port })` is the TypeScript pull loop.
`createFakeDoclingPort()` returns fixed rows, can fail, time out or exceed limits, and lets
tests run the whole loop in process.

**DL-10. PDF content is data.** The API validates every result with the schema before it
writes anything: every string passes `isPostgresText` and has control characters stripped, a
cell is at most 2,000 characters and a snippet at most 500. A result that fails is refused
whole (`ValidationFailed`) and the job fails `invalid_result`. Extracted text is never sent to a
model, a URL or a template in this contract. A later reader of intake text, such as the
`document_intake` agent kind, treats it as quoted data (`agents.md`).

**DL-11. Rows and the diff.** Server code maps header cells to fields with a fixed synonym list
(for catalog: SKU, title, description, price, currency) and parses prices deterministically
into minor units; a missing currency takes the business profile's (`business-profile.md`).
Each row is compared by `sku` (or `slug`) with the tenant's live rows and gets `diff_op`
`insert`, `update` (with `existing_target_id`, `existing_revision` and the changed fields),
`unchanged` or `invalid` (no key, an unparseable price, a key repeated in the same job). The
job stores `diff_digest`, a SHA-256 over the canonical rows, and moves to `review`. Live rows
do not change.

**DL-12. Provenance.** Every intake row has `page_no` from 1 to the job's `page_count`, a
`bbox` of four numbers inside the page, and a `source_snippet` (CHECK constraints). The review
screen and the approval view show them next to each row.

**DL-13. One approval for the job.** `catalog.intake.apply` takes `{jobId, includedRowIds,
diffDigest}` and joins `APPROVAL_POLICIES` as `{ request: "publish", required: true }`;
`knowledge.intake.apply` is the same with `request: "agents"`. Both run only through
`approvedDispatch` (`approvals.md` A-7, A-9). `included` holds the server's default (true for
`insert` and `update`); the owner toggles rows, and the payload's sorted, unique
`includedRowIds` is what the approval binds. The approver sees every included row's proposed
values, current values, page and snippet (A-12). The handler locks the job `FOR UPDATE` and
refuses with `Conflict` when the job is not `review` (`intake_not_in_review`), the digest
differs (`intake_changed`), or a target's revision moved or an inserted SKU now exists
(`intake_target_changed`). An included `unchanged` or `invalid` row is `ValidationFailed`.

**DL-14. Apply in one transaction.** The handler writes the included rows, sets the job
`applied`, records one source record per written row (`source: "document_intake"`,
`sourceRef: "<jobId>:p<pageNo>#r<rowIndex>"`) and commits an outbox event
`catalog.intake.applied`, in one transaction. Rows left out are never written.
`sourceSubjectTypeSchema` gains `catalog_item` (permission `publish`) and `knowledge_entry`
(permission `agents`).

**DL-15. Reserved keys.** Worker writes use idempotency keys
`document-intake:<jobId>:<attempt>`, and `document-intake:` joins
`SERVER_IDEMPOTENCY_PREFIXES`, so a member key cannot take a worker step first (`approvals.md`
A-14). A replayed result for the same attempt returns the stored outcome.

**DL-16. Tenancy outside Postgres.** Stored PDFs and scratch folders are keyed by the
server-derived tenant and job. A worker holding a lease for a tenant A job cannot fetch a
tenant B file or post rows into a B job. Stored PDFs are deleted 30 days after the job ends.
A two-tenant test covers files and rows.

## First slice

Build DL-1 to DL-5 and DL-8 to DL-16 for `target_kind = catalog`, with the fake port only. The
Python service (DL-6, DL-7) and the knowledge target are the next slices.

Acceptance test (`packages/core/test/document-intake.test.ts`, fake port, injected clock, two
tenants):
1. Halden & Rowe's owner uploads a 2-page PDF; a `.docx` and a 21 MiB file fail
   `ValidationFailed`; a staff member's upload is refused.
2. The worker loop claims the job and posts the fake's rows. The job is `review` with one
   `insert`, one `update` and one `invalid`, each with `page_no` and `bbox`; `catalog_items`
   is unchanged.
3. A fake result of 51 pages fails `too_many_pages` and writes no rows; a result holding a NUL
   byte fails `invalid_result`.
4. A direct member call of `catalog.intake.apply` is `TenantDenied`.
5. The owner leaves the `update` out, requests and approves the apply: one `catalog_items` row
   is inserted, the updated item keeps its revision, and one source record names the page and
   row.
6. A second job whose target revision moved before approval fails `intake_target_changed`.
7. Tenant B cannot read A's jobs, rows or items under the runtime role, and A's worker lease
   cannot fetch B's file.

Unit tests: a key starting `document-intake:` is refused by `idempotencyKeySchema`; the runtime
role cannot delete a `catalog_items` row.

## Known limits

- `catalog_items` and `knowledge_entries` are minimal and new. They will need a revision when
  store sync, variants, stock or images arrive.
- Header mapping uses a fixed synonym list; a PDF with other headings yields `invalid` rows.
  Owner-chosen column mapping is a later revision.
- Open question: how knowledge PDFs (policies, care guides) split into entries and slugs.
  Settled before the knowledge slice.
- Open question: where the worker runs in production once there is more than one pilot (the
  pilot Mac or a hosted container).
- There is no invoice or accounting target kind. A supplier invoice sent from a browser task
  (`browser-tasks.md` BT-13) can only be read as a catalog document until a revision adds one.
- The worker sees every tenant's PDFs it is given; isolation between tenants rests on the
  server-side checks in DL-5 and DL-16, not on the worker.
