import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { createScopedDatabase, type ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  abandonedTransactionProbe, abandonGate, concurrentTenantProbe, hostedCheckArgs, poolerTransport, sessionContaminationProbe, transportGate,
} from "../src/hosted-probes.js";

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
    withoutTenant: () => Promise.reject(new Error("unused")),
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
      withoutTenant: () => Promise.reject(new Error("unused")),
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

describe("hosted concurrent-tenant load probe", () => {
  const CONTACTS = 3;
  let loadPool: Pool;
  beforeAll(async () => {
    await fixture.service(async (tx) => {
      for (let n = 0; n < CONTACTS; n += 1)
        await tx.query(
          `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
           VALUES ($1,$2,NULL,$3,NULL,now(),now())`, [fixture.a.tenantId, randomUUID(), `load-${n}@example.test`]);
    });
    // The hosted check's runtime pool size.
    loadPool = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 10 });
  });
  afterAll(async () => {
    await loadPool?.end();
  });
  const targets = () => [{ tenantId: fixture.a.tenantId, contacts: CONTACTS }, { tenantId: fixture.b.tenantId, contacts: 0 }] as const;

  it("runs all 200 transactions on a pool of 10 when the queue has room for them", async () => {
    const failures: unknown[] = [];
    const result = await concurrentTenantProbe(createScopedDatabase(loadPool, { maxWaiting: 256, onResetFailure: (error) => failures.push(error) }), targets());
    expect(result.detail).toMatchObject({ total: 200, fulfilled: 200, rejected: {}, bad: [], failures: [] });
    expect(result.ok).toBe(true);
    expect(failures).toEqual([]);
  });

  it("reports refusals by code once every transaction settled, under the default queue bound", async () => {
    const result = await concurrentTenantProbe(createScopedDatabase(loadPool), targets());
    expect(result.ok).toBe(false);
    expect(Object.keys(result.detail.rejected)).toEqual(["busy"]);
    expect(result.detail.fulfilled + result.detail.rejected.busy!).toBe(200);
    expect(result.detail.failures).toEqual([`${result.detail.rejected.busy} transactions rejected with busy`]);
    // allSettled: nothing still holds or waits for a connection when the probe returns.
    expect(loadPool.waitingCount).toBe(0);
  });

  it("fails when a tenant sees a contact count it should not", async () => {
    const [a, b] = targets();
    const result = await concurrentTenantProbe(createScopedDatabase(loadPool), [{ ...a, contacts: CONTACTS + 1 }, b], { transactions: 10 });
    expect(result.ok).toBe(false);
    expect(result.detail.failures).toEqual(["5 transactions saw another tenant's setting or rows"]);
  });
});

/**
 * What a transaction pooler does with a backend whose client closed the connection while a
 * statement ran there. In every case it waits the statement out and rolls back; then
 * "reuse" hands the backend on unreset, after holdMs, ahead of every other free backend;
 * "reset" runs DISCARD ALL and hands it on at once; "destroy" ends it and opens a new one.
 */
type AbandonPolicy = { kind: "reuse"; holdMs: number } | { kind: "reset" } | { kind: "destroy" };

/**
 * A transaction pooler over real Postgres backends, shared by a scoped database (through
 * `asPool`, one checkout per transaction) and a plain observer (`query`, one statement per
 * checkout, nothing cleaned). Free backends are handed out last-returned first.
 */
class SimulatedPooler {
  private readonly backends = new Set<Client>();
  private readonly free: Client[] = [];
  private readonly waiting: ((backend: Client) => void)[] = [];
  private readonly settling = new Set<Promise<void>>();

  constructor(private readonly url: string, private readonly size: number, private readonly policy: AbandonPolicy) {}

  private async open(): Promise<Client> {
    const backend = new Client({ connectionString: this.url });
    backend.on("error", () => undefined);
    this.backends.add(backend);
    await backend.connect();
    return backend;
  }

