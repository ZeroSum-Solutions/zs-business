import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabase, createRuntimePool, summarizePoolError } from "../src/pool.js";
import { createScopedDatabase, DatabaseUnavailable } from "../src/scoped.js";
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
