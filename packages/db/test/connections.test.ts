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
type Tenant = TwoTenantFixture["a"];
interface AttemptOver { status?: string | undefined; toolkit?: string | undefined; account?: string | undefined; domain?: string | undefined; external?: string | undefined; createdBy?: string | null | undefined }
/** The worker's attempt for one connect (C-4, C-7): verified unless the test says otherwise. */
async function seedAttempt(tenant: Tenant, member: string, over: AttemptOver = {}) {
  const connectionId = randomUUID();
  const account = over.account ?? accountId();
  await fixture.service((tx) => tx.query(
    `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,external_account_id,
       created_by,browser_hash,status,expires_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'ac_1',$6,$7,$8,$9,$10,$11,$11,$11)`,
    [tenant.tenantId, randomUUID(), connectionId, over.toolkit ?? "shopify", account, over.domain ?? "shop.myshopify.com",
      over.external ?? "1", over.createdBy === undefined ? member : over.createdBy, "a".repeat(43), over.status ?? "verified", NOW]));
  return { connectionId, account };
}
/** The connect action's insert as the runtime role: no Composio account ID, which the attempt supplies (C-1). */
const insertConnection = (tenant: Tenant, id: string, member: string, over: { status?: string | undefined; toolkit?: string | undefined; domain?: string | undefined; external?: string | undefined } = {}) =>
  tenant.run((tx) => tx.query(
    `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
     VALUES ($1,$2,'composio',$3,$4,$5,'Shop',$6,$7,$8,$8,$8)`,
    [tenant.tenantId, id, over.toolkit ?? "shopify", over.external ?? "1", over.domain ?? "shop.myshopify.com", over.status ?? "active", member, NOW]));
async function runtimeInsert(tenant: Tenant, member: string, over: { status?: string; toolkit?: string; account?: string } = {}) {
  const { connectionId } = await seedAttempt(tenant, member, { toolkit: over.toolkit, account: over.account });
  await insertConnection(tenant, connectionId, member, { status: over.status, toolkit: over.toolkit });
  return connectionId;
}
/** A worker-side insert that names its account (the seed path; the worker itself never inserts rows). */
const serviceInsert = (tenantId: string, member: string, account: string, toolkit = "shopify") => fixture.service((tx) => tx.query(
  `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
   VALUES ($1,$2,'composio',$3,$4,'1','shop.myshopify.com','Shop','active',$5,$6,$6,$6)`,
  [tenantId, randomUUID(), toolkit, account, member, NOW]));
const attemptStatus = async (tenantId: string, connectionId: string) => (await fixture.service((tx) => tx.query<{ status: string }>(
  "SELECT status FROM connection_attempts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, connectionId]))).rows[0]?.status;
/** The API's login as it really connects: zs_runtime with the tenant set and no SET ROLE (A1). */
async function rawRuntime<T>(tenantId: string, work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await database.runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
    // The attempt names memberA; a row that names memberB matches no attempt.
    const { connectionId } = await seedAttempt(fixture.a, memberA);
    await expect(insertConnection(fixture.a, connectionId, memberB)).rejects.toMatchObject({ code: "23514", constraint: "connections_verified_attempt" });
    await expect(serviceInsert(fixture.a.tenantId, memberB, accountId())).rejects.toMatchObject({ code: "23503" });
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'shopify','1','s.myshopify.com','S','active',$3,$4,$4,$4)`,
      [fixture.a.tenantId, connectionId, memberA, NOW]))).rejects.toMatchObject({ code: "42501" });
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

  // C-3, C-5: the insert binds the row to its verified attempt's toolkit, Composio account and store; no role
  // the application runs as can change that binding afterwards, so a reload's account check covers the store.
  it.each(["toolkit", "composio_account_id", "external_account_id", "account_domain"])(
    "refuses a worker (service role) update of %s (42501, no column grant)", async (column) => {
      const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
      await expect(serviceUpdate(fixture.a.tenantId, id, `${column}=${column}`)).rejects.toMatchObject({ code: "42501" });
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

  it("keeps one live row per tenant and toolkit, and one row ever per Composio account (C-7)", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "shopify" });
    await expect(runtimeInsert(fixture.a, memberA, { toolkit: "shopify" })).rejects.toMatchObject({ code: "23505", constraint: "connections_one_live_per_toolkit" });
    // Another tenant may connect the same toolkit, but never the same Composio account.
    const shared = accountId();
    await serviceInsert(fixture.b.tenantId, memberB, shared);
    await expect(serviceInsert(fixture.a.tenantId, memberA, shared, "other")).rejects.toMatchObject({ code: "23505", constraint: "connections_composio_account" });
    // A disconnecting row still holds the slot; a disconnected row frees the toolkit slot only.
    await fixture.a.run((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await expect(runtimeInsert(fixture.a, memberA, { toolkit: "shopify" })).rejects.toMatchObject({ code: "23505" });
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
    const account = (await fixture.service((tx) => tx.query<{ a: string }>("SELECT composio_account_id AS a FROM connections WHERE id=$1", [id]))).rows[0]!.a;
    await expect(serviceInsert(fixture.a.tenantId, memberA, account, "other")).rejects.toMatchObject({ code: "23505", constraint: "connections_composio_account" });
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

describe("connections: the runtime guard binds the API login itself (A1)", () => {
  it("refuses a raw zs_runtime insert of a disconnecting row, as under SET ROLE", async () => {
    const { connectionId } = await seedAttempt(fixture.a, memberA, { toolkit: "rawkit" });
    await expect(rawRuntime(fixture.a.tenantId, (client) => client.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'composio','rawkit','1','shop.myshopify.com','Shop','disconnecting',$3,$4,$4,$4)`,
      [fixture.a.tenantId, connectionId, memberA, NOW]))).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a raw zs_runtime move back from disconnecting to active", async () => {
    const id = await runtimeInsert(fixture.a, memberA, { toolkit: "rawback" });
    await rawRuntime(fixture.a.tenantId, (client) => client.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await expect(rawRuntime(fixture.a.tenantId, (client) => client.query("UPDATE connections SET status='active' WHERE id=$1", [id])))
      .rejects.toMatchObject({ code: "42501" });
    expect((await fixture.service((tx) => tx.query("SELECT status FROM connections WHERE id=$1", [id]))).rows).toEqual([{ status: "disconnecting" }]);
    await serviceUpdate(fixture.a.tenantId, id, "status='disconnected', account_label=NULL");
  });
});

