// Native Shopify storage rules (docs/requirements/connections.md C-21, C-22, C-24, C-26): only the worker binds a
// native connection; a store belongs to one live row; the install ledger, claims and webhook ledger are worker-only;
// claims are tenant rows (two-tenant denial); a store identity can only be blanked, on a disconnected native row.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const NOW = "2026-11-07T12:00:00.000Z";
let database: TestDatabase;
let fixture: TwoTenantFixture;
const memberA = randomUUID();
const memberB = randomUUID();

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  await fixture.service(async (tx) => {
    for (const [tenantId, id] of [[fixture.a.tenantId, memberA], [fixture.b.tenantId, memberB]] as const)
      await tx.query("INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) VALUES ($1,$2,$3,'owner',$4,$4)", [tenantId, id, `${id}@example.test`, NOW]);
  });
});
afterAll(async () => { await database?.close(); });

const nativeInsert = (tenantId: string, member: string, external: string, id = randomUUID()) => fixture.service((tx) => tx.query(
  `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
   VALUES ($1,$2,'native','shopify',$3,$4,'Shop','active',$5,$6,$6,$6)`, [tenantId, id, external, `s${external}.myshopify.com`, member, NOW]).then(() => id));
const claimInsert = (tenantId: string, member: string, hash = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), status = "open") => fixture.service((tx) => tx.query(
  `INSERT INTO shopify_claims (tenant_id,id,created_by,code_hash,status,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6,$6)`,
  [tenantId, randomUUID(), member, hash, status, NOW]));

