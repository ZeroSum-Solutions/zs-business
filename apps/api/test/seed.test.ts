import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { seedDemo } from "../src/seed/demo.js";
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
    const page = (await database.pool.query<{ published: boolean; resources: number }>(
      `SELECT p.published, (SELECT count(*)::int FROM booking_page_resources r WHERE r.tenant_id=p.tenant_id AND r.page_id=p.id) AS resources
         FROM booking_pages p WHERE p.tenant_id=$1 AND p.id=$2`,
      [first.principal.tenantId, first.bookingPageId],
    )).rows;
    expect(page).toEqual([{ published: true, resources: 2 }]);
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
