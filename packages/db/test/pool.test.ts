import { createServer, connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabase, createRuntimePool, summarizePoolError } from "../src/pool.js";
import { Pool } from "pg";
import { cancelClientConfig, createScopedDatabase, DatabaseUnavailable } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const runtimeUrl = () => {
  const url = new URL(database.url);
  url.username = "zs_runtime";
  return url.href;
};
const elapsed = async (work: () => Promise<unknown>) => {
  const started = performance.now();
  const outcome = await work().then(() => null, (error: unknown) => error);
  return { ms: performance.now() - started, outcome };
};

describe("runtime pool bounds", () => {
  it("gives up on a saturated pool after the connect timeout instead of waiting forever", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, connectionTimeoutMs: 200, onError: () => undefined });
    const held = await pool.connect();
    try {
      const db = createScopedDatabase(pool);
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1")));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("connect");
      expect(ms).toBeLessThan(1000);
      expect(pool.waitingCount).toBe(0);
    } finally {
      held.release();
      await pool.end();
    }
  });

  it("refuses at once when too many requests already wait", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, connectionTimeoutMs: 2000, onError: () => undefined });
    const held = await pool.connect();
    try {
      const db = createScopedDatabase(pool, { maxWaiting: 1 });
      const queued = db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"));
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1")));
      expect((outcome as DatabaseUnavailable).reason).toBe("busy");
      expect(ms).toBeLessThan(100);
      held.release();
      await expect(queued).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  it("stops a transaction when its caller's signal fires, and rolls it back", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool);
    try {
      const controller = new AbortController();
      const statements: string[] = [];
      const outcome = await db.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("SELECT 1");
        statements.push("first");
        controller.abort();
        await tx.query("SELECT 2");
        statements.push("second");
      }, { signal: controller.signal }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect(statements).toEqual(["first"]);
      // The connection went back clean: the next transaction runs.
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
      // An aborted wait for a connection returns that connection when it arrives.
      const held = await pool.connect();
      const late = new AbortController();
      const waiting = db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"), { signal: late.signal });
      late.abort();
      await expect(waiting).rejects.toBeInstanceOf(DatabaseUnavailable);
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(pool.idleCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("cancels a running statement when the caller's time runs out, and reports it as aborted", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool);
    try {
      // The caller has 300 ms left; the statement would run 10 s under the default limits.
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT pg_sleep(10)"), { remainingMs: () => 300 }));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("aborted");
      expect(ms).toBeLessThan(2000);
      // Postgres stopped it: the one connection is free and clean for the next caller.
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
      const active = await database.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='zs_runtime' AND query LIKE 'SELECT pg_sleep%' AND state='active'",
      );
      expect(active.rows[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("keeps a statement timeout the caller's deadline did not shorten as the database's error", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool, { statementTimeoutMs: 100 });
    try {
      const outcome = await db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT pg_sleep(5)"), { remainingMs: () => 10_000 })
        .catch((error: unknown) => error);
      expect(outcome).not.toBeInstanceOf(DatabaseUnavailable);
      expect(outcome).toMatchObject({ code: "57014" });
    } finally {
      await pool.end();
    }
  });

  it("survives a backend lost mid-transaction: the caller gets the error, the process keeps running", async () => {
    // pg-pool hears a client's "error" only while it is idle; a checked-out one's would be uncaught.
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, connectionTimeoutMs: 2000, onError: () => undefined });
    const db = createScopedDatabase(pool);
    try {
      const running = db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT pg_sleep(5)"));
      let pid: number | undefined;
      for (let i = 0; i < 100 && pid === undefined; i++) {
        pid = (await database.pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'SELECT pg_sleep(5)%' LIMIT 1")).rows[0]?.pid;
        if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await database.pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await expect(running).rejects.toMatchObject({ name: "DatabaseUnavailable", reason: "connect", cause: { message: expect.stringMatching(/terminat/) } });
      // The lost client was discarded; the next transaction gets a new connection.
      expect((await db.tenant(fixture.a.tenantId, (tx) => tx.query<{ ok: number }>("SELECT 1 AS ok"))).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it("reports a backend lost between two statements as the lost connection, not as \"not queryable\"", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, connectionTimeoutMs: 2000, onError: () => undefined });
    const failures: unknown[] = [];
    const db = createScopedDatabase(pool, { onResetFailure: (error) => failures.push(error) });
    try {
      const outcome = db.tenant(fixture.a.tenantId, async (tx) => {
        const { rows } = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await database.pool.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
        // Let the client see the socket close before it sends the next statement.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return tx.query("SELECT 1");
      });
      await expect(outcome).rejects.toMatchObject({ name: "DatabaseUnavailable", reason: "connect", cause: { message: expect.stringMatching(/terminat/) } });
      // No cleanup was tried on the dead connection, so none is reported as failed.
      expect(failures).toEqual([]);
      expect((await db.tenant(fixture.a.tenantId, (tx) => tx.query<{ ok: number }>("SELECT 1 AS ok"))).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it("reports pool errors without the URL and at a bounded rate", () => {
    const summary = summarizePoolError(Object.assign(new Error("connect failed for postgres://zs_runtime:hunter2@db.example:5432/app"), { code: "ECONNREFUSED" }));
    expect(summary).toEqual({ code: "ECONNREFUSED", message: "connect failed for [database-url]" });
    const reports: string[] = [];
    let now = 0;
    const pool = createRuntimePool({
      connectionString: runtimeUrl(), onError: (s) => reports.push(s.message), maxErrorReportsPerMinute: 2, now: () => now,
    });
    for (let i = 0; i < 5; i += 1) pool.emit("error", new Error(`e${i}`));
    expect(reports).toEqual(["e0", "e1"]);
    now = 60_000;
    pool.emit("error", new Error("e5"));
    expect(reports).toEqual(["e0", "e1", "3 more pool errors not shown", "e5"]);
    void pool.end();
  });

  it("checks readiness without throwing", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), onError: () => undefined });
    expect(await checkDatabase(pool)).toBe(true);
    await pool.end();
    expect(await checkDatabase(pool)).toBe(false);
  });
});

/** A TCP proxy to the test database that can stop passing the database's answers on. */
async function stallingProxy(target: URL) {
  const sockets = new Set<Socket>();
  let stalled = false;
  let accepted = 0;
  const server = createServer((client) => {
    accepted += 1;
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) => { if (!stalled) client.write(chunk); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(runtimeUrl());
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.href,
    stall: () => { stalled = true; },
    /** Connections opened through the proxy so far. */
    accepted: () => accepted,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("readiness probe", () => {
  it("frees the connection of a probe that timed out, and runs one probe at a time", async () => {
    const proxy = await stallingProxy(new URL(database.url));
    const pool = createRuntimePool({ connectionString: proxy.url, max: 1, connectionTimeoutMs: 2000, onError: () => undefined });
    try {
      expect(await checkDatabase(pool, 200)).toBe(true);
      // The open connection stops answering: every probe times out.
      proxy.stall();
      expect(await Promise.all([checkDatabase(pool, 200), checkDatabase(pool, 200), checkDatabase(pool, 200)])).toEqual([false, false, false]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // No probe still waits for a connection, and the hung one was closed, not kept.
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBe(0);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  });
});

describe("abandoning a statement at the deadline (W3)", () => {
  const lockWaiters = async () => (await database.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'zs_runtime' AND wait_event_type = 'Lock'`,
  )).rows[0]?.n;

  it("answers at once when the connection stops replying mid-statement, and closes that connection", async () => {
    const proxy = await stallingProxy(new URL(database.url));
    const pool = createRuntimePool({ connectionString: proxy.url, max: 1, connectionTimeoutMs: 2000, onError: () => undefined });
    const db = createScopedDatabase(pool);
    try {
      const controller = new AbortController();
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("SELECT 1");
        proxy.stall();
        setTimeout(() => controller.abort(), 200);
        await tx.query("SELECT 2");
      }, { signal: controller.signal }));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("aborted");
      // No wait for a ROLLBACK or reset that cannot answer.
      expect(ms).toBeLessThan(1000);
      // The stalled connection left the pool; the next caller gets a new one.
      expect(pool.totalCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  });

  it("with cancel \"backend\", cancels a statement still running when the signal fires, so it stops holding its lock wait", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool, { cancel: "backend" });
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE booking_resources IN ACCESS EXCLUSIVE MODE");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      // Under the default 5 s lock timeout this read would wait on the lock for 5 s.
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId,
        (tx) => tx.query("SELECT count(*) FROM booking_resources"), { signal: controller.signal }));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect(ms).toBeLessThan(1000);
      // Postgres was told to cancel it while the lock is still held.
      await expect.poll(lockWaiters, { timeout: 1500, interval: 50 }).toBe(0);
      await holder.query("ROLLBACK");
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await pool.end();
    }
  });

  it("by default sends no cancel, safe behind a transaction pooler: the statement ends at its own timeout", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool, { lockTimeoutMs: 1200 });
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE booking_resources IN ACCESS EXCLUSIVE MODE");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId,
        (tx) => tx.query("SELECT count(*) FROM booking_resources"), { signal: controller.signal }));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect((outcome as DatabaseUnavailable).reason).toBe("aborted");
      expect(ms).toBeLessThan(1000);
      // The caller has its answer, the backend still waits (no pg_cancel_backend went out)...
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await lockWaiters()).toBe(1);
      // ...until the lock timeout ends it, while the lock is still held.
      await expect.poll(lockWaiters, { timeout: 2000, interval: 50 }).toBe(0);
      await holder.query("ROLLBACK");
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await pool.end();
    }
  });

  it("with cancel \"backend\", runs at most two cancel connections at once however many statements are abandoned", async () => {
    const proxy = await stallingProxy(new URL(database.url));
    const pool = createRuntimePool({ connectionString: proxy.url, max: 10, connectionTimeoutMs: 2000, onError: () => undefined });
    const db = createScopedDatabase(pool, { cancel: "backend" });
    try {
      const controller = new AbortController();
      let started = 0;
      let allStarted!: () => void;
      const ready = new Promise<void>((resolve) => { allStarted = resolve; });
      const outcomes = Promise.all(Array.from({ length: 10 }, () => db.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("SELECT 1");
        started += 1;
        if (started === 10) allStarted();
        await ready;
        await tx.query("SELECT 2");
      }, { signal: controller.signal }).catch((error: unknown) => error)));
      await ready;
      expect(proxy.accepted()).toBe(10);
      // Every connection stops answering, cancel connections included, so none of them ends.
      proxy.stall();
      // Each transaction sends its second statement, which gets no reply, and is abandoned.
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      const errors = await outcomes;
      expect(errors.every((error) => error instanceof DatabaseUnavailable)).toBe(true);
      await expect.poll(proxy.accepted, { timeout: 1000, interval: 20 }).toBe(12);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(proxy.accepted()).toBe(12);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  });

  it("gives the cancel connection the pool's password, which a spread of the pool's options drops", () => {
    for (const password of ["not-a-real-password", () => "not-a-real-password"]) {
      const pool = new Pool({ connectionString: runtimeUrl(), password });
      expect({ ...pool.options }.password).toBeUndefined();
      expect(cancelClientConfig(pool).password).toBe(password);
      expect(cancelClientConfig(pool)).toMatchObject({ connectionString: runtimeUrl(), application_name: "zs-cancel" });
    }
  });

  it("re-reads the time left before each statement, so a second statement cannot run past the deadline", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool);
    try {
      // 400 ms in all: each 250 ms statement fits the timeout set at the start, both do not.
      const deadline = performance.now() + 400;
      const { ms, outcome } = await elapsed(() => db.tenant(fixture.a.tenantId, async (tx) => {
        await tx.query("SELECT pg_sleep(0.25)");
        await tx.query("SELECT pg_sleep(0.25)");
      }, { remainingMs: () => deadline - performance.now() }));
      expect(outcome).toBeInstanceOf(DatabaseUnavailable);
      expect(ms).toBeLessThan(700);
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });
});

describe("waiting bound", () => {
  it("with maxWaiting 0 still takes an idle connection, and refuses only a checkout that would queue", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const db = createScopedDatabase(pool, { maxWaiting: 0 });
    try {
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
      expect(pool.idleCount).toBe(1);
      await expect(db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
      const held = await pool.connect();
      const refused = await db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT 1")).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(DatabaseUnavailable);
      expect((refused as DatabaseUnavailable).reason).toBe("busy");
      held.release();
    } finally {
      await pool.end();
    }
  });

  it("bounds a burst on a warm pool as on a cold one: idle connections are not room for every waiter", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 2, onError: () => undefined });
    const db = createScopedDatabase(pool, { maxWaiting: 3 });
    const burst = async () => {
      const settled = await Promise.allSettled(Array.from({ length: 10 }, () =>
        db.tenant(fixture.a.tenantId, (tx) => tx.query("SELECT pg_sleep(0.02)"))));
      return settled.filter((outcome) => outcome.status === "rejected"
        && outcome.reason instanceof DatabaseUnavailable && outcome.reason.reason === "busy").length;
    };
    try {
      // Cold: 2 new connections and 3 waiting; the other 5 are refused.
      expect(await burst()).toBe(5);
      expect(pool.idleCount).toBe(2);
      // Warm: the same 2 idle connections serve the first 2, 3 wait, 5 are refused.
      expect(await burst()).toBe(5);
    } finally {
      await pool.end();
    }
  });
});

describe("transaction setup", () => {
  it("sets the role, limits and tenant in seven round trips for one statement, and leaves the session clean", async () => {
    const pool = createRuntimePool({ connectionString: runtimeUrl(), max: 1, onError: () => undefined });
    const sent: string[] = [];
    pool.on("connect", (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: unknown }).query = (...args: unknown[]) => {
        sent.push(String(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text));
        return query(...args);
      };
    });
    try {
      const db = createScopedDatabase(pool, { lockTimeoutMs: 1234, statementTimeoutMs: 5678 });
      const inside = await db.tenant(fixture.a.tenantId, async (tx) => (await tx.query<Record<string, string>>(
        `SELECT current_user AS role, current_setting('app.tenant_id') AS tenant,
                current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement,
                current_setting('transaction_isolation') AS isolation`,
      )).rows[0]);
      expect(inside).toEqual({ role: "authenticated", tenant: fixture.a.tenantId, lock: "1234ms", statement: "5678ms", isolation: "read committed" });
      // Setup (BEGIN and login check, settings, savepoint), the work, release and
      // in-transaction cleanup, COMMIT, and the session reset after it.
      expect(sent).toHaveLength(7);
      expect(sent[2]).toBe("SAVEPOINT zs_work");
      expect(sent[4]).toMatch(/^SET CONSTRAINTS ALL IMMEDIATE; RELEASE SAVEPOINT zs_work; CLOSE ALL;/);
      expect(sent[5]).toBe("COMMIT");
      sent.length = 0;
      // A privileged login is still refused before any work runs.
      const admin = createScopedDatabase(database.pool);
      await expect(admin.tenant(fixture.a.tenantId, () => Promise.resolve("ran"))).rejects.toThrow("unprivileged LOGIN");
      // Nothing set inside the transaction survives it on the pooled connection.
      const client = await pool.connect();
      try {
        expect((await client.query<Record<string, string>>(
          `SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant, current_setting('lock_timeout') AS lock`,
        )).rows[0]).toEqual({ role: "zs_runtime", tenant: "", lock: "0" });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