describe("native connections (C-21, C-26)", () => {
  it("lets the worker bind one and refuses the runtime role (42501), even as the tenant", async () => {
    const id = await nativeInsert(fixture.a.tenantId, memberA, "9001");
    await expect(fixture.b.run((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'native','shopify','9002','s.myshopify.com','S','active',$3,$4,$4,$4)`, [fixture.b.tenantId, randomUUID(), memberB, NOW]))).rejects.toMatchObject({ code: "42501" });
    expect(await fixture.a.run(async (tx) => (await tx.query("SELECT tier FROM connections WHERE id=$1", [id])).rows)).toEqual([{ tier: "native" }]);
    expect(await fixture.b.run(async (tx) => (await tx.query("SELECT id FROM connections")).rowCount)).toBe(0);
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [id]));
  });
  it("binds a store to one tenant at a time, and frees it when the row disconnects", async () => {
    const first = await nativeInsert(fixture.a.tenantId, memberA, "9100");
    await expect(nativeInsert(fixture.b.tenantId, memberB, "9100")).rejects.toMatchObject({ code: "23505", constraint: "connections_native_shop" });
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [first]));
    const second = await nativeInsert(fixture.b.tenantId, memberB, "9100");
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [second]));
  });
  it("two tenants binding one store at once end with exactly one row", async () => {
    const results = await Promise.allSettled([nativeInsert(fixture.a.tenantId, memberA, "9200"), nativeInsert(fixture.b.tenantId, memberB, "9200")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await fixture.service((tx) => tx.query("SELECT id FROM connections WHERE external_account_id='9200'"))).rowCount).toBe(1);
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE external_account_id='9200'"));
  });
  it("needs no Composio account for native and refuses one (23514); a composio row still takes its account from an attempt", async () => {
    await expect(fixture.service((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'native','shopify','ca_1','9301','s.myshopify.com','S','active',$3,$4,$4,$4)`, [fixture.a.tenantId, randomUUID(), memberA, NOW]))).rejects.toMatchObject({ code: "23514", constraint: "connections_account_by_tier" });
    // The take-attempt trigger still runs for composio rows: no attempt, no row.
    await expect(fixture.service((tx) => tx.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'composio','kit','1','s.myshopify.com','S','active',$3,$4,$4,$4)`, [fixture.a.tenantId, randomUUID(), memberA, NOW]))).rejects.toMatchObject({ code: "42501" });
    const id = await nativeInsert(fixture.a.tenantId, memberA, "9300");
    await expect(fixture.service((tx) => tx.query("UPDATE connections SET composio_account_id='ca_1' WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [id]));
  });
  it("never lets the tier change", async () => {
    const id = await nativeInsert(fixture.a.tenantId, memberA, "9400");
    await expect(fixture.service((tx) => tx.query("UPDATE connections SET tier='composio' WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [id]));
  });
  it("lets shop/redact blank a disconnected native row's store, only to the fixed values (C-24)", async () => {
    const id = await nativeInsert(fixture.a.tenantId, memberA, "9500");
    const blank = "UPDATE connections SET account_domain='redacted.invalid', external_account_id='redacted' WHERE id=$1";
    await expect(fixture.service((tx) => tx.query(blank, [id]))).rejects.toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [id]));
    await expect(fixture.service((tx) => tx.query("UPDATE connections SET account_domain='other.myshopify.com' WHERE id=$1", [id]))).rejects.toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query(blank, [id]));
    expect((await fixture.service((tx) => tx.query("SELECT account_domain, external_account_id FROM connections WHERE id=$1", [id]))).rows).toEqual([{ account_domain: "redacted.invalid", external_account_id: "redacted" }]);
  });
});

describe("native reauthorize recovery (C-22)", () => {
  const toReauth = "UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error' WHERE id=$1";
  const toActive = "UPDATE connections SET status='active', reauthorize_reason=NULL WHERE id=$1";
  it("lets the worker restore a native row from auth_error, and nobody else; disconnected stays final", async () => {
    const id = await nativeInsert(fixture.a.tenantId, memberA, "9600");
    await fixture.service((tx) => tx.query(toReauth, [id]));
    await expect(fixture.a.run((tx) => tx.query(toActive, [id]))).rejects.toMatchObject({ code: "42501" });
    await fixture.service((tx) => tx.query(toActive, [id]));
    expect((await fixture.service((tx) => tx.query("SELECT status FROM connections WHERE id=$1", [id]))).rows).toEqual([{ status: "active" }]);
    await fixture.service((tx) => tx.query("UPDATE connections SET status='disconnected', account_label=NULL WHERE id=$1", [id]));
    await expect(fixture.service((tx) => tx.query(toActive, [id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("install ledger, claims, webhook events (C-22, C-21, C-24)", () => {
  it("refuses the runtime role everything on all three tables (42501)", async () => {
    for (const table of ["shopify_installs", "shopify_claims", "shopify_webhook_events", "shopify_locks"]) {
      await expect(fixture.a.run((tx) => tx.query(`SELECT * FROM ${table}`)), table).rejects.toMatchObject({ code: "42501" });
      await expect(fixture.a.run((tx) => tx.query(`DELETE FROM ${table}`)), table).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("scopes claims by tenant even if the runtime role were granted the table (the policy is the second wall)", async () => {
    await fixture.service((tx) => tx.query("UPDATE shopify_claims SET status='cancelled'"));
    await claimInsert(fixture.a.tenantId, memberA);
    await claimInsert(fixture.b.tenantId, memberB);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("GRANT SELECT, UPDATE ON public.shopify_claims TO authenticated");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [fixture.a.tenantId]);
      expect((await client.query("SELECT tenant_id FROM shopify_claims WHERE status='open'")).rows).toEqual([{ tenant_id: fixture.a.tenantId }]);
      expect((await client.query("UPDATE shopify_claims SET status='cancelled' WHERE tenant_id=$1", [fixture.b.tenantId])).rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await fixture.service((tx) => tx.query("UPDATE shopify_claims SET status='cancelled'"));
  });
  it("keeps tokens exactly while an install is not uninstalled (23514)", async () => {
    const insert = (status: string, sealed: string | null) => fixture.service((tx) => tx.query(
      `INSERT INTO shopify_installs (shop_id,shop_domain,shop_name,scopes,status,access_sealed,access_key_id,refresh_sealed,refresh_key_id,access_expires_at,refresh_expires_at,installed_at,uninstalled_at,created_at,updated_at)
       VALUES ($1,$2,'Shop','read_orders',$3,$4,$5,$4,$5,$6,$6,$7,$8,$7,$7)`,
      [`gid://shopify/Shop/${Math.floor(Math.random() * 1e9)}`, `t${Math.floor(Math.random() * 1e9)}.myshopify.com`, status, sealed, sealed === null ? null : "k1",
        sealed === null ? null : NOW, NOW, status === "uninstalled" ? NOW : null]));
    await insert("live", `zss1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(30)}`);
    await expect(insert("live", null)).rejects.toMatchObject({ code: "23514" });
    await expect(insert("uninstalled", `zss1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(30)}`)).rejects.toMatchObject({ code: "23514" });
    await insert("uninstalled", null);
  });
  it("lets one tenant hold one open claim, and a code belongs to one claim", async () => {
    const hash = "a".repeat(64);
    await claimInsert(fixture.a.tenantId, memberA, hash);
    await expect(claimInsert(fixture.a.tenantId, memberA)).rejects.toMatchObject({ code: "23505", constraint: "shopify_claims_one_open" });
    await expect(claimInsert(fixture.b.tenantId, memberB, hash)).rejects.toMatchObject({ code: "23505", constraint: "shopify_claims_code" });
    await claimInsert(fixture.b.tenantId, memberB);
    await fixture.service((tx) => tx.query("UPDATE shopify_claims SET status='cancelled'"));
    await claimInsert(fixture.a.tenantId, memberA);
  });
  it("refuses a redeemed claim that names no store (23514)", async () => {
    await fixture.service((tx) => tx.query("UPDATE shopify_claims SET status='cancelled'"));
    await expect(claimInsert(fixture.a.tenantId, memberA, undefined, "redeemed")).rejects.toMatchObject({ code: "23514", constraint: "shopify_claims_redeemed" });
  });
  it("takes a webhook id once", async () => {
    const insert = () => fixture.service((tx) => tx.query("INSERT INTO shopify_webhook_events (webhook_id,topic,shop_domain,received_at) VALUES ('w-1','app/uninstalled','s.myshopify.com',$1)", [NOW]));
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
  });
});
