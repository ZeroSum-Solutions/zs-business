import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { seedDemo } from "../src/seed/demo.js";
import { clock } from "./helpers.js";

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

describe("demo seed", () => {
  it("seeds the jeweler tenant through the action path and is idempotent", async () => {
    const deps = { service: database.servicePool, db: database.db, clock, generateId: randomUUID };
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

  it("refuses non-loopback database URLs", () => {
    expect(() => assertLocalDatabaseUrl("postgres://u@db.abcd.supabase.co:5432/postgres")).toThrow(/127.0.0.1 or localhost/);
    expect(assertLocalDatabaseUrl("postgres://postgres@127.0.0.1:55432/zs_dev").pathname).toBe("/zs_dev");
  });
});
