// Document intake over HTTP (docs/requirements/document-intake.md DL-3, DL-5, DL-12..DL-14, DL-18) as
// zs_runtime on a real database, with the fake Docling port standing in for the Python service.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INTAKE_MAX_BYTES,
  apiErrorBodySchema,
  approvalOutputSchema,
  intakeClaimResponseSchema,
  intakeJobDetailSchema,
  intakeJobListSchema,
  intakeUploadResultSchema,
  type ClaimedIntakeJob,
} from "@zs/contracts";
import { FAKE_PRICE_LIST, createFakeDoclingPort, runDocumentIntakeWorker, type IntakeWorkerApi } from "@zs/core";
import { call, createApiHarness, INTAKE_WORKER_TOKEN, ORIGIN, signedInMember, type ApiHarness, type MemberSetup, type TenantSetup } from "./helpers.js";

let h: ApiHarness;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness({ documentIntake: true });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const pdf = (size = 400): Uint8Array => {
  const bytes = new Uint8Array(size).fill(32);
  bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
  bytes.set(new TextEncoder().encode(`\n% ${randomUUID()}\n%%EOF`), size - 60);
  return bytes;
};

/** The raw PDF is the body, so this sidesteps `call`'s JSON encoding. */
async function upload(token: string, bytes: Uint8Array, options: { type?: string; key?: string; filename?: string } = {}) {
  const response = await h.app.request("/v1/document-intake/uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": options.type ?? "application/pdf",
      "Idempotency-Key": options.key ?? randomUUID(),
      "X-Filename": options.filename ?? "price-list.pdf",
    },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const worker = (path: string, options: { token?: string | null; lease?: string; body?: unknown; method?: string } = {}) =>
  call(h.app, options.method ?? "POST", `/v1/workers/document-intake${path}`, {
    ...(options.token === null ? {} : { token: options.token ?? INTAKE_WORKER_TOKEN }),
    ...(options.lease ? { headers: { "X-Lease-Token": options.lease } } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
  });

/** The worker's API over HTTP, which is how the Python service reaches the system. */
const httpWorker: IntakeWorkerApi = {
  async claim(): Promise<ClaimedIntakeJob | null> {
    return intakeClaimResponseSchema.parse((await worker("/claim")).body).job;
  },
  async file(jobId, leaseToken) {
    const response = await h.app.request(`/v1/workers/document-intake/jobs/${jobId}/file`, {
      headers: { Authorization: `Bearer ${INTAKE_WORKER_TOKEN}`, "X-Lease-Token": leaseToken },
    });
    if (response.status !== 200) throw new Error(`file ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  async result(jobId, leaseToken, body) {
    const response = await worker(`/jobs/${jobId}/result`, { lease: leaseToken, body });
    if (response.status !== 200) throw new Error(`result ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  },
  async fail(jobId, leaseToken, body) {
    // DL-5: the worker has three routes; a failure is a result body of its own.
    const response = await worker(`/jobs/${jobId}/result`, { lease: leaseToken, body });
    if (response.status !== 200) throw new Error(`fail ${response.status}`);
    return response.body;
  },
};

const detail = async (tenant: Pick<TenantSetup, "token">, jobId: string) => {
  const response = await call(h.app, "GET", `/v1/document-intake/jobs/${jobId}`, { token: tenant.token });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return intakeJobDetailSchema.parse(response.body);
};

describe("document intake over HTTP", () => {
  it("keeps the worker routes behind their own bearer token", async () => {
    expect((await worker("/claim", { token: null })).status).toBe(401);
    expect((await worker("/claim", { token: "wrong-token-wrong-token-wrong-token-1234" })).status).toBe(401);
    // A member token is not the worker's token.
    expect((await worker("/claim", { token: h.a.token })).status).toBe(401);
    expect((await worker("/claim")).status).toBe(200);
  });

  it("takes a PDF above the 64 KiB JSON limit, refuses an oversize body and a non-owner", async () => {
    const big = pdf(200 * 1024);
    const ok = await upload(h.a.token, big);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(intakeUploadResultSchema.parse(ok.body).status).toBe("queued");

    const over = await upload(h.a.token, pdf(INTAKE_MAX_BYTES + 100));
    expect(over.status).toBe(413);
    expect(errorOf(over).details).toEqual({ reason: "file_too_large" });

    const asStaff = await upload(staff.token, pdf());
    expect(asStaff.status).toBe(403);
    expect(h.documentIntake!.store).toBeDefined();

    const notPdf = await upload(h.a.token, pdf(), { type: "text/plain" });
    expect(notPdf.status).toBe(400);
    const noSignature = await upload(h.a.token, new TextEncoder().encode("hello, this is not a pdf at all"));
    expect(noSignature.status).toBe(400);
    expect((await call(h.app, "POST", "/v1/document-intake/uploads", { token: h.a.token })).status).toBe(400);
  });

  it("parses, shows the review diff, and applies chosen rows only after an approval", async () => {
    // Drain anything earlier tests queued so the next claim is this job.
    while (await httpWorker.claim()) { /* each claim leases one job; the lapse is not needed here */ }
    const key = randomUUID();
    const bytes = pdf();
    const uploaded = await upload(h.a.token, bytes, { key });
    expect(uploaded.status).toBe(201);
    const { jobId } = intakeUploadResultSchema.parse(uploaded.body);
    // A retried upload with the same key and bytes returns the same job.
    expect(intakeUploadResultSchema.parse((await upload(h.a.token, bytes, { key })).body).jobId).toBe(jobId);

    const claimed = await httpWorker.claim();
    expect(claimed?.id).toBe(jobId);
    const run = await runDocumentIntakeWorker({
      api: { ...httpWorker, claim: async () => claimed },
      port: createFakeDoclingPort(),
    });
    expect(run?.outcome).toMatchObject({ status: "review" });

    const job = await detail(h.a, jobId);
    expect(job.status).toBe("review");
    const inserts = job.rows.filter((row) => row.diffOp === "insert");
    expect(inserts).toHaveLength(2);
    expect(job.rows.find((row) => row.diffOp === "invalid")).toMatchObject({ invalidReason: "missing_key", pageNo: 2 });
    expect(job.rows[0]).toMatchObject({ pageNo: 1, sourceSnippet: expect.stringContaining("HR-1001") });

    // The owner proposes one row; nothing is written until it is approved.
    const chosen = inserts[0]!;
    const body = { includedRowIds: [chosen.id], diffDigest: job.diffDigest };
    const proposed = await call(h.app, "POST", `/v1/document-intake/jobs/${jobId}/apply`, { token: h.a.token, key: randomUUID(), body });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const approval = approvalOutputSchema.parse(proposed.body).result;
    const items = () => h.fixture.service(async (tx) => (await tx.query(
      "SELECT sku FROM catalog_items WHERE tenant_id=$1", [h.a.tenantId])).rows.map((row: { sku: string }) => row.sku));
    expect(await items()).toEqual([]);
    expect((await detail(h.a, jobId)).status).toBe("review");

    // A stale digest is refused as a conflict.
    const stale = await call(h.app, "POST", `/v1/document-intake/jobs/${jobId}/apply`, {
      token: h.a.token, key: randomUUID(), body: { ...body, diffDigest: "0".repeat(64) },
    });
    expect(stale.status).toBe(409);
    expect(errorOf(stale).details).toEqual({ reason: "intake_changed" });

    const approved = await call(h.app, "POST", `/v1/approvals/${approval.id}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await items()).toEqual([chosen.proposed!.sku]);
    expect((await detail(h.a, jobId)).status).toBe("applied");

    // Tenant B cannot see the job or the list entry.
    expect((await call(h.app, "GET", `/v1/document-intake/jobs/${jobId}`, { token: h.b.token })).status).toBe(404);
    const bList = intakeJobListSchema.parse((await call(h.app, "GET", "/v1/document-intake/jobs", { token: h.b.token })).body);
    expect(bList.items.map((item) => item.id)).not.toContain(jobId);
    expect((await call(h.app, "GET", "/v1/document-intake/jobs", { token: staff.token })).status).toBe(403);
  });

  it("offers the worker exactly three routes (DL-5) and takes a failure on the result route", async () => {
    while (await httpWorker.claim()) { /* drain */ }
    const { jobId } = intakeUploadResultSchema.parse((await upload(h.a.token, pdf())).body);
    const claimed = (await httpWorker.claim())!;
    expect(claimed.id).toBe(jobId);
    // The old /fail route is gone: the worker token is no member's, so the request falls through to member auth.
    expect((await worker(`/jobs/${jobId}/fail`, { lease: claimed.leaseToken, body: { reason: "timeout" } })).status).toBe(401);
    expect((await detail(h.a, jobId)).status).toBe("claimed");
    const failed = await worker(`/jobs/${jobId}/result`, { lease: claimed.leaseToken, body: { reason: "timeout" } });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body).toMatchObject({ status: "failed", failureReason: "timeout" });
    const after = await detail(h.a, jobId);
    expect(after).toMatchObject({ status: "failed", failureReason: "timeout" });
    // A replay returns the stored outcome.
    expect((await worker(`/jobs/${jobId}/result`, { lease: claimed.leaseToken, body: { reason: "timeout" } })).body).toMatchObject({ status: "failed" });
  });

  it("takes an apply request that lists the most rows a job can hold, and a result far over 64 KiB", async () => {
    // 2000 row IDs are 78 KB of JSON; the job is unknown, so the answer is 404, not 413 (DL-8, DL-13).
    const ids = Array.from({ length: 2000 }, () => randomUUID());
    const apply = await call(h.app, "POST", `/v1/document-intake/jobs/${randomUUID()}/apply`, {
      token: h.a.token, key: randomUUID(), body: { includedRowIds: ids, diffDigest: "0".repeat(64) },
    });
    expect(apply.status, JSON.stringify(apply.body)).toBe(404);
    const most = Array.from({ length: 5000 }, () => randomUUID());
    const largest = await call(h.app, "POST", `/v1/document-intake/jobs/${randomUUID()}/apply`, {
      token: h.a.token, key: randomUUID(), body: { includedRowIds: most, diffDigest: "0".repeat(64) },
    });
    expect(largest.status, JSON.stringify(largest.body)).toBe(404);
    // Other member routes keep the 64 KiB limit.
    const other = await call(h.app, "POST", `/v1/document-intake/jobs/${randomUUID()}/discard`, {
      token: h.a.token, key: randomUUID(), body: { padding: "x".repeat(70 * 1024) },
    });
    expect(other.status).toBe(413);
    // A 9 MB result body is not cut off by the worker limit: the unknown lease answers instead.
    const big = await worker(`/jobs/${randomUUID()}/result`, { lease: randomUUID(), body: { padding: "x".repeat(9 * 1024 * 1024) } });
    expect(big.status).toBe(409);
  });

  it("lets a browser on an allowed origin send the upload's filename header", async () => {
    const response = await h.app.request("/v1/document-intake/uploads", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,idempotency-key,x-filename" },
    });
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("x-filename");
  });

  it("discards a job in review", async () => {
    while (await httpWorker.claim()) { /* drain */ }
    const { jobId } = intakeUploadResultSchema.parse((await upload(h.a.token, pdf())).body);
    const claimed = await httpWorker.claim();
    expect(claimed?.id).toBe(jobId);
    await runDocumentIntakeWorker({ api: { ...httpWorker, claim: async () => claimed }, port: createFakeDoclingPort({ result: FAKE_PRICE_LIST }) });
    const discarded = await call(h.app, "POST", `/v1/document-intake/jobs/${jobId}/discard`, { token: h.a.token, key: randomUUID() });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect((await detail(h.a, jobId)).status).toBe("discarded");
    expect((await call(h.app, "POST", `/v1/document-intake/jobs/${jobId}/discard`, { token: h.b.token, key: randomUUID() })).status).toBe(404);
  });
});
