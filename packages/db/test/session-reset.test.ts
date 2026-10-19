import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createScopedDatabase } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

/** A one-connection runtime pool whose post-commit session reset goes through `onReset`. */
function interceptedPool(onReset: (run: () => Promise<unknown>) => Promise<unknown>): Pool {
  const pool = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 1 });
  const patched = new WeakSet<PoolClient>();
  const connect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const client = await connect();
    if (!patched.has(client)) {
      patched.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      client.query = ((...args: unknown[]) =>
        typeof args[0] === "string" && args[0].startsWith("CLOSE ALL;") ? onReset(() => query(...args)) : query(...args)) as typeof client.query;
    }
    return client;
  }) as typeof pool.connect;
  return pool;
}

/** A plain query on the pool's next connection (the patched connect takes no callback, so no pool.query). */
async function borrow<T extends object>(pool: Pool, sql: string): Promise<T> {
  const client = await pool.connect();
  try {
    return (await client.query<T>(sql)).rows[0]!;
  } finally {
    client.release();
  }
}
const pid = async (pool: Pool) => (await borrow<{ pid: number }>(pool, "select pg_backend_pid() as pid")).pid;

describe("scoped transaction session reset", () => {
  it("reports a failed reset through onResetFailure and discards the connection", async () => {
    let fail = true;
    const pool = interceptedPool((run) => {
      if (!fail) return run();
      fail = false;
      return Promise.reject(new Error("reset failed"));
    });
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      const first = await scoped.tenant(fixture.a.tenantId, async (tx) => (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid);
      expect(failures).toHaveLength(1);
      expect(String(failures[0])).toContain("reset failed");
      // The work still committed and returned; the connection did not go back to the pool.
      expect(await pid(pool)).not.toBe(first);
      await scoped.tenant(fixture.a.tenantId, async () => undefined);
      expect(failures).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  // Behind Supavisor's transaction mode the post-commit reset may reach another backend.
  it("leaves the next borrower clean even when the post-commit reset never reaches this backend", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    try {
      const scoped = createScopedDatabase(pool);
      const first = await scoped.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("select set_config('zs.probe', 'dirty', false), set_config('app.tenant_id', $1, false)", [fixture.b.tenantId]);
        await tx.query("set application_name = 'zs-dirty'");
        await tx.query("set session role authenticated");
        await tx.query("select pg_advisory_lock(4243)");
        return (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      });
      const row = await borrow<Record<string, unknown>>(pool, `select pg_backend_pid() as pid, coalesce(current_setting('zs.probe', true), '') as probe,
        coalesce(current_setting('app.tenant_id', true), '') as tenant, current_setting('application_name') as app, current_user::text as role,
        (select count(*)::int from pg_locks where locktype='advisory' and pid=pg_backend_pid()) as advisory`);
      expect(row).toMatchObject({ pid: first, probe: "", tenant: "", role: "zs_runtime", advisory: 0 });
      expect(row.app).not.toBe("zs-dirty");
    } finally {
      await pool.end();
    }
  });
});