describe("connections: transitions every role keeps (C-7, C-8, C-13)", () => {
  it("never moves a disconnecting row anywhere but disconnected, even as the worker", async () => {
    const id = await runtimeInsert(fixture.b, memberB, { toolkit: "leave" });
    await fixture.b.run((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await expect(serviceUpdate(fixture.b.tenantId, id, "status='active'")).rejects.toMatchObject({ code: "42501" });
    await expect(serviceUpdate(fixture.b.tenantId, id, "status='reauthorize', reauthorize_reason='provider_status'")).rejects.toMatchObject({ code: "42501" });
    await serviceUpdate(fixture.b.tenantId, id, "status='disconnected', account_label=NULL");
  });

  it("never lets an auth_error row recover to active on its own", async () => {
    const id = await runtimeInsert(fixture.b, memberB, { toolkit: "authkit" });
    await serviceUpdate(fixture.b.tenantId, id, "status='reauthorize', reauthorize_reason='auth_error'");
    await expect(serviceUpdate(fixture.b.tenantId, id, "status='active', reauthorize_reason=NULL")).rejects.toMatchObject({ code: "42501" });
    // provider_status may recover; auth_error may still be disconnected.
    const other = await runtimeInsert(fixture.b, memberB, { toolkit: "statuskit" });
    await serviceUpdate(fixture.b.tenantId, other, "status='reauthorize', reauthorize_reason='provider_status'");
    await serviceUpdate(fixture.b.tenantId, other, "status='active', reauthorize_reason=NULL");
    await fixture.b.run((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await serviceUpdate(fixture.b.tenantId, id, "status='disconnected', account_label=NULL");
    await serviceUpdate(fixture.b.tenantId, other, "status='disconnected', account_label=NULL");
  });

  it("keeps a revoke outcome to rows that are leaving", async () => {
    const id = await runtimeInsert(fixture.b, memberB, { toolkit: "revkit" });
    await expect(serviceUpdate(fixture.b.tenantId, id, "revoke_outcome='failed'")).rejects.toMatchObject({ code: "23514" });
    await fixture.b.run((tx) => tx.query("UPDATE connections SET status='disconnecting' WHERE id=$1", [id]));
    await serviceUpdate(fixture.b.tenantId, id, "revoke_outcome='failed'");
    await serviceUpdate(fixture.b.tenantId, id, "status='disconnected', account_label=NULL");
  });
});

describe("connections: a runtime insert needs the worker's verified attempt (C-1, C-5)", () => {
  it("fills the Composio account from the attempt and marks the attempt confirmed", async () => {
    const { connectionId, account } = await seedAttempt(fixture.a, memberA, { toolkit: "fill" });
    await insertConnection(fixture.a, connectionId, memberA, { toolkit: "fill" });
    expect((await fixture.service((tx) => tx.query("SELECT composio_account_id FROM connections WHERE id=$1", [connectionId]))).rows)
      .toEqual([{ composio_account_id: account }]);
    expect(await attemptStatus(fixture.a.tenantId, connectionId)).toBe("confirmed");
    await serviceUpdate(fixture.a.tenantId, connectionId, "status='disconnected', account_label=NULL");
  });

  it("refuses a runtime insert that names a Composio account (no column grant)", async () => {
    const { connectionId } = await seedAttempt(fixture.a, memberA, { toolkit: "named" });
    await expect(fixture.a.run((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'composio','named',$3,'1','shop.myshopify.com','Shop','active',$4,$5,$5,$5)`,
      [fixture.a.tenantId, connectionId, accountId(), memberA, NOW]))).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    ["no attempt", null],
    ["a started attempt", { status: "started" }],
    ["a cancelling attempt", { status: "cancelling" }],
    ["a cancelled attempt", { status: "cancelled" }],
    ["a confirmed attempt", { status: "confirmed" }],
    ["another toolkit", { toolkit: "elsewhere" }],
    ["another store", { domain: "other.myshopify.com" }],
    ["another store ID", { external: "2" }],
    ["another member", { createdBy: null }],
  ] as const)("refuses a runtime insert with %s (23514)", async (_name, over) => {
    const connectionId = over === null ? randomUUID() : (await seedAttempt(fixture.a, memberA, { toolkit: "strict", ...over })).connectionId;
    await expect(insertConnection(fixture.a, connectionId, memberA, { toolkit: "strict" }))
      .rejects.toMatchObject({ code: "23514", constraint: "connections_verified_attempt" });
    if (over !== null) expect(await attemptStatus(fixture.a.tenantId, connectionId)).toBe("status" in over ? over.status : "verified");
  });

  it("does not take another tenant's attempt", async () => {
    const { connectionId } = await seedAttempt(fixture.b, memberB, { toolkit: "cross" });
    await expect(insertConnection(fixture.a, connectionId, memberA, { toolkit: "cross" }))
      .rejects.toMatchObject({ code: "23514", constraint: "connections_verified_attempt" });
    expect(await attemptStatus(fixture.b.tenantId, connectionId)).toBe("verified");
  });

  it("serializes two inserts for one attempt: the second waits, then fails", async () => {
    const { connectionId } = await seedAttempt(fixture.a, memberA, { toolkit: "twice" });
    const first = await database.runtimePool.connect();
    try {
      await first.query("BEGIN");
      await first.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.a.tenantId]);
      await first.query(
        `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
         VALUES ($1,$2,'composio','twice','1','shop.myshopify.com','Shop','active',$3,$4,$4,$4)`, [fixture.a.tenantId, connectionId, memberA, NOW]);
      // The first holds the attempt's lock; the second blocks on it until the first commits.
      let settled = false;
      const second = insertConnection(fixture.a, connectionId, memberA, { toolkit: "twice" }).finally(() => { settled = true; });
      second.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      await first.query("COMMIT");
      await expect(second).rejects.toMatchObject({ code: "23514", constraint: "connections_verified_attempt" });
    } finally {
      first.release();
    }
    await serviceUpdate(fixture.a.tenantId, connectionId, "status='disconnected', account_label=NULL");
  });
});

describe("connections: attempts name a member of their tenant (C-7)", () => {
  it("refuses another tenant's member and clears the member when it is removed", async () => {
    await expect(seedAttempt(fixture.a, memberB, { toolkit: "fk" })).rejects.toMatchObject({ code: "23503" });
    const leaving = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) VALUES ($1,$2,$3,'staff',$4,$4)",
      [fixture.a.tenantId, leaving, `${leaving}@example.test`, NOW]));
    const { connectionId } = await seedAttempt(fixture.a, leaving, { toolkit: "fk", status: "started" });
    await fixture.service((tx) => tx.query("DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, leaving]));
    expect((await fixture.service((tx) => tx.query("SELECT created_by FROM connection_attempts WHERE connection_id=$1", [connectionId]))).rows)
      .toEqual([{ created_by: null }]);
  });

  it("holds one attempt per connection ID", async () => {
    const { connectionId } = await seedAttempt(fixture.a, memberA, { toolkit: "one", status: "started" });
    await expect(fixture.service((tx) => tx.query(
      `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,created_by,browser_hash,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,'one',$4,'ac_1','s.myshopify.com',$5,$6,$7,$7,$7)`,
      [fixture.a.tenantId, randomUUID(), connectionId, accountId(), memberA, "a".repeat(43), NOW]))).rejects.toMatchObject({ code: "23505" });
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
