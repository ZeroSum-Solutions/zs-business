import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// document-intake.md DL-1, DL-2, DL-4, DL-5, DL-12 at the database, as the runtime role: tenant B
// sees and changes nothing of tenant A's jobs, rows and items; only the platform transaction reaches
// across tenants; a job moves only along DL-4; rows hold provenance; catalog items cannot be deleted.

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const AT = "2026-10-24T08:00:00.000Z";
const SHA = "c".repeat(64);
const asTenant = (tenantId: string) => (tenantId === fixture.a.tenantId ? fixture.a : fixture.b).run;
const addJob = (tenantId: string, id = randomUUID()) => asTenant(tenantId)(async (tx) => {
  await tx.query(
    `INSERT INTO document_intake_jobs (tenant_id,id,filename,file_sha256,byte_length,status,created_by,created_at)
     VALUES ($1,$2,'list.pdf',$3,100,'queued',$4,$5)`, [tenantId, id, SHA, randomUUID(), AT]);
  return id;
});
const toReview = (tenantId: string, id: string, pages = 2) => asTenant(tenantId)((tx) => tx.query(
  `UPDATE document_intake_jobs SET status='claimed', attempts=1, lease_token=$2, lease_expires_at=$3 WHERE id=$1`, [id, randomUUID(), AT])
  .then(() => tx.query(
    `UPDATE document_intake_jobs SET status='review', page_count=$2, parser_version='fake-1', diff_digest=$3 WHERE id=$1`, [id, pages, SHA])));
const addRow = (tenantId: string, jobId: string, extra: { pageNo?: number; bbox?: string; index?: number } = {}) => asTenant(tenantId)(async (tx) => {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO document_intake_rows (tenant_id,id,job_id,row_index,diff_op,page_no,bbox,source_snippet)
     VALUES ($1,$2,$3,$4,'insert',$5,$6::jsonb,'row')`,
    [tenantId, id, jobId, extra.index ?? 1, extra.pageNo ?? 1, extra.bbox ?? "[0.1,0.1,0.9,0.2]"]);
  return id;
});
const addItem = (tenantId: string, sku: string) => asTenant(tenantId)(async (tx) => {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO catalog_items (tenant_id,id,sku,title,price_minor,created_at,updated_at) VALUES ($1,$2,$3,'Linen shirt',4500,$4,$4)`,
    [tenantId, id, sku, AT]);
  return id;
});

