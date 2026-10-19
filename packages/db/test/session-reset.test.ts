import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createScopedDatabase, DatabaseUnavailable, type Transaction } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

// The post-transaction SESSION_RESET; the in-transaction cleanup starts "CLOSE ALL; UNLISTEN".
const POST_RESET = "CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT;";

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
        typeof args[0] === "string" && args[0].startsWith(POST_RESET) ? onReset(() => query(...args)) : query(...args)) as typeof client.query;
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

/** Leaves every kind of session state a transaction can create, and returns the backend pid. */
async function dirty(tx: Transaction, other: string): Promise<number> {
  await tx.query("select set_config('zs.probe', 'dirty', false), set_config('app.tenant_id', $1, false)", [other]);
  await tx.query("set application_name = 'zs-dirty'");
  await tx.query("set session role authenticated");
  await tx.query("select pg_advisory_lock(4243)");
  await tx.query("create temp table zs_leak as select $1::text as tenant", [other]);
  await tx.query("declare zs_held cursor with hold for select tenant from zs_leak");
  await tx.query("listen zs_leak_channel");
  await tx.query("prepare zs_leak_plan as select 1");
  return (await tx.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
}
/** What the next borrower of the same connection sees. */
const SESSION_STATE = `select pg_backend_pid() as pid, coalesce(current_setting('zs.probe', true), '') as probe,
  coalesce(current_setting('app.tenant_id', true), '') as tenant, current_setting('application_name') as app, current_user::text as role,
  (select count(*)::int from pg_locks where locktype='advisory' and pid=pg_backend_pid()) as advisory,
  (select count(*)::int from pg_class where relnamespace=pg_my_temp_schema()) as temp,
  (select count(*)::int from pg_cursors) as cursors,
  (select count(*)::int from pg_listening_channels()) as listens,
  (select count(*)::int from pg_prepared_statements where from_sql) as prepared`;
const CLEAN = { probe: "", tenant: "", role: "zs_runtime", advisory: 0, temp: 0, cursors: 0, listens: 0, prepared: 0 };

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
      const first = await scoped.tenant(fixture.a.tenantId, (tx) => dirty(tx, fixture.b.tenantId));
      const row = await borrow<Record<string, unknown>>(pool, SESSION_STATE);
      expect(row).toMatchObject({ pid: first, ...CLEAN });
      expect(row.app).not.toBe("zs-dirty");
    } finally {
      await pool.end();
    }
  });

  it("cleans the backend before rolling back when work throws, without the post-transaction reset", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      let first = 0;
      const thrown = new Error("work failed");
      await expect(scoped.tenant(fixture.a.tenantId, async (tx) => {
        first = await dirty(tx, fixture.b.tenantId);
        throw thrown;
      })).rejects.toBe(thrown);
      expect(await borrow<Record<string, unknown>>(pool, SESSION_STATE)).toMatchObject({ pid: first, ...CLEAN });
      // A statement error aborts the transaction; the savepoint still recovers it.
      await expect(scoped.tenant(fixture.a.tenantId, async (tx) => {
        await dirty(tx, fixture.b.tenantId);
        await tx.query("select 1/0");
      })).rejects.toMatchObject({ code: "22012" });
      expect(await borrow<Record<string, unknown>>(pool, SESSION_STATE)).toMatchObject({ pid: first, ...CLEAN });
      expect(failures).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("keeps transaction-local tenant settings inside the work and none after it", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    try {
      const scoped = createScopedDatabase(pool);
      const inside = await scoped.tenant(fixture.a.tenantId, async (tx) => (await tx.query<Record<string, string>>(
        "select current_setting('app.tenant_id') as tenant, current_user::text as role, current_setting('statement_timeout') as timeout")).rows[0]!);
      expect(inside).toEqual({ tenant: fixture.a.tenantId, role: "authenticated", timeout: "15s" });
      expect(await borrow<Record<string, unknown>>(pool, SESSION_STATE)).toMatchObject(CLEAN);
    } finally {
      await pool.end();
    }
  });

  it("fires deferred constraints inside the work, so a violation still rolls back cleanly", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      await expect(scoped.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("create temp table zs_deferred (id int unique deferrable initially deferred)");
        await tx.query("insert into zs_deferred values (1), (1)");
      })).rejects.toMatchObject({ code: "23505" });
      expect(failures).toEqual([]);
      expect(await borrow<Record<string, unknown>>(pool, SESSION_STATE)).toMatchObject(CLEAN);
    } finally {
      await pool.end();
    }
  });

  // The deadline gate refuses every statement once time is up; the recovery statements on the
  // error path must still reach the backend, or a pooled backend keeps the work's session state.
  it("cleans the backend when the deadline passes during the work, without the post-transaction reset", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      let left = 10_000;
      let first = 0;
      const outcome = await scoped.tenant(fixture.a.tenantId, async (tx) => {
        first = await dirty(tx, fixture.b.tenantId);
        left = 0;
        await tx.query("select 1");
      }, { remainingMs: () => left }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("aborted");
      expect(failures).toEqual([]);
      expect(await borrow<Record<string, unknown>>(pool, SESSION_STATE)).toMatchObject({ pid: first, ...CLEAN });
    } finally {
      await pool.end();
    }
  });

  it("reports and discards a statement abandoned after the work began, since nothing could clean its backend", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      const controller = new AbortController();
      let first = 0;
      const outcome = await scoped.tenant(fixture.a.tenantId, async (tx) => {
        first = await dirty(tx, fixture.b.tenantId);
        setTimeout(() => controller.abort(), 100);
        await tx.query("select pg_sleep(1)");
      }, { signal: controller.signal }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("aborted");
      expect(failures).toEqual([outcome]);
      expect(await pid(pool)).not.toBe(first);
    } finally {
      await pool.end();
    }
  });

  it("discards the connection and reports it when work ends the transaction itself", async () => {
    const pool = interceptedPool(async () => ({ rows: [] }));
    const failures: unknown[] = [];
    try {
      const scoped = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
      const first = await pid(pool);
      await expect(scoped.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("select pg_advisory_lock(4244)");
        await tx.query("commit");
      })).rejects.toThrow(/RELEASE SAVEPOINT/);
      expect(failures).toHaveLength(1);
      expect(await pid(pool)).not.toBe(first);
    } finally {
      await pool.end();
    }
  });
});
