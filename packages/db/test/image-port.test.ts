import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// image-port.md IM-1, IM-2, IM-15: the tables, the state machine, the set-once provenance and the
// tenant wall, checked in the database itself.

let database: TestDatabase;
let fixture: TwoTenantFixture;
const SHA = (digit: string) => digit.repeat(64);
const T0 = "2026-10-23T09:00:00Z";
const T1 = "2026-10-23T09:05:00Z";
const T14 = "2026-11-06T09:05:00Z";

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

async function asset(tenantId: string, sha = randomUUID().replaceAll("-", "").repeat(2)) {
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO media_assets (tenant_id,id,sha256,content_type,byte_length,width,height,origin,created_by,created_at)
     VALUES ($1,$2,$3,'image/png',100,24,24,'upload',$4,$5)`, [tenantId, id, sha, randomUUID(), T0]));
  return { id, sha };
}
async function variant(tenantId: string, source: { id: string; sha: string }) {
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO image_variants (tenant_id,id,source_asset_id,source_sha256,preset,params,price_minor,currency,created_by,created_at)
     VALUES ($1,$2,$3,$4,'background_remove','{}',20,'usd',$5,$6)`, [tenantId, id, source.id, source.sha, randomUUID(), T0]));
  return id;
}
const run = (tenantId: string, id: string, set: string, params: unknown[] = []) =>
  fixture.service((tx) => tx.query(`UPDATE image_variants SET ${set} WHERE tenant_id=$1 AND id=$2`, [tenantId, id, ...params]));
const STAGE = `status='staged', sha256='${SHA("b")}', staged_at='${T1}', expires_at='${T14}', adapter='fake', model_id='fake-matte-v1', model_license='apache-2.0', workflow_hash='w1'`;
async function staged(tenantId = fixture.a.tenantId, sha?: string) {
  const id = await variant(tenantId, await asset(tenantId, sha));
  await run(tenantId, id, "status='running'");
  await run(tenantId, id, STAGE);
  return id;
}

