import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { seedDemo, seedHostedTenant } from "../src/seed/demo.js";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin.js";
import { FAKE_REF, FAKE_SERVICE_KEY, fakeGoTrue } from "./fake-gotrue.js";
import { formatSeedReport, runtimeTargetFor } from "../src/seed/report.js";
import { clock } from "./helpers.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

describe("demo seed", () => {
  it("seeds the jeweler tenant through the action path and is idempotent", async () => {
    const deps = { service: database.servicePool, runtime: database.runtimePool, clock, generateId: randomUUID };
    const first = await seedDemo(deps);
    expect(first).toMatchObject({ contacts: 12, deals: 8 });
    expect(first.resources.map((resource) => resource.name)).toEqual(["Showroom appointments", "Repair intake"]);
    expect(first.bookings).toBe(6);
    const again = await seedDemo(deps);
    expect(again).toEqual(first);
    const counts = (await database.pool.query<{ actions: number; deals: number; moved: number }>(
      `SELECT (SELECT count(*)::int FROM actions WHERE tenant_id=$1) AS actions,
              (SELECT count(*)::int FROM crm_deals WHERE tenant_id=$1) AS deals,
              (SELECT count(*)::int FROM crm_deals WHERE tenant_id=$1 AND revision=2) AS moved`,
      [first.principal.tenantId],
    )).rows[0];
    // 12 contacts + 8 deals + 6 stage moves + 6 bookings, each recorded once.
    expect(counts).toEqual({ actions: 32, deals: 8, moved: 6 });
  });

  it("refuses remote or unchecked pools before any query", async () => {
    const remote = new Pool({ connectionString: "postgres://postgres@db.abcd.supabase.co:5432/postgres" });
    const overridden = new Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "db.example.com" });
    const bare = new Pool({ host: "127.0.0.1", port: 55432, user: "postgres", database: "zs_dev" });
    try {
      const cases: [Pool, Pool][] = [
        [remote, database.runtimePool], [database.servicePool, remote], [overridden, database.runtimePool], [bare, database.runtimePool],
      ];
      for (const [service, runtime] of cases)
        await expect(seedDemo({ service, runtime, clock, generateId: randomUUID })).rejects.toThrow(/Refusing to run/);
      for (const pool of [remote, overridden, bare]) expect(pool.totalCount).toBe(0);
    } finally {
      await Promise.all([remote.end(), overridden.end(), bare.end()]);
    }
  });

  it("refuses non-loopback database URLs", () => {
    expect(() => assertLocalDatabaseUrl("postgres://u@db.abcd.supabase.co:5432/postgres")).toThrow(/127.0.0.1 or localhost/);
  });

  it("accepts loopback URLs and reports their effective destination", () => {
    expect(assertLocalDatabaseUrl("postgres://postgres@127.0.0.1:55432/zs_dev")).toMatchObject({
      connectionString: "postgres://postgres@127.0.0.1:55432/zs_dev", host: "127.0.0.1", port: "55432", database: "zs_dev", user: "postgres",
    });
    expect(assertLocalDatabaseUrl("postgresql://postgres@localhost/zs_dev").host).toBe("localhost");
    expect(assertLocalDatabaseUrl("postgres://postgres@[::1]:55432/zs_dev").host).toBe("::1");
  });

  // pg (through pg-connection-string) lets query parameters override the URL's host and port.
  it.each([
    "postgres://postgres@127.0.0.1:55432/zs_dev?host=db.example.com",
    "postgres://postgres@127.0.0.1:55432/zs_dev?hostaddr=203.0.113.7",
    "postgres://postgres@127.0.0.1:55432/zs_dev?port=6543",
    "postgres://postgres@127.0.0.1:55432/zs_dev?sslmode=disable",
    "postgres://postgres@localhost/zs_dev?host=%2Fvar%2Frun%2Fremote",
    "postgres://postgres@127.0.0.1,db.example.com:5432/zs_dev",
    "postgres://postgres@%2Fvar%2Frun%2Fpostgresql/zs_dev",
    "postgres://postgres@/zs_dev",
    "socket://postgres@/var/run/postgresql?db=zs_dev",
    "/var/run/postgresql zs_dev",
    "mysql://root@127.0.0.1/zs_dev",
  ])("refuses %s", (value) => {
    expect(() => assertLocalDatabaseUrl(value)).toThrow(/Refusing to run/);
  });

  it("prints the runtime database without credentials", async () => {
    const summary = await seedDemo({ service: database.servicePool, runtime: database.runtimePool, clock, generateId: randomUUID });
    const admin = assertLocalDatabaseUrl("postgres://postgres:admin-pw@127.0.0.1:55432/zs_dev");
    const runtime = runtimeTargetFor(admin, "postgres://zs_runtime:runtime-pw@127.0.0.1:55432/zs_dev");
    const report = formatSeedReport(summary, runtime);
    expect(report).not.toMatch(/runtime-pw|admin-pw|postgres:\/\//);
    expect(JSON.parse(report).runtimeDatabase).toEqual({ host: "127.0.0.1", port: "55432", database: "zs_dev" });
    expect(runtimeTargetFor(admin, undefined)).toMatchObject({ user: "zs_runtime", host: "127.0.0.1", database: "zs_dev" });
    expect(runtimeTargetFor(admin, undefined).connectionString).not.toContain("admin-pw");
  });
});

