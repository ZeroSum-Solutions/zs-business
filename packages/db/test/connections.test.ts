// Connections storage rules (docs/requirements/connections.md C-7, C-12, C-16): the runtime role
// reads, inserts only an active row and moves a row only to disconnecting; it cannot read the
// worker's attempts or nonces; the worker's call budget refuses the API login and holds its limits.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const NOW = "2026-11-06T12:00:00.000Z";
let database: TestDatabase;
let fixture: TwoTenantFixture;
const memberA = randomUUID();
const memberB = randomUUID();

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  await fixture.service(async (tx) => {
    for (const [tenantId, id] of [[fixture.a.tenantId, memberA], [fixture.b.tenantId, memberB]] as const) {
      await tx.query(
        "INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) VALUES ($1,$2,$3,'owner',$4,$4)",
        [tenantId, id, `${id}@example.test`, NOW]);
    }
  });
});
afterAll(async () => { await database?.close(); });

const accountId = () => `ca_${randomUUID()}`;
async function runtimeInsert(tenant: TwoTenantFixture["a"], member: string, over: { status?: string; toolkit?: string; account?: string } = {}) {
  const id = randomUUID();
  await tenant.run((tx) => tx.query(
    `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
     VALUES ($1,$2,'composio',$3,$4,'1','shop.myshopify.com','Shop',$5,$6,$7,$7,$7)`,
    [tenant.tenantId, id, over.toolkit ?? "shopify", over.account ?? accountId(), over.status ?? "active", member, NOW]));
  return id;
}
const serviceUpdate = (tenantId: string, id: string, set: string, params: unknown[] = []) =>
  fixture.service((tx) => tx.query(`UPDATE connections SET ${set} WHERE tenant_id=$1 AND id=$2`, [tenantId, id, ...params]));