  private acquire(): Promise<Client> {
    const backend = this.free.pop();
    if (backend) return Promise.resolve(backend);
    if (this.backends.size < this.size) return this.open();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private giveBack(backend: Client) {
    const next = this.waiting.shift();
    if (next) next(backend);
    else this.free.push(backend);
  }

  private abandon(backend: Client, running: Promise<unknown>) {
    const settle = (async () => {
      await running;
      await backend.query("ROLLBACK").catch(() => undefined);
      if (this.policy.kind === "destroy") {
        this.backends.delete(backend);
        await backend.end().catch(() => undefined);
        const next = this.waiting.shift();
        if (next) next(await this.open());
        return;
      }
      if (this.policy.kind === "reset") await backend.query("DISCARD ALL");
      else await delay(this.policy.holdMs);
      this.giveBack(backend);
    })();
    this.settling.add(settle);
    void settle.finally(() => this.settling.delete(settle));
  }

  /** The pg Pool surface createScopedDatabase uses. release(true) is the client closing its connection. */
  asPool(): Pool {
    const pooler = this;
    return {
      get idleCount() { return pooler.free.length; },
      get totalCount() { return pooler.backends.size; },
      get waitingCount() { return pooler.waiting.length; },
      options: { max: pooler.size },
      async connect() {
        const backend = await pooler.acquire();
        let running: Promise<unknown> = Promise.resolve();
        return {
          query: (...args: unknown[]) => {
            const result = (backend.query as (...a: unknown[]) => Promise<unknown>).apply(backend, args);
            running = result.catch(() => undefined);
            return result;
          },
          release: (discard?: boolean | Error) => (discard ? pooler.abandon(backend, running) : pooler.giveBack(backend)),
        };
      },
    } as unknown as Pool;
  }

  readonly query = (async (sql: string, values?: unknown[]) => {
    const backend = await this.acquire();
    try {
      return await backend.query(sql, values);
    } finally {
      this.giveBack(backend);
    }
  }) as unknown as Pool["query"];

  async end() {
    while (this.settling.size > 0) await Promise.all(this.settling);
    await Promise.all([...this.backends].map((backend) => backend.end().catch(() => undefined)));
  }
}

describe("hosted abandoned-transaction probe", () => {
  const quick = { rounds: 2, abandonedPerRound: 2, readsPerRound: 3, sleepMs: 400, abandonAfterMs: 50, settleMs: 3000 };
  const url = () => database.runtimePool.options.connectionString!;
  const withPooler = async (size: number, policy: AbandonPolicy, run: (pooler: SimulatedPooler) => Promise<void>) => {
    const pooler = new SimulatedPooler(url(), size, policy);
    try {
      await run(pooler);
    } finally {
      await pooler.end();
    }
  };

  it("is inconclusive on direct Postgres, which ends each abandoned backend, so no backend is reused", async () => {
    let reported = 0;
    const observer = new Pool({ connectionString: url(), max: 1 });
    try {
      const result = await abandonedTransactionProbe(createScopedDatabase(pool, { onResetFailure: () => { reported += 1; } }), observer, fixture.b.tenantId, quick);
      expect(result.detail).toMatchObject({
        abandoned: 4, outcomes: { aborted: 4 }, reads: 6, applied: { advisory: 4, prepared: 4, custom: 4 },
        contaminated: { readers: { custom: 0, advisory: 0, prepared: 0 }, observer: { custom: 0, advisory: 0, prepared: 0 } }, lockedBy: [],
      });
      expect(result.detail.backends.abandoned).toHaveLength(4);
      // A closed connection's backend exits, so neither readers nor observer can run on it.
      expect(result.detail.reused).toBe(0);
      expect(result.detail.failures).toEqual(["no reader or observer poll ran on a backend abandoned before it"]);
      expect(result.status).toBe("inconclusive");
      expect(result.ok).toBe(false);
      // Every abandonment after the work began is reported as an uncleaned backend.
      expect(reported).toBe(4);
      expect(abandonGate(result, "transaction")).toEqual({ ok: false, verdict: expect.stringMatching(/^inconclusive: .*--abandon-rounds=N above 2, or switch the runtime DATABASE_URL to session mode/) });
      expect(abandonGate(result, "session").ok).toBe(true);
    } finally {
      await observer.end();
    }
  });

  it("is contaminated when a pooler hands an abandoned backend on without a reset", async () => {
    await withPooler(1, { kind: "reuse", holdMs: 0 }, async (pooler) => {
      const result = await abandonedTransactionProbe(createScopedDatabase(pooler.asPool()), pooler, fixture.b.tenantId, { ...quick, settleMs: 200 });
      expect(result.status).toBe("contaminated");
      expect(result.ok).toBe(false);
      expect(result.detail.abandoned).toBe(4);
      expect(result.detail.backends.abandoned).toHaveLength(1);
      expect(result.detail.reusedBy).toEqual({ readers: 6, observer: result.detail.observations });
      // ROLLBACK undoes the session setting, but neither the session advisory lock nor PREPARE.
      // The first reader of each round finds both; its scoped cleanup clears them for the rest.
      expect(result.detail.contaminated.readers).toEqual({ custom: 0, advisory: 2, prepared: 2 });
      expect(result.detail.failures).toContain("2 reads saw leftover advisory state");
      expect(abandonGate(result, "session")).toMatchObject({ ok: false, verdict: expect.stringMatching(/^contaminated: /) });
    });
  });

  it("is contaminated when only the observer is handed the dirty backend, and leaves it dirty", async () => {
    // Readers run while the abandoned backend is held back; the observer gets it afterwards.
    await withPooler(4, { kind: "reuse", holdMs: 1000 }, async (pooler) => {
      const result = await abandonedTransactionProbe(createScopedDatabase(pooler.asPool()), pooler, fixture.b.tenantId,
        { ...quick, rounds: 1, abandonedPerRound: 1, settleMs: 2500 });
      expect(result.detail.abandoned).toBe(1);
      expect(result.detail.reusedBy.readers).toBe(0);
      expect(result.detail.contaminated.readers).toEqual({ custom: 0, advisory: 0, prepared: 0 });
      expect(result.detail.reusedBy.observer).toBeGreaterThan(0);
      expect(result.detail.contaminated.observer.advisory).toBeGreaterThan(0);
      expect(result.detail.contaminated.observer.prepared).toBeGreaterThan(0);
      // Observer polls never clean: the lock is still there when the settle time runs out.
      expect(result.detail.lockedBy).toEqual(result.detail.backends.abandoned);
      expect(result.status).toBe("contaminated");
      expect(result.ok).toBe(false);
    });
  });

  it("is clean when a pooler resets each abandoned backend and readers reuse it", async () => {
    await withPooler(2, { kind: "reset" }, async (pooler) => {
      const result = await abandonedTransactionProbe(createScopedDatabase(pooler.asPool()), pooler, fixture.b.tenantId, quick);
      expect(result.detail).toMatchObject({
        abandoned: 4, contaminated: { readers: { custom: 0, advisory: 0, prepared: 0 }, observer: { custom: 0, advisory: 0, prepared: 0 } },
        lockedBy: [], failures: [],
      });
      expect(result.detail.reusedBy.readers).toBeGreaterThan(0);
      expect(result.status).toBe("clean");
      expect(result.ok).toBe(true);
      expect(abandonGate(result, "transaction")).toMatchObject({ ok: true, verdict: expect.stringMatching(/^clean: /) });
    });
  });

  it("is inconclusive when a pooler destroys each abandoned backend", async () => {
    await withPooler(2, { kind: "destroy" }, async (pooler) => {
      const result = await abandonedTransactionProbe(createScopedDatabase(pooler.asPool()), pooler, fixture.b.tenantId, quick);
      expect(result.detail.reused).toBe(0);
      expect(result.detail.failures).toEqual(["no reader or observer poll ran on a backend abandoned before it"]);
      expect(result.status).toBe("inconclusive");
    });
  });

  it("fails the gate in both modes when the probe did not run as planned", () => {
    const probe = { status: "inconclusive" as const, detail: { rounds: 10, reused: 0, failures: ["no transaction was abandoned in flight", "no reader or observer poll ran on a backend abandoned before it"] } };
    expect(abandonGate(probe, "transaction")).toMatchObject({ ok: false, verdict: expect.stringContaining("fix the probe run and rerun, or switch") });
    expect(abandonGate(probe, "session")).toMatchObject({ ok: false, verdict: expect.stringContaining("fix the probe run and rerun") });
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

  it("reads the expected transport and abandon rounds from the flags, defaulting to transaction mode", () => {
    expect(hostedCheckArgs([])).toEqual({ transport: "transaction" });
    expect(hostedCheckArgs(["--", "--expect-transport=session"])).toEqual({ transport: "session" });
    expect(hostedCheckArgs(["--abandon-rounds=40"])).toEqual({ transport: "transaction", abandonRounds: 40 });
    expect(() => hostedCheckArgs(["--expect-transport=direct"])).toThrow(/unsupported transport "direct"/);
    expect(() => hostedCheckArgs(["--abandon-rounds=0"])).toThrow(/unsupported abandon rounds "0"/);
    expect(() => hostedCheckArgs(["--abandon-rounds=1.5"])).toThrow(/unsupported abandon rounds/);
    expect(() => hostedCheckArgs(["--abandon-rounds=201"])).toThrow(/unsupported abandon rounds/);
    expect(() => hostedCheckArgs(["--transport=session"])).toThrow(/unknown argument/);
  });
});
