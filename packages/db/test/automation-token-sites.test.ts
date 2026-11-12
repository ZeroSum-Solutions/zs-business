// hub-access.md H-14: the sites an automation token may publish. The list is written with the
// token row and never changes; a token holds 1 to 10 sites with `sites:publish` and none without;
// a site or token of another tenant cannot be named; the runtime role can read and insert only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const NOW = "2026-11-11T12:00:00.000Z";
let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

type Tenant = TwoTenantFixture["a"];
const site = async (tenant: Tenant) => {
  const id = randomUUID();
  await tenant.run((tx) => tx.query("INSERT INTO sites (tenant_id,id,name,created_at,updated_at) VALUES ($1,$2,'Site',$3,$3)", [tenant.tenantId, id, NOW]));
  return id;
};
/** The token row and its site rows in one runtime transaction, as the create handler writes them. */
const createToken = async (tenant: Tenant, scopes: string[], siteIds: string[], tokenId = randomUUID()) => {
  await tenant.run(async (tx) => {
    await tx.query(
      `INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at)
       VALUES ($1,$2,'T',$3::automation_token_scope[],$4,$5,$6)`,
      [tenant.tenantId, tokenId, scopes, randomUUID(), NOW, scopes.includes("sites:publish") ? "2026-12-11T12:00:00.000Z" : null]);
    for (const siteId of siteIds)
      await tx.query("INSERT INTO automation_token_sites (tenant_id,token_id,site_id) VALUES ($1,$2,$3)", [tenant.tenantId, tokenId, siteId]);
  });
  return tokenId;
};
const rows = (tenant: Tenant, tokenId: string) => tenant.run(async (tx) =>
  (await tx.query<{ site_id: string }>("SELECT site_id FROM automation_token_sites WHERE tenant_id=$1 AND token_id=$2", [tenant.tenantId, tokenId])).rows.map((row) => row.site_id));

describe("automation_token_sites (H-14)", () => {
  it("stores the named sites with the token and reads them back under RLS", async () => {
    const one = await site(fixture.a);
    const two = await site(fixture.a);
    const tokenId = await createToken(fixture.a, ["sites:publish"], [one, two]);
    expect((await rows(fixture.a, tokenId)).sort()).toEqual([one, two].sort());
    // Tenant B sees none of it.
    expect(await rows(fixture.b, tokenId)).toEqual([]);
  });

  it("holds 1 to 10 sites with sites:publish and none without it, checked at commit", async () => {
    const sites = await Promise.all(Array.from({ length: 11 }, () => site(fixture.a)));
    await expect(createToken(fixture.a, ["sites:publish"], [])).rejects.toMatchObject({ code: "23514" });
    await expect(createToken(fixture.a, ["contacts:read"], [sites[0]!])).rejects.toMatchObject({ code: "23514" });
    await expect(createToken(fixture.a, ["sites:publish"], sites)).rejects.toMatchObject({ code: "23514" });
    await expect(createToken(fixture.a, ["sites:publish"], sites.slice(0, 10))).resolves.toBeTruthy();
  });

  it("cannot name another tenant's site or token (composite keys)", async () => {
    const foreignSite = await site(fixture.b);
    await expect(createToken(fixture.a, ["sites:publish"], [foreignSite])).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an insert after creation, an update and a delete, so a token's list never widens or shrinks", async () => {
    const one = await site(fixture.a);
    const extra = await site(fixture.a);
    const tokenId = await createToken(fixture.a, ["sites:publish"], [one]);
    await expect(fixture.a.run((tx) => tx.query(
      "INSERT INTO automation_token_sites (tenant_id,token_id,site_id) VALUES ($1,$2,$3)", [fixture.a.tenantId, tokenId, extra]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE automation_token_sites SET site_id=$3 WHERE tenant_id=$1 AND token_id=$2", [fixture.a.tenantId, tokenId, extra]))).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query(
      "DELETE FROM automation_token_sites WHERE tenant_id=$1 AND token_id=$2", [fixture.a.tenantId, tokenId]))).rejects.toMatchObject({ code: "42501" });
    expect(await rows(fixture.a, tokenId)).toEqual([one]);
  });

  it("refuses to widen a committed token by re-writing its row first, and a token revokes once and stays revoked", async () => {
    const one = await site(fixture.a);
    const extra = await site(fixture.a);
    const tokenId = await createToken(fixture.a, ["sites:publish"], [one]);
    const insertExtra = (tx: Parameters<Parameters<Tenant["run"]>[0]>[0]) => tx.query(
      "INSERT INTO automation_token_sites (tenant_id,token_id,site_id) VALUES ($1,$2,$3)", [fixture.a.tenantId, tokenId, extra]);
    // A no-op update gives the row a new writer; the update itself is refused, so the insert never gets there.
    await expect(fixture.a.run(async (tx) => {
      await tx.query("UPDATE automation_tokens SET revoked_at=revoked_at WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, tokenId]);
      await insertExtra(tx);
    })).rejects.toMatchObject({ code: "42501" });
    expect(await rows(fixture.a, tokenId)).toEqual([one]);
    // The one legitimate update still works, once.
    const revoke = () => fixture.a.run((tx) => tx.query(
      "UPDATE automation_tokens SET revoked_at=$3, revoked_by=$4 WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, tokenId, NOW, randomUUID()]));
    await revoke();
    await expect(revoke()).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.a.run((tx) => tx.query(
      "UPDATE automation_tokens SET revoked_at=NULL, revoked_by=NULL WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, tokenId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a site row for a token another open transaction is creating", async () => {
    const one = await site(fixture.a);
    const tokenId = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at)
         VALUES ($1,$2,'T','{sites:publish}',$3,$4,$5)`, [fixture.a.tenantId, tokenId, randomUUID(), NOW, "2026-12-11T12:00:00.000Z"]);
      // Another connection cannot see the uncommitted token, and could not name it either.
      await expect(fixture.a.run((tx) => tx.query(
        "INSERT INTO automation_token_sites (tenant_id,token_id,site_id) VALUES ($1,$2,$3)", [fixture.a.tenantId, tokenId, one]))).rejects.toBeDefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
