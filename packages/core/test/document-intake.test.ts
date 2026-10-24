// Document intake, first slice (docs/requirements/document-intake.md): a PDF price list goes in, a
// fake Docling parser returns tables, the server builds one diff with page and box for every row, and
// no catalog row changes until an owner approves. The clock is injected; the parser, the file store
// and the models are fakes, so no test reaches a vendor, a key or a model download.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActionError, CATALOG_INTAKE_APPLY_ACTION, Conflict, DOCUMENT_INTAKE_JOB_TARGET, INTAKE_LEASE_MS, INTAKE_MAX_BYTES,
  NotFound, Refused, TenantDenied, idempotencyKeySchema, type IntakeJobDetail, type MemberRole,
} from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  createDocumentIntakeSession, createFakeDoclingPort, FAKE_PRICE_LIST, InMemoryIntakeFileStore, intakeFilePath,
  memberDispatch, runDocumentIntakeWorker, type EdgeDependencies,
} from "../src/index.js";
import { createSession } from "../src/index.js";

const DAY = 86_400_000;
const START = Date.parse("2026-10-24T09:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };
const PDF = readFileSync(new URL("./fixtures/document-intake/price-list.pdf", import.meta.url));
/** A second, different PDF: the same bytes plus a trailing comment, so its SHA-256 differs. */
const pdfVariant = (n: number) => Buffer.concat([PDF, Buffer.from(`\n% variant ${n}\n`)]);

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let staffA: string;
let ownerB: string;
const store = new InMemoryIntakeFileStore();
const port = createFakeDoclingPort();

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const intake = () => createDocumentIntakeSession(deps(), { store });
const member = (actorId: string, tenant = tenantA) => intake().forMember({ tenantId: tenant, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  await service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error) { return error; }
  throw new Error("Expected a rejection");
}
const isValidation = (error: unknown) => (error as { code?: string }).code === "ValidationFailed";
const reason = (error: unknown) => (error as { details?: { reason?: string } }).details?.reason;

const catalog = (tenant = tenantA) => rows<{ id: string; sku: string; price_minor: string; revision: number; active: boolean }>(
  "SELECT id, sku, price_minor::text, revision, active FROM catalog_items WHERE tenant_id=$1 ORDER BY sku", [tenant]);

/** Upload, run the worker once, return the job id. */
async function intakeOne(bytes: Buffer, actor = ownerA, tenant = tenantA): Promise<string> {
  const queued = await member(actor, tenant).upload({ bytes, filename: "spring-prices.pdf", contentType: "application/pdf" }, randomUUID());
  const run = await runDocumentIntakeWorker({ api: intake().worker, port });
  expect(run?.job.id).toBe(queued.jobId);
  return queued.jobId;
}
const detail = (jobId: string, actor = ownerA, tenant = tenantA): Promise<IntakeJobDetail> => member(actor, tenant).get(jobId);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantA = fixture.a.tenantId;
  tenantB = fixture.b.tenantId;
  ownerA = await addMember(tenantA, "owner");
  staffA = await addMember(tenantA, "staff");
  ownerB = await addMember(tenantB, "owner");
  // The live catalog already lists the wool scarf, at a different price.
  await service((tx) => tx.query(
    `INSERT INTO catalog_items (tenant_id,id,sku,title,description,price_minor,currency,attributes,active,revision,created_at,updated_at)
     VALUES ($1,$2,'HR-2002','Wool scarf','Hand finished',3500,'USD','{"Color":"Grey"}'::jsonb,true,1,$3,$3)`,
    [tenantA, randomUUID(), new Date(START)],
  ));
});
afterAll(async () => { await database?.close(); });