describe("tenant isolation", () => {
  it("shows tenant B none of tenant A's jobs, rows or items, and lets it change none", async () => {
    const job = await addJob(fixture.a.tenantId);
    await toReview(fixture.a.tenantId, job);
    const row = await addRow(fixture.a.tenantId, job);
    const item = await addItem(fixture.a.tenantId, "HR-100");
    await addItem(fixture.b.tenantId, "HR-100");

    for (const [table, id] of [["document_intake_jobs", job], ["document_intake_rows", row], ["catalog_items", item]] as const) {
      expect((await fixture.b.run((tx) => tx.query(`SELECT id FROM ${table} WHERE id=$1`, [id]))).rowCount, table).toBe(0);
      expect((await fixture.a.run((tx) => tx.query(`SELECT id FROM ${table} WHERE id=$1`, [id]))).rowCount, table).toBe(1);
    }
    expect((await fixture.b.run((tx) => tx.query("UPDATE catalog_items SET title='x', revision=2 WHERE id=$1", [item]))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query("UPDATE document_intake_rows SET included=false WHERE id=$1", [row]))).rowCount).toBe(0);
    // A tenant cannot write a row into another tenant's job.
    await expect(asTenant(fixture.b.tenantId)((tx) => tx.query(
      `INSERT INTO document_intake_rows (tenant_id,id,job_id,row_index,diff_op) VALUES ($1,$2,$3,9,'insert')`,
      [fixture.b.tenantId, randomUUID(), job]))).rejects.toBeTruthy();
    // Nor copy a job under its own tenant id with another tenant's tenant_id.
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO document_intake_jobs (tenant_id,id,filename,file_sha256,byte_length,created_by,created_at) VALUES ($1,$2,'x.pdf',$3,10,$4,$5)`,
      [fixture.a.tenantId, randomUUID(), SHA, randomUUID(), AT]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("DL-2: catalog rows", () => {
  it("has no DELETE for the runtime role, on both tables", async () => {
    const item = await addItem(fixture.a.tenantId, "DEL-1");
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM catalog_items WHERE id=$1", [item]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM knowledge_entries"))).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.service((tx) => tx.query("SELECT id FROM catalog_items WHERE id=$1", [item]))).rowCount).toBe(1);
  });
  it("starts at revision 1, grows by one, and keeps a SKU unique per tenant", async () => {
    const item = await addItem(fixture.a.tenantId, "REV-1");
    await expect(addItem(fixture.a.tenantId, "REV-1")).rejects.toMatchObject({ code: "23505" });
    await addItem(fixture.b.tenantId, "REV-1");
    await expect(fixture.a.run((tx) => tx.query("UPDATE catalog_items SET title='Two', updated_at=$2 WHERE id=$1", [item, AT])))
      .rejects.toMatchObject({ code: "23514" });
    await fixture.a.run((tx) => tx.query("UPDATE catalog_items SET title='Two', revision=2, updated_at=$2 WHERE id=$1", [item, AT]));
    await expect(fixture.a.run((tx) => tx.query("UPDATE catalog_items SET revision=4 WHERE id=$1", [item]))).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.a.run((tx) => tx.query("UPDATE catalog_items SET sku='OTHER' WHERE id=$1", [item]))).rejects.toMatchObject({ code: "42501" });
    await expect(asTenant(fixture.a.tenantId)((tx) => tx.query(
      `INSERT INTO catalog_items (tenant_id,id,sku,title,price_minor,revision,created_at,updated_at) VALUES ($1,$2,'REV-9','x',1,3,$3,$3)`,
      [fixture.a.tenantId, randomUUID(), AT]))).rejects.toMatchObject({ code: "23514" });
  });
  it("limits attributes to a flat map of at most 30 keys", async () => {
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"])));
    await expect(fixture.a.run((tx) => tx.query(
      `INSERT INTO catalog_items (tenant_id,id,sku,title,price_minor,attributes,created_at,updated_at) VALUES ($1,$2,'ATTR-1','x',1,$3::jsonb,$4,$4)`,
      [fixture.a.tenantId, randomUUID(), many, AT]))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("DL-4, DL-5: job states and the platform claim", () => {
  it("allows only the stated moves", async () => {
    const job = await addJob(fixture.a.tenantId);
    const move = (to: string) => fixture.a.run((tx) => tx.query(
      "UPDATE document_intake_jobs SET status=$2::intake_job_status, finished_at=CASE WHEN $2::text IN ('failed','applied','discarded') THEN $3::timestamptz END, failure_reason=CASE WHEN $2::text='failed' THEN 'worker_error' END WHERE id=$1",
      [job, to, AT]));
    await expect(move("review")).rejects.toMatchObject({ code: "23514" });
    await expect(move("applied")).rejects.toMatchObject({ code: "23514" });
    await fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='claimed', attempts=1, lease_token=$2, lease_expires_at=$3 WHERE id=$1", [job, randomUUID(), AT]));
    // claimed -> queued (lease lost)
    await fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='queued', lease_token=NULL, lease_expires_at=NULL WHERE id=$1", [job]));
    await fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='claimed', attempts=2, lease_token=$2, lease_expires_at=$3 WHERE id=$1", [job, randomUUID(), AT]));
    await fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='review', page_count=2, parser_version='p-1', diff_digest=$2 WHERE id=$1", [job, SHA]));
    await expect(move("queued")).rejects.toMatchObject({ code: "23514" });
    await expect(move("failed")).rejects.toMatchObject({ code: "23514" });
    await move("discarded");
    await expect(move("review")).rejects.toMatchObject({ code: "23514" });
    await expect(move("applied")).rejects.toMatchObject({ code: "23514" });
  });
  it("hides jobs from a request with no tenant, shows them to the platform transaction only, and never deletes", async () => {
    const a = await addJob(fixture.a.tenantId);
    const b = await addJob(fixture.b.tenantId);
    expect((await database.db.withoutTenant((tx) => tx.query("SELECT id FROM document_intake_jobs"))).rows).toEqual([]);
    const seen = (await database.db.platform!((tx) => tx.query("SELECT id FROM document_intake_jobs"))).rows.map((row) => row.id);
    expect(seen).toEqual(expect.arrayContaining([a, b]));
    expect((await database.db.platform!((tx) => tx.query(
      "UPDATE document_intake_jobs SET status='claimed', attempts=1, lease_token=$2, lease_expires_at=$3 WHERE id=$1", [a, randomUUID(), AT]))).rowCount).toBe(1);
    await expect(database.db.platform!((tx) => tx.query("DELETE FROM document_intake_jobs WHERE id=$1", [a]))).rejects.toMatchObject({ code: "42501" });
    // The platform policy is for jobs only: no row of the rows table is visible through it.
    const job = await addJob(fixture.b.tenantId);
    await toReview(fixture.b.tenantId, job);
    await addRow(fixture.b.tenantId, job);
    expect((await database.db.platform!((tx) => tx.query("SELECT id FROM document_intake_rows"))).rowCount).toBe(0);
  });
  it("keeps the lease columns together and finds a job by id and token", async () => {
    const job = await addJob(fixture.a.tenantId);
    await expect(fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET lease_token=$2 WHERE id=$1", [job, randomUUID()]))).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='claimed' WHERE id=$1", [job]))).rejects.toMatchObject({ code: "23514" });
    const token = randomUUID();
    await fixture.a.run((tx) => tx.query("UPDATE document_intake_jobs SET status='claimed', attempts=1, lease_token=$2, lease_expires_at=$3 WHERE id=$1", [job, token, AT]));
    const found = await database.db.platform!((tx) => tx.query("SELECT tenant_id FROM document_intake_jobs WHERE id=$1 AND lease_token=$2", [job, token]));
    expect(found.rows).toEqual([{ tenant_id: fixture.a.tenantId }]);
  });
});

describe("DL-12: provenance", () => {
  it("accepts rows only in a job in review, inside its page count, with a box inside the page", async () => {
    const queued = await addJob(fixture.a.tenantId);
    await expect(addRow(fixture.a.tenantId, queued)).rejects.toMatchObject({ code: "23514" });
    const job = await addJob(fixture.a.tenantId);
    await toReview(fixture.a.tenantId, job, 2);
    await addRow(fixture.a.tenantId, job, { pageNo: 2, index: 1 });
    await expect(addRow(fixture.a.tenantId, job, { pageNo: 3, index: 2 })).rejects.toMatchObject({ code: "23514" });
    await expect(addRow(fixture.a.tenantId, job, { pageNo: 0, index: 2 })).rejects.toMatchObject({ code: "23514" });
    for (const [n, bbox] of ["[0.1,0.1,1.2,0.5]", "[0.5,0.1,0.4,0.5]", "[0.1,0.1,0.5]", "[0.1,0.1,0.5,\"x\"]", "{}", "[-0.1,0.1,0.5,0.5]", "[0.1,0.5,0.5,0.5]"].entries())
      await expect(addRow(fixture.a.tenantId, job, { index: 10 + n, bbox }), bbox).rejects.toMatchObject({ code: expect.stringMatching(/^2(2|3)/) });
    await expect(addRow(fixture.a.tenantId, job, { pageNo: 1, index: 1 })).rejects.toMatchObject({ code: "23505" });
  });
  it("ties an invalid reason to the invalid op, and an existing target to update and unchanged", async () => {
    const job = await addJob(fixture.a.tenantId);
    await toReview(fixture.a.tenantId, job);
    const insert = (cols: string, vals: unknown[], index: number) => fixture.a.run((tx) => tx.query(
      `INSERT INTO document_intake_rows (tenant_id,id,job_id,row_index,${cols}) VALUES ($1,$2,$3,${index},${vals.map((_, i) => `$${i + 4}`).join(",")})`,
      [fixture.a.tenantId, randomUUID(), job, ...vals]));
    await expect(insert("diff_op", ["invalid"], 1)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("diff_op,invalid_reason", ["insert", "bad_price"], 2)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("diff_op", ["update"], 3)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("diff_op,included", ["invalid", true], 4)).rejects.toBeTruthy();
    await insert("diff_op,invalid_reason", ["invalid", "bad_price"], 5);
    await insert("diff_op,existing_target_id,existing_revision,included", ["update", randomUUID(), 1, true], 6);
  });
});