describe("connections: runtime role rules (C-7)", () => {
  it("lets the runtime role insert an active row and read only its tenant's", async () => {
    const id = await runtimeInsert(fixture.a, memberA);
    expect(await fixture.a.run(async (tx) => (await tx.query("SELECT id FROM connections")).rows)).toEqual([{ id }]);
    expect(await fixture.b.run(async (tx) => (await tx.query("SELECT id FROM connections")).rowCount)).toBe(0);
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
  });

  it.each(["reauthorize", "disconnecting", "disconnected"])("refuses a runtime insert of a %s row (42501)", async (status) => {
    await expect(runtimeInsert(fixture.a, memberA, { status })).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a connection for another tenant's member or another tenant's ID space", async () => {
    await expect(runtimeInsert(fixture.a, memberB)).rejects.toMatchObject({ code: "23503" });
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'shopify',$3,'1','s.myshopify.com','S','active',$4,$5,$5,$5)`,
      [fixture.a.tenantId, randomUUID(), accountId(), memberA, NOW]))).rejects.toMatchObject({ code: "42501" });
  });

  it("moves active and reauthorize to disconnecting, and only that", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
    await fixture.a.run((tx) => tx.query("UPDATE connections SET status='disconnecting', updated_at=$2 WHERE id=$1", [id, NOW]));
    expect((await fixture.service((tx) => tx.query("SELECT status FROM connections WHERE id=$1", [id]))).rows).toEqual([{ status: "disconnecting" }]);
    for (const status of ["active", "reauthorize", "disconnected"]) {
      await expect(fixture.a.run((tx) => tx.query("UPDATE connections SET status=$2 WHERE id=$1", [id, status])), status)
        .rejects.toMatchObject({ code: "42501" });
    }
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
  });

  it("refuses a runtime move from active to reauthorize or disconnected (42501)", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
    for (const status of ["reauthorize", "disconnected"]) {
      await expect(fixture.a.run((tx) => tx.query("UPDATE connections SET status=$2 WHERE id=$1", [id, status])), status)
        .rejects.toMatchObject({ code: "42501" });
    }
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
  });

  it.each(["account_label", "toolkit", "composio_account_id", "external_account_id", "reauthorize_reason", "last_checked_at", "last_error_code", "connected_by"])(
    "refuses a runtime update of %s (42501, no column grant)", async (column) => {
      const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
      await expect(fixture.a.run((tx) => tx.query(`UPDATE connections SET ${column}=${column} WHERE id=$1`, [id]))).rejects.toMatchObject({ code: "42501" });
      await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
    });

  it("has no runtime DELETE and no runtime access to attempts or nonces", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
    await expect(fixture.a.run((tx) => tx.query("DELETE FROM connections WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    for (const table of ["connection_attempts", "connector_request_nonces"]) {
      await expect(fixture.a.run((tx) => tx.query(`SELECT * FROM ${table}`)), table).rejects.toMatchObject({ code: "42501" });
      await expect(fixture.a.run((tx) => tx.query(`DELETE FROM ${table}`)), table).rejects.toMatchObject({ code: "42501" });
    }
    await expect(fixture.a.run((tx) => tx.query(
      `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,created_by,browser_hash,expires_at,created_at,updated_at)
       VALUES ($1,$2,$2,'shopify',$3,'ac_1','s.myshopify.com',$4,$5,$6,$6,$6)`, [fixture.a.tenantId, randomUUID(), accountId(), memberA, "a".repeat(43), NOW]))).rejects.toMatchObject({ code: "42501" });
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
  });

  it("keeps one live row per tenant and toolkit and one per Composio account", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
    await expect(runtimeInsert(fixture.a, memberA, { toolkit: "shopify" })).rejects.toMatchObject({ code: "23505" });
    // Another tenant may connect the same toolkit, but not the same Composio account.
    await runtimeInsert(fixture.b, memberB, { toolkit: "shopify", account: "ca_shared_once" });
    await expect(runtimeInsert(fixture.a, memberA, { toolkit: "other", account: "ca_shared_once" })).rejects.toMatchObject({ code: "23505" });
    // A disconnecting row still holds the slot; a disconnected row frees it.
    await fixture.a.run((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await expect(runtimeInsert(fixture.a, memberA, { toolkit: "shopify" })).rejects.toMatchObject({ code: "23505" });
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
    await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
  });

  it("holds the worker to its columns and makes disconnected final", async () => {
    const id = await runtimeInsert(fixture.b, memberB, { toolkit: "kit" });
    await expect(serviceUpdate(fixture.b.tenantId, id, "toolkit='x'")).rejects.toMatchObject({ code: "42501" });
    await expect(serviceUpdate(fixture.b.tenantId, id, "status='reauthorize'")).rejects.toMatchObject({ code: "23514" });
    await serviceUpdate(fixture.b.tenantId, id, "status='reauthorize', reauthorize_reason='auth_error'");
    await serviceUpdate(fixture.b.tenantId, id, "status='disconnected', account_label=NULL");
    await expect(serviceUpdate(fixture.b.tenantId, id, "status='active', account_label='Back'")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("connections: scopes constraint (C-16)", () => {
  it("accepts connections:read with an expiry and ten scopes, and refuses it without one", async () => {
    const scopes = ["contacts:propose", "deals:propose", "bookings:propose", "contacts:read", "deals:read", "bookings:read", "inbox:read", "results:read", "business:read", "connections:read"];
    const token = (scopeList: string[], expires: string | null) => fixture.service((tx) => tx.query(
      `INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at)
       VALUES ($1,$2,'t',$3::automation_token_scope[],$4,$5,$6)`,
      [fixture.a.tenantId, randomUUID(), scopeList, memberA, NOW, expires]));
    await expect(token(["connections:read"], null)).rejects.toMatchObject({ code: "23514", constraint: "automation_tokens_read_expiry" });
    await token(["connections:read"], "2026-12-06T12:00:00.000Z");
    await token(scopes, "2026-12-06T12:00:00.000Z");
    await expect(token([...scopes, "contacts:read"], "2026-12-06T12:00:00.000Z")).rejects.toMatchObject({ code: "23514", constraint: "automation_tokens_scopes_size" });
  });
});

describe("connections: worker call budget (C-12)", () => {
  const take = (env: string, at: string, op = "take") => fixture.service(async (tx) =>
    Number((await tx.query<{ ms: string }>("SELECT public.connections_org_budget($1::timestamptz,$2,$3) AS ms", [at, env, op])).rows[0]!.ms));
  const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();

  it("refuses the API runtime login and a bad environment", async () => {
    await expect(fixture.a.run((tx) => tx.query("SELECT public.connections_org_budget($1::timestamptz,'preview','take')", [NOW]))).rejects.toMatchObject({ code: "42501" });
    await expect(take("staging", NOW)).rejects.toMatchObject({ code: "22023" });
    await expect(take("preview", NOW, "reset")).rejects.toMatchObject({ code: "22023" });
  });

  it("allows 500 calls a minute in preview, then names the wait, and reopens next window", async () => {
    for (let n = 0; n < 500; n += 1) expect(await take("preview", NOW)).toBe(0);
    expect(await take("preview", at(10_000))).toBe(50_000);
    expect(await take("preview", at(60_000))).toBe(0);
  }, 60_000);

  it("keeps production and preview apart and opens a 60 second cooldown", async () => {
    expect(await take("production", at(5_000_000))).toBe(0);
    expect(await take("production", at(5_000_000), "cool")).toBe(60000);
    expect(await take("production", at(5_020_000))).toBe(40_000);
    expect(await take("production", at(5_061_000))).toBe(0);
  });
});