describe("the fixture", () => {
  it("is a small PDF made for this repository, and the fake parser reads it as the price list", async () => {
    expect(PDF.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(PDF.byteLength).toBeLessThan(4096);
    const out = await port.extract({ tenantId: tenantA, jobId: randomUUID(), fileSha256: "0".repeat(64), bytes: PDF, maxPages: 50 });
    expect(out).toEqual(FAKE_PRICE_LIST);
    port.calls.length = 0;
  });
  it("a key with the server's prefix is refused for members (DL-15)", () => {
    expect(idempotencyKeySchema.safeParse("document-intake:abc:1").success).toBe(false);
  });
});

describe("DL-3 upload", () => {
  it("refuses staff before storing a byte, then refuses a wrong type, a wrong signature and an oversize file", async () => {
    const before = store.objects.size;
    expect(await rejection(member(staffA).upload({ bytes: PDF, filename: "a.pdf", contentType: "application/pdf" }, randomUUID()))).toBeInstanceOf(TenantDenied);
    const owner = member(ownerA);
    expect(await rejection(owner.upload({ bytes: PDF, filename: "a.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, randomUUID())))
      .toSatisfy(isValidation);
    expect(await rejection(owner.upload({ bytes: Buffer.from("MZ not a pdf at all"), filename: "a.pdf", contentType: "application/pdf" }, randomUUID())))
      .toSatisfy(isValidation);
    expect(await rejection(owner.upload({ bytes: new Uint8Array(INTAKE_MAX_BYTES + 1), filename: "a.pdf", contentType: "application/pdf" }, randomUUID())))
      .toBeInstanceOf(Refused);
    expect(store.objects.size).toBe(before);
    expect(await rows("SELECT 1 FROM document_intake_jobs WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
  });

  it("queues one job per key and keeps one object for a retry (DL-3, DL-16)", async () => {
    const key = randomUUID();
    const bytes = pdfVariant(0);
    const first = await member(ownerA).upload({ bytes, filename: "retry.pdf", contentType: "application/pdf; charset=binary" }, key);
    const again = await member(ownerA).upload({ bytes, filename: "retry.pdf", contentType: "application/pdf" }, key);
    expect(again).toEqual(first);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(store.objects.has(intakeFilePath(tenantA, first.jobId, sha))).toBe(true);
    expect(await rows("SELECT 1 FROM document_intake_jobs WHERE tenant_id=$1 AND id=$2", [tenantA, first.jobId])).toHaveLength(1);
    // Drain it so the next tests start with an empty queue.
    const run = await runDocumentIntakeWorker({ api: intake().worker, port });
    expect(run?.outcome?.status).toBe("review");
    await member(ownerA).discard(first.jobId, randomUUID());
  });
});

let reviewJob: string;
describe("DL-5, DL-10..DL-12 the worker posts tables; the server builds the diff", () => {
  it("leaves the job in review with provenance on every row and changes no catalog row", async () => {
    reviewJob = await intakeOne(pdfVariant(1));
    const job = await detail(reviewJob);
    expect(job.status).toBe("review");
    expect(job.pageCount).toBe(2);
    expect(job.parserVersion).toBe("fake-docling-1");
    expect(job.counts).toEqual({ insert: 1, update: 1, unchanged: 0, invalid: 1 });
    const byOp = Object.fromEntries(job.rows.map((row) => [row.diffOp, row]));
    expect(byOp.insert!.proposed).toMatchObject({ sku: "HR-1001", title: "Linen shirt", priceMinor: 4500, currency: "USD" });
    expect(byOp.insert!.proposed!.attributes).toEqual({ Color: "Sand" });
    expect(byOp.update!.changedFields).toEqual(["priceMinor", "attributes"].filter((name) => byOp.update!.changedFields.includes(name)));
    expect(byOp.update!.changedFields).toContain("priceMinor");
    expect(byOp.update!.current!.priceMinor).toBe(3500);
    expect(byOp.update!.proposed!.priceMinor).toBe(3850);
    expect(byOp.invalid!.invalidReason).toBe("missing_key");
    expect(byOp.invalid!.included).toBe(false);
    for (const row of job.rows) {
      expect(row.pageNo).toBeGreaterThanOrEqual(1);
      expect(row.pageNo).toBeLessThanOrEqual(2);
      expect(row.bbox).toHaveLength(4);
      expect(row.sourceSnippet.length).toBeGreaterThan(0);
    }
    expect(byOp.invalid!.pageNo).toBe(2);
    expect((await catalog()).map((item) => [item.sku, item.price_minor, item.revision])).toEqual([["HR-2002", "3500", 1]]);
  });

  it("a replay of the same result returns the first outcome and writes nothing more", async () => {
    const [claimed] = await rows<{ lease_token: string }>("SELECT lease_token FROM document_intake_jobs WHERE id=$1", [reviewJob]);
    const first = await intake().worker.result(reviewJob, claimed!.lease_token, FAKE_PRICE_LIST);
    expect(first.status).toBe("review");
    expect(first.counts).toEqual({ insert: 1, update: 1, unchanged: 0, invalid: 1 });
    expect(await rows("SELECT 1 FROM document_intake_rows WHERE tenant_id=$1 AND job_id=$2", [tenantA, reviewJob])).toHaveLength(3);
    // A file fetch needs a live claim: after review the token no longer opens the PDF.
    expect(await rejection(intake().worker.file(reviewJob, claimed!.lease_token))).toBeInstanceOf(NotFound);
  });
});

describe("DL-8, DL-10 limits and bad results fail the job without rows", () => {
  it("a parser past 50 pages fails too_many_pages; a parser that times out fails timeout; a crash fails worker_error", async () => {
    for (const [mode, expected] of [["too_many_pages", "too_many_pages"], ["timeout", "timeout"], ["crash", "worker_error"]] as const) {
      port.mode = mode;
      const queued = await member(ownerA).upload({ bytes: pdfVariant(10 + expected.length), filename: "big.pdf", contentType: "application/pdf" }, randomUUID());
      const run = await runDocumentIntakeWorker({ api: intake().worker, port });
      expect(run?.outcome).toMatchObject({ jobId: queued.jobId, status: "failed", failureReason: expected });
      const job = await detail(queued.jobId);
      expect(job.status).toBe("failed");
      expect(job.failureReason).toBe(expected);
      expect(job.finishedAt).not.toBeNull();
      expect(job.rows).toHaveLength(0);
    }
    port.mode = "ok";
  });

  it("a hung parser is cut off at the worker's time limit", async () => {
    port.mode = "hang";
    const queued = await member(ownerA).upload({ bytes: pdfVariant(20), filename: "hang.pdf", contentType: "application/pdf" }, randomUUID());
    const run = await runDocumentIntakeWorker({ api: intake().worker, port, timeoutMs: 25 });
    expect(run?.outcome).toMatchObject({ jobId: queued.jobId, status: "failed", failureReason: "timeout" });
    port.mode = "ok";
  });

  it("a result of 51 pages fails too_many_pages and a result with a NUL byte fails invalid_result, with no rows", async () => {
    const worker = intake().worker;
    const a = await member(ownerA).upload({ bytes: pdfVariant(30), filename: "long.pdf", contentType: "application/pdf" }, randomUUID());
    const claimA = (await worker.claim())!;
    expect(claimA.id).toBe(a.jobId);
    const long = await worker.result(claimA.id, claimA.leaseToken, { ...FAKE_PRICE_LIST, pageCount: 51 });
    expect(long).toMatchObject({ status: "failed", failureReason: "too_many_pages" });

    const b = await member(ownerA).upload({ bytes: pdfVariant(31), filename: "nul.pdf", contentType: "application/pdf" }, randomUUID());
    const claimB = (await worker.claim())!;
    expect(claimB.id).toBe(b.jobId);
    const dirty = { ...FAKE_PRICE_LIST, tables: [{ headers: ["Item No"], rows: [{ cells: ["HR-9\u0000"], pageNo: 1, bbox: [0.1, 0.1, 0.9, 0.2], snippet: "x" }] }] };
    expect(await rejection(worker.result(claimB.id, claimB.leaseToken, dirty))).toSatisfy(isValidation);
    const failed = await detail(b.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toBe("invalid_result");
    expect(failed.rows).toHaveLength(0);
    expect(await rows("SELECT 1 FROM document_intake_rows WHERE tenant_id=$1 AND job_id = ANY($2::uuid[])", [tenantA, [a.jobId, b.jobId]])).toHaveLength(0);
  });
});

describe("DL-4 leases", () => {
  it("a lapsed lease is claimed again, the old token is refused, and the third lapse fails worker_error", async () => {
    const queued = await member(ownerA).upload({ bytes: pdfVariant(40), filename: "slow.pdf", contentType: "application/pdf" }, randomUUID());
    const worker = intake().worker;
    const first = (await worker.claim())!;
    expect(first).toMatchObject({ id: queued.jobId, attempt: 1 });
    expect(await worker.claim()).toBeNull();
    now += INTAKE_LEASE_MS + 1000;
    const second = (await worker.claim())!;
    expect(second).toMatchObject({ id: queued.jobId, attempt: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(reason(await rejection(worker.result(first.id, first.leaseToken, FAKE_PRICE_LIST)))).toBe("lease_lost");
    now += INTAKE_LEASE_MS + 1000;
    const third = (await worker.claim())!;
    expect(third.attempt).toBe(3);
    now += INTAKE_LEASE_MS + 1000;
    expect(await worker.claim()).toBeNull();
    const job = await detail(queued.jobId);
    expect(job).toMatchObject({ status: "failed", failureReason: "worker_error" });
  });
});

describe("DL-13, DL-14 no row goes live without one owner approval of the whole diff", () => {
  it("refuses a direct apply, then applies exactly the rows the owner left in", async () => {
    const job = await detail(reviewJob);
    const insert = job.rows.find((row) => row.diffOp === "insert")!;
    const update = job.rows.find((row) => row.diffOp === "update")!;

    // A member cannot run apply directly, whatever the role.
    const direct = memberDispatch(deps(), { tenantId: tenantA, actorId: ownerA });
    const command = {
      actionType: CATALOG_INTAKE_APPLY_ACTION,
      target: { tenantId: tenantA, type: DOCUMENT_INTAKE_JOB_TARGET, id: reviewJob },
      approvalReference: { tenantId: tenantA, id: randomUUID() },
      idempotencyKey: randomUUID(),
      payload: { jobId: reviewJob, includedRowIds: [insert.id], diffDigest: job.diffDigest! },
    };
    expect(await rejection(direct(command as never))).toBeInstanceOf(TenantDenied);
    expect(await catalog()).toHaveLength(1);

    // Staff cannot propose it, and the owner cannot list an invalid, unknown or empty row set.
    expect(await rejection(member(staffA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [insert.id] }, randomUUID()))).toBeInstanceOf(TenantDenied);
    const invalid = job.rows.find((row) => row.diffOp === "invalid")!;
    expect(await rejection(member(ownerA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [invalid.id] }, randomUUID()))).toSatisfy(isValidation);
    expect(await rejection(member(ownerA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [randomUUID()] }, randomUUID()))).toSatisfy(isValidation);
    expect(await rejection(member(ownerA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [] }, randomUUID()))).toSatisfy(isValidation);
    expect(reason(await rejection(member(ownerA).proposeApply(reviewJob, { diffDigest: "f".repeat(64), includedRowIds: [insert.id] }, randomUUID())))).toBe("intake_changed");

    // The owner leaves the update out; one approval applies the rest.
    const proposed = await member(ownerA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [insert.id] }, randomUUID());
    expect(proposed.result.actionType).toBe(CATALOG_INTAKE_APPLY_ACTION);
    expect(proposed.result.summary).toContain("Add 1 and change 0");
    expect(await catalog()).toHaveLength(1);
    const approved = await createSession(deps(), { tenantId: tenantA, actorId: ownerA }).approveApproval(proposed.result.id, {}, randomUUID());
    expect(approved.execution.result).toEqual({ jobId: reviewJob, status: "applied", inserted: 1, updated: 0 });

    const live = await catalog();
    expect(live.map((item) => [item.sku, item.price_minor, item.revision])).toEqual([["HR-1001", "4500", 1], ["HR-2002", "3500", 1]]);
    const applied = await detail(reviewJob);
    expect(applied.status).toBe("applied");
    expect(applied.finishedAt).not.toBeNull();
    expect(applied.rows.filter((row) => row.included).map((row) => row.id)).toEqual([insert.id]);
    expect(applied.rows.find((row) => row.id === update.id)!.included).toBe(false);

    // DL-12: the source record names the job, the page and the row.
    const records = await rows<{ source: string; source_ref: string; subject_type: string }>(
      "SELECT source, source_ref, subject_type::text FROM source_records WHERE tenant_id=$1 AND subject_id=$2", [tenantA, live[0]!.id]);
    expect(records).toEqual([{ source: "document_intake", source_ref: `${reviewJob}:p${insert.pageNo}#r${insert.rowIndex}`, subject_type: "catalog_item" }]);

    // The job is spent: a second apply or a discard is refused.
    expect(reason(await rejection(member(ownerA).discard(reviewJob, randomUUID())))).toBe("intake_not_in_review");
    expect(reason(await rejection(member(ownerA).proposeApply(reviewJob, { diffDigest: job.diffDigest, includedRowIds: [update.id] }, randomUUID())))).toBe("intake_not_in_review");
  });

  it("a target that moved since the review conflicts and nothing is written", async () => {
    const jobId = await intakeOne(pdfVariant(50));
    const job = await detail(jobId);
    expect(job.counts).toEqual({ insert: 0, update: 1, unchanged: 1, invalid: 1 });
    const update = job.rows.find((row) => row.diffOp === "update")!;
    const proposed = await member(ownerA).proposeApply(jobId, { diffDigest: job.diffDigest, includedRowIds: [update.id] }, randomUUID());
    // Someone edits the scarf before the owner approves.
    await service((tx) => tx.query("UPDATE catalog_items SET price_minor=4000, revision=revision+1, updated_at=$2 WHERE tenant_id=$1 AND sku='HR-2002'", [tenantA, new Date(now)]));
    const error = await rejection(createSession(deps(), { tenantId: tenantA, actorId: ownerA }).approveApproval(proposed.result.id, {}, randomUUID()));
    expect(error).toBeInstanceOf(Conflict);
    expect(reason(error)).toBe("intake_target_changed");
    expect((await catalog()).find((item) => item.sku === "HR-2002")).toMatchObject({ price_minor: "4000", revision: 2 });
    expect((await detail(jobId)).status).toBe("review");
    await member(ownerA).discard(jobId, randomUUID());
    expect((await detail(jobId)).status).toBe("discarded");
  });
});

describe("DL-16 files and two tenants", () => {
  it("deletes the stored PDF 30 days after the job ends, and not before", async () => {
    const objects = store.objects.size;
    expect(await intake().sweepFiles()).toBe(0);
    now += 31 * DAY;
    const removed = await intake().sweepFiles();
    expect(removed).toBeGreaterThan(0);
    expect(store.objects.size).toBe(objects - removed);
    expect(await intake().sweepFiles()).toBe(0);
    expect(await rows("SELECT 1 FROM document_intake_jobs WHERE file_deleted_at IS NULL AND finished_at IS NOT NULL", [])).toHaveLength(0);
  });

  it("tenant B reads none of A's jobs, rows or items, and A's lease opens none of B's files", async () => {
    expect((await member(ownerB, tenantB).list()).items).toHaveLength(0);
    expect(await rejection(member(ownerB, tenantB).get(reviewJob))).toBeInstanceOf(NotFound);
    const seen = await database.db.tenant(tenantB, async (tx) => ({
      jobs: (await tx.query("SELECT 1 FROM document_intake_jobs")).rowCount,
      rows: (await tx.query("SELECT 1 FROM document_intake_rows")).rowCount,
      items: (await tx.query("SELECT 1 FROM catalog_items")).rowCount,
    }));
    expect(seen).toEqual({ jobs: 0, rows: 0, items: 0 });

    const bJob = await member(ownerB, tenantB).upload({ bytes: pdfVariant(60), filename: "b.pdf", contentType: "application/pdf" }, randomUUID());
    now += 1000;
    const worker = intake().worker;
    const aJob = await member(ownerA).upload({ bytes: pdfVariant(61), filename: "a.pdf", contentType: "application/pdf" }, randomUUID());
    const claimB = (await worker.claim())!;
    const claimA = (await worker.claim())!;
    expect([claimB.id, claimA.id]).toEqual([bJob.jobId, aJob.jobId]);
    expect(claimB.tenantId).toBe(tenantB);
    expect(claimA.tenantId).toBe(tenantA);
    // A token opens its own job's file and no other job's.
    expect((await worker.file(claimA.id, claimA.leaseToken)).byteLength).toBeGreaterThan(0);
    expect(await rejection(worker.file(claimB.id, claimA.leaseToken))).toBeInstanceOf(NotFound);
    expect(await rejection(worker.file(claimA.id, claimB.leaseToken))).toBeInstanceOf(NotFound);
    expect(await rejection(worker.result(claimB.id, claimA.leaseToken, FAKE_PRICE_LIST))).toBeInstanceOf(ActionError);
    // B's own owner reaches B's job and A's owner does not.
    expect((await member(ownerB, tenantB).list()).items.map((job) => job.id)).toEqual([bJob.jobId]);
    expect(await rejection(member(ownerA).get(bJob.jobId))).toBeInstanceOf(NotFound);
  });
});