describe("media_assets", () => {
  it("is unique by content within a tenant and shared across tenants", async () => {
    const tenant = fixture.a.tenantId;
    const sha = SHA("c");
    await asset(tenant, sha);
    await expect(asset(tenant, sha)).rejects.toMatchObject({ code: "23505" });
    await expect(asset(fixture.b.tenantId, sha)).resolves.toBeTruthy();
  });

  it.each([
    ["a digest that is not hex", "sha256='XYZ'"],
    ["a content type that is not a raster image", "content_type='image/svg+xml'"],
    ["a size over 10 MiB", "byte_length=10485761"],
    ["a width over 8192", "width=8193"],
    ["more than 40 million pixels", "width=8000, height=6000"],
    ["an uploaded asset that names a variant", `variant_id='${randomUUID()}'`],
  ])("refuses %s", async (_, set) => {
    const { id } = await asset(fixture.a.tenantId);
    await expect(database.pool.query(`UPDATE media_assets SET ${set} WHERE id=$1`, [id])).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the runtime role insert and read but never update or delete", async () => {
    const tenant = fixture.a.tenantId;
    const id = randomUUID();
    await fixture.a.run((tx) => tx.query(
      `INSERT INTO media_assets (tenant_id,id,sha256,content_type,byte_length,width,height,origin,created_by,created_at)
       VALUES ($1,$2,$3,'image/png',100,24,24,'upload',$4,$5)`, [tenant, id, SHA("e"), randomUUID(), T0]));
    expect((await fixture.a.run((tx) => tx.query("SELECT id FROM media_assets WHERE id=$1", [id]))).rowCount).toBe(1);
    await expect(fixture.a.run((tx) => tx.query("UPDATE media_assets SET width=1 WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM media_assets WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("image_variants state machine", () => {
  it("starts queued and walks queued, running, staged, approved, promoted", async () => {
    const tenant = fixture.a.tenantId;
    const id = await variant(tenant, await asset(tenant, SHA("f")));
    expect((await fixture.service((tx) => tx.query("SELECT status FROM image_variants WHERE id=$1", [id]))).rows[0]).toEqual({ status: "queued" });
    await run(tenant, id, "status='running'");
    await run(tenant, id, STAGE);
    await run(tenant, id, `status='approved', approved_at='${T1}'`);
    await run(tenant, id, `status='promoted', promoted_at='${T1}'`);
  });

  it.each([
    ["queued to staged", "status='staged'"],
    ["queued to approved", `status='approved', approved_at='${T1}'`],
  ])("refuses %s", async (_, set) => {
    const tenant = fixture.a.tenantId;
    const id = await variant(tenant, await asset(tenant));
    await expect(run(tenant, id, set)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a staged state without its output and provenance columns", async () => {
    const tenant = fixture.a.tenantId;
    const id = await variant(tenant, await asset(tenant, SHA("2")));
    await run(tenant, id, "status='running'");
    await expect(run(tenant, id, "status='staged'")).rejects.toMatchObject({ code: "23514" });
  });

  it("requires a failure reason with failed, and only with failed", async () => {
    const tenant = fixture.a.tenantId;
    const id = await variant(tenant, await asset(tenant, SHA("3")));
    await expect(run(tenant, id, "status='failed'")).rejects.toMatchObject({ code: "23514" });
    await expect(run(tenant, id, "failure_reason='adapter_error'")).rejects.toMatchObject({ code: "23514" });
    await run(tenant, id, "status='failed', failure_reason='adapter_error'");
  });

  it("freezes a terminal variant and every way out of failed, promoted or expired", async () => {
    const tenant = fixture.a.tenantId;
    const failed = await variant(tenant, await asset(tenant, SHA("4")));
    await run(tenant, failed, "status='failed', failure_reason='adapter_error'");
    await expect(run(tenant, failed, "status='running'")).rejects.toMatchObject({ code: "23514" });

    const expired = await staged(tenant, SHA("5"));
    await run(tenant, expired, "status='expired'");
    await expect(run(tenant, expired, `status='approved', approved_at='${T1}'`)).rejects.toMatchObject({ code: "23514" });
    await expect(run(tenant, expired, "price_minor=1")).rejects.toMatchObject({ code: "23514" });
  });

  it("holds source, preset, params and price fixed, and sets each provenance column once", async () => {
    const tenant = fixture.a.tenantId;
    const id = await staged(tenant, SHA("6"));
    for (const set of ["price_minor=1", "preset='upscale_2k'", "params='{\"a\":1}'", "source_sha256='" + SHA("9") + "'"])
      await expect(run(tenant, id, set)).rejects.toMatchObject({ code: "23514" });
    for (const set of [`sha256='${SHA("9")}'`, "model_id='other'", "model_license='mit'", "adapter='kie'", "workflow_hash='w2'", `staged_at='${T0}'`])
      await expect(run(tenant, id, set)).rejects.toMatchObject({ code: "23514" });
    // Setting the same value again is not a change.
    await run(tenant, id, `model_id='fake-matte-v1'`);
  });

  it("lets the runtime role update only the columns the steps write", async () => {
    const tenant = fixture.a.tenantId;
    const id = await staged(tenant, SHA("7"));
    await fixture.a.run((tx) => tx.query(`UPDATE image_variants SET status='approved', approved_at=$2 WHERE id=$1`, [id, T1]));
    await expect(fixture.a.run((tx) => tx.query("UPDATE image_variants SET price_minor=1 WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM image_variants WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
  });

  // IM-23 (20261024300000): staged -> rejected with a set-once rejected_at, and nothing after it.
  it("moves a staged variant to rejected, and only a staged one", async () => {
    const tenant = fixture.a.tenantId;
    const id = await staged(tenant, SHA("a"));
    await expect(run(tenant, id, "status='rejected'")).rejects.toMatchObject({ code: "23514" });
    await expect(run(tenant, id, `rejected_at='${T1}'`)).rejects.toMatchObject({ code: "23514" });
    await run(tenant, id, `status='rejected', rejected_at='${T1}'`);
    for (const set of [`status='approved', approved_at='${T1}'`, "status='expired'", `rejected_at='${T14}'`, "rejected_at=NULL"])
      await expect(run(tenant, id, set)).rejects.toMatchObject({ code: "23514" });

    const queued = await variant(tenant, await asset(tenant));
    await expect(run(tenant, queued, `status='rejected', rejected_at='${T1}'`)).rejects.toMatchObject({ code: "23514" });
    const approved = await staged(tenant);
    await run(tenant, approved, `status='approved', approved_at='${T1}'`);
    await expect(run(tenant, approved, `status='rejected', rejected_at='${T1}'`)).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the runtime role reject its own tenant's staged variant and never the other tenant's", async () => {
    const id = await staged(fixture.a.tenantId);
    const update = "UPDATE image_variants SET status='rejected', rejected_at=$2 WHERE id=$1";
    expect((await fixture.b.run((tx) => tx.query(update, [id, T1]))).rowCount).toBe(0);
    expect((await fixture.service((tx) => tx.query("SELECT status FROM image_variants WHERE id=$1", [id]))).rows[0]).toEqual({ status: "staged" });
    expect((await fixture.a.run((tx) => tx.query(update, [id, T1]))).rowCount).toBe(1);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM image_variants WHERE id=$1 AND status='rejected'", [id]))).rowCount).toBe(0);
  });

  it("refuses a source asset of another tenant", async () => {
    const foreign = await asset(fixture.b.tenantId, SHA("8"));
    await expect(variant(fixture.a.tenantId, foreign)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("tenant wall", () => {
  it("hides one tenant's assets and variants from the other under the runtime role", async () => {
    const tenant = fixture.a.tenantId;
    const source = await asset(tenant, SHA("0"));
    const id = await variant(tenant, source);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM image_variants WHERE id=$1", [id]))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM media_assets WHERE id=$1", [source.id]))).rowCount).toBe(0);
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO image_variants (tenant_id,id,source_asset_id,source_sha256,preset,params,price_minor,currency,created_by,created_at)
       VALUES ($1,$2,$3,$4,'background_remove','{}',20,'usd',$5,$6)`,
      [tenant, randomUUID(), source.id, source.sha, randomUUID(), T0]))).rejects.toMatchObject({ code: "42501" });
    expect((await fixture.a.run((tx) => tx.query("SELECT id FROM image_variants WHERE id=$1", [id]))).rowCount).toBe(1);
  });
});