describe("hosted seed", () => {
  let hosted: TestDatabase;
  beforeAll(async () => { hosted = await createTestDatabase(); });
  afterAll(async () => { await hosted?.close(); });

  const members = (tenantId: string) => hosted.pool.query<{ email: string; user_id: string | null; role: string }>(
    "SELECT email, user_id, role::text AS role FROM tenant_members WHERE tenant_id=$1 ORDER BY email", [tenantId]).then((result) => result.rows);

  it("removes the seed's own member and gives the tenant its owner through provisionOwner and the Auth admin API", async () => {
    const gotrue = fakeGoTrue();
    const userId = gotrue.addUser("devin@example.com");
    const auth = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
    const deps = { service: hosted.servicePool, runtime: hosted.runtimePool, clock, generateId: randomUUID };

    const first = await seedHostedTenant(deps, { email: "Devin@Example.com", auth });
    expect(first).toMatchObject({ contacts: 12, deals: 8, bookings: 6, seedMemberRemoved: true,
      provisionedOwner: { action: "created", userId, role: "owner", tenantClaim: "set", activeOwnersBefore: 0 } });
    const tenantId = first.principal.tenantId;
    expect(await members(tenantId)).toEqual([{ email: "devin@example.com", user_id: userId, role: "owner" }]);
    expect(gotrue.claimOf(userId)).toBe(tenantId);

    // A rerun replays the seed, removes its member again and leaves the owner as it was.
    const again = await seedHostedTenant(deps, { email: "devin@example.com", auth });
    expect(again).toMatchObject({ seedMemberRemoved: true, bookings: 6, provisionedOwner: { action: "unchanged", tenantClaim: "present" } });
    expect(await members(tenantId)).toEqual([{ email: "devin@example.com", user_id: userId, role: "owner" }]);
    const actions = await hosted.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM actions WHERE tenant_id=$1", [tenantId]);
    expect(actions.rows[0]!.n).toBe(32);
  });

  it("without an owner email leaves the tenant with no member for db:hosted-provision-owner to fill", async () => {
    const fresh = await createTestDatabase();
    try {
      const summary = await seedHostedTenant({ service: fresh.servicePool, runtime: fresh.runtimePool, clock, generateId: randomUUID });
      expect(summary).toMatchObject({ seedMemberRemoved: true, provisionedOwner: null });
      expect((await fresh.pool.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1", [summary.principal.tenantId])).rowCount).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
