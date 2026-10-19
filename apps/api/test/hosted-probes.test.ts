import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createScopedDatabase, type ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { poolerTransport, sessionContaminationProbe } from "../src/hosted-probes.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
let pool: Pool;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  pool = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 3 });
});
afterAll(async () => {
  await pool?.end();
  await database?.close();
});

/** A scoped database that never resets the session: what a lost post-commit reset looks like. */
function unresetDatabase(target: Pool): ScopedDatabase {
  return {
    async tenant(tenantId, work) {
      const client = await target.connect();
      try {
        await client.query("BEGIN; SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } finally {
        client.release();
      }
    },
  };
}

describe("hosted session-contamination probe", () => {
  it("passes on createScopedDatabase with no reset failures", async () => {
    const failures: unknown[] = [];
    const result = await sessionContaminationProbe(createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) }), fixture.a.tenantId, 60);
    expect(result).toEqual({ ok: true, detail: { reads: 54, dirtied: 6, contaminated: 0, wrongTenant: 0 } });
    expect(failures).toEqual([]);
  });

  it("fails when session state survives into later transactions", async () => {
    const dirty = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 1 });
    try {
      const result = await sessionContaminationProbe(unresetDatabase(dirty), fixture.a.tenantId, 60);
      expect(result.ok).toBe(false);
      expect(result.detail.contaminated).toBeGreaterThan(0);
    } finally {
      await dirty.end();
    }
  });

  it("names the pooler mode from the port", () => {
    expect(poolerTransport("6543")).toEqual({ port: "6543", mode: "transaction" });
    expect(poolerTransport("5432")).toEqual({ port: "5432", mode: "session" });
    expect(poolerTransport("15432")).toEqual({ port: "15432", mode: "unknown" });
  });
});
