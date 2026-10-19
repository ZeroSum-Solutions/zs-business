import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createScopedDatabase, type ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { expectedTransport, poolerTransport, sessionContaminationProbe, transportGate } from "../src/hosted-probes.js";

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

/**
 * A scoped database with a hand-rolled session policy: `cleanOnCommit` runs an in-transaction
 * cleanup before COMMIT, `cleanOnThrow` after ROLLBACK TO SAVEPOINT; no reset ever runs
 * after the transaction, as when Supavisor hands the post-commit reset to another backend.
 */
function handRolledDatabase(target: Pool, policy: { cleanOnCommit: boolean; cleanOnThrow: boolean }): ScopedDatabase {
  const cleanup = "CLOSE ALL; UNLISTEN *; DISCARD TEMP; RESET ALL; RESET ROLE; SELECT pg_advisory_unlock_all()";
  return {
    async tenant(tenantId, work) {
      const client = await target.connect();
      try {
        await client.query("BEGIN; SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query("SAVEPOINT work");
        try {
          const result = await work(client);
          if (policy.cleanOnCommit) await client.query(cleanup);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT work");
          if (policy.cleanOnThrow) await client.query(cleanup);
          await client.query("ROLLBACK");
          throw error;
        }
      } finally {
        client.release();
      }
    },
  };
}

const small = { rounds: 6, dirtyPerRound: 2, readsPerRound: 4 };

describe("hosted session-contamination probe", () => {
  it("passes on createScopedDatabase, with handoffs from committed and thrown transactions observed", async () => {
    const failures: unknown[] = [];
    const result = await sessionContaminationProbe(createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) }), fixture.a.tenantId, small);
    expect(result.detail).toMatchObject({
      reads: 24, dirtied: { committed: 6, thrown: 6 }, applied: { advisory: 12, temp: 12, cursor: 12, listen: 12 },
      contaminated: { custom: 0, app: 0, advisory: 0, temp: 0, cursor: 0, listen: 0 }, wrongTenant: 0, failures: [],
    });
    expect(result.detail.handoffs.fromCommitted).toBeGreaterThan(0);
    expect(result.detail.handoffs.fromThrown).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(failures).toEqual([]);
  });

  it("fails when session state survives into later transactions", async () => {
    const dirty = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 1 });
    try {
      const result = await sessionContaminationProbe(handRolledDatabase(dirty, { cleanOnCommit: false, cleanOnThrow: false }), fixture.a.tenantId, small);
      expect(result.ok).toBe(false);
      expect(result.detail.contaminated.custom).toBeGreaterThan(0);
      expect(result.detail.contaminated.temp).toBeGreaterThan(0);
      expect(result.detail.contaminated.cursor).toBeGreaterThan(0);
      expect(result.detail.contaminated.listen).toBeGreaterThan(0);
    } finally {
      await dirty.end();
    }
  });

  it("fails when only throwing transactions leave state behind", async () => {
    const dirty = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 1 });
    try {
      const result = await sessionContaminationProbe(handRolledDatabase(dirty, { cleanOnCommit: true, cleanOnThrow: false }), fixture.a.tenantId, small);
      expect(result.ok).toBe(false);
      // ROLLBACK undoes settings, temp tables, cursors and LISTEN, but not a session advisory lock.
      expect(result.detail.contaminated).toMatchObject({ custom: 0, temp: 0, cursor: 0, listen: 0 });
      expect(result.detail.contaminated.advisory).toBeGreaterThan(0);
    } finally {
      await dirty.end();
    }
  });

  it("fails with no handoff observed when no reader reuses a dirtied backend", async () => {
    const url = database.runtimePool.options.connectionString;
    const pools: Pool[] = [];
    // A fresh backend for every transaction: nothing can leak, but nothing was tested either.
    const fresh: ScopedDatabase = {
      async tenant(tenantId, work) {
        const once = new Pool({ connectionString: url, max: 1 });
        pools.push(once);
        return createScopedDatabase(once).tenant(tenantId, work);
      },
    };
    try {
      const result = await sessionContaminationProbe(fresh, fixture.a.tenantId, small);
      expect(result.ok).toBe(false);
      expect(result.detail.handoffs).toEqual({ fromCommitted: 0, fromThrown: 0 });
      expect(result.detail.failures).toEqual([
        "no handoff observed from a committed dirtying transaction",
        "no handoff observed from a throwing dirtying transaction",
      ]);
    } finally {
      await Promise.all(pools.map((once) => once.end()));
    }
  });
});

describe("hosted transport gate", () => {
  it("names the pooler mode from the port", () => {
    expect(poolerTransport("6543")).toEqual({ port: "6543", mode: "transaction" });
    expect(poolerTransport("5432")).toEqual({ port: "5432", mode: "session" });
    expect(poolerTransport("15432")).toEqual({ port: "15432", mode: "unknown" });
  });

  it("requires the transport the deployment uses", () => {
    expect(transportGate("6543", "transaction").ok).toBe(true);
    expect(transportGate("5432", "session").ok).toBe(true);
    expect(transportGate("5432", "transaction")).toMatchObject({ ok: false, detail: { error: "runtime URL uses session mode; the deployment uses transaction mode" } });
    expect(transportGate("6543", "session").ok).toBe(false);
    expect(transportGate("15432", "transaction")).toMatchObject({ ok: false, detail: { error: expect.stringContaining("unsupported transport: port 15432") } });
  });

  it("reads the expected transport from --expect-transport, defaulting to transaction mode", () => {
    expect(expectedTransport([])).toBe("transaction");
    expect(expectedTransport(["--", "--expect-transport=session"])).toBe("session");
    expect(() => expectedTransport(["--expect-transport=direct"])).toThrow(/unsupported transport "direct"/);
    expect(() => expectedTransport(["--transport=session"])).toThrow(/unknown argument/);
  });
});
