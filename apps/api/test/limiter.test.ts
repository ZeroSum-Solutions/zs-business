import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScopedDatabase, DatabaseUnavailable, type ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createMemoryRateLimiter, type RateLimiter, type RateLimit } from "../src/public/limiter.js";
import { createPostgresRateLimiter } from "../src/public/postgres-limiter.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
/** Pools of separate API instances: each its own connections, one database. */
const pools: Pool[] = [];
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await database?.close();
});

/** Another API instance on the same database, with its own runtime pool. */
function instance(): ScopedDatabase {
  const pool = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 10 });
  // A test terminates one of these backends; the pool reports it and replaces the client.
  pool.on("error", () => undefined);
  pools.push(pool);
  return createScopedDatabase(pool);
}
const bucketCount = () => fixture.service(async (tx) =>
  Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM rate_limit_buckets")).rows[0]!.n));

describe.each([
  ["in memory", (clock: { now(): Date }) => createMemoryRateLimiter(clock)],
  ["in Postgres", (clock: { now(): Date }) => createPostgresRateLimiter(database.db, clock)],
] as const)("rate limiter %s (public-intake.md P-10)", (_, create) => {
  it("charges every bucket or none, and reopens after the window", async () => {
    // Buckets in the shared database outlive one test: name them per run.
    const run = randomUUID();
    const k = (name: string) => `${run}:${name}`;
    let now = Date.parse("2026-10-19T08:00:00.000Z");
    const limiter = create({ now: () => new Date(now) });
    const small = { limit: 1, windowMs: 1000 };
    const large = { limit: 5, windowMs: 10_000 };
    expect(await limiter.take([{ key: k("a"), rule: small }, { key: k("t"), rule: large }])).toEqual({ ok: true });
    now += 400;
    expect(await limiter.take([{ key: k("a"), rule: small }, { key: k("t"), rule: large }])).toEqual({ ok: false, retryAfterSeconds: 1 });
    // The refusal did not charge "t": four more fit.
    for (let i = 0; i < 4; i++) expect((await limiter.take([{ key: k(`b${i}`), rule: small }, { key: k("t"), rule: large }])).ok).toBe(true);
    expect(await limiter.take([{ key: k("c"), rule: small }, { key: k("t"), rule: large }])).toEqual({ ok: false, retryAfterSeconds: 10 });
    // "c" was refused, so it was not charged either.
    expect((await limiter.take([{ key: k("c"), rule: small }])).ok).toBe(true);
    now += 600;
    expect((await limiter.take([{ key: k("a"), rule: small }])).ok).toBe(true);
    // Retry-After rounds up to whole seconds and names the bucket that reopens last.
    now += 1;
    expect(await limiter.take([{ key: k("a"), rule: small }])).toEqual({ ok: false, retryAfterSeconds: 1 });
    now = Date.parse("2026-10-19T08:00:10.000Z");
    expect((await limiter.take([{ key: k("t"), rule: large }])).ok).toBe(true);
  });
});

describe("shared Postgres limiter", () => {
  const NOW = Date.parse("2026-10-19T08:00:00.000Z");
  const at = (ms: number) => ({ now: () => new Date(NOW + ms) });
  const rule = (limit: number, windowMs = 600_000): RateLimit => ({ limit, windowMs });

  it("counts once across two API instances on one database", async () => {
    const key = `address-write:${randomUUID()}`;
    const first = createPostgresRateLimiter(instance(), at(0));
    const second = createPostgresRateLimiter(instance(), at(1000));
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push((await (i % 2 ? second : first).take([{ key, rule: rule(4) }])).ok);
    expect(outcomes).toEqual([true, true, true, true, false, false]);
    expect(await second.take([{ key, rule: rule(4) }])).toEqual({ ok: false, retryAfterSeconds: 599 });
  });

  it("never grants more than the limit to concurrent requests on several instances", async () => {
    const key = `tenant-write:${randomUUID()}`;
    const limiters: RateLimiter[] = [instance(), instance(), database.db].map((db) => createPostgresRateLimiter(db, at(0)));
    const results = await Promise.all(Array.from({ length: 45 }, (_, i) => limiters[i % 3]!.take([{ key, rule: rule(7) }])));
    expect(results.filter((result) => result.ok)).toHaveLength(7);
  });

  it("charges all of a request's buckets or none under concurrency, without deadlocks", async () => {
    const run = randomUUID();
    const tenant = `tenant-write:${run}`;
    const limiters = [instance(), instance()].map((db) => createPostgresRateLimiter(db, at(0)));
    // Each request names its own address and the shared tenant; half list them in the other order.
    const charges = (i: number) => {
      const both = [{ key: `address-write:${run}:${i}`, rule: rule(1) }, { key: tenant, rule: rule(10) }];
      return i % 2 ? both.reverse() : both;
    };
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => limiters[i % 2]!.take(charges(i))));
    const granted = results.flatMap((result, i) => (result.ok ? [i] : []));
    expect(granted).toHaveLength(10);
    // A refused request charged nothing: its address still has its one write.
    const refused = results.flatMap((result, i) => (result.ok ? [] : [i]));
    for (const i of refused)
      expect((await limiters[0]!.take([{ key: `address-write:${run}:${i}`, rule: rule(1) }])).ok).toBe(true);
    for (const i of granted)
      expect((await limiters[0]!.take([{ key: `address-write:${run}:${i}`, rule: rule(1) }])).ok).toBe(false);
  });

  it("keeps one tenant's spent budget from limiting another tenant", async () => {
    const limiter = createPostgresRateLimiter(database.db, at(0));
    const spend = (tenantId: string) => limiter.take([{ key: `tenant-write:${tenantId}`, rule: rule(2, 3_600_000) }]);
    expect((await spend(fixture.a.tenantId)).ok).toBe(true);
    expect((await spend(fixture.a.tenantId)).ok).toBe(true);
    expect((await spend(fixture.a.tenantId)).ok).toBe(false);
    expect((await spend(fixture.b.tenantId)).ok).toBe(true);
  });

  it("stores a hash of each bucket name, never the client address", async () => {
    const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}:${randomUUID()}`;
    await createPostgresRateLimiter(database.db, at(0)).take([{ key: `address-read:${address}`, rule: rule(5) }]);
    const digest = createHash("sha256").update(`address-read:${address}`).digest();
    const rows = await fixture.service(async (tx) => (await tx.query<{ count: number }>(
      "SELECT count FROM rate_limit_buckets WHERE key=$1", [digest])).rows);
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("gives the runtime role no direct access to the buckets", async () => {
    for (const statement of [
      "SELECT * FROM rate_limit_buckets",
      "INSERT INTO rate_limit_buckets (key,window_start,expires_at,count) VALUES (sha256('x'),now(),now(),0)",
      "UPDATE rate_limit_buckets SET count=0",
      "DELETE FROM rate_limit_buckets",
    ]) {
      await expect(fixture.a.run((tx) => tx.query(statement)), statement).rejects.toMatchObject({ code: "42501" });
      await expect(database.db.withoutTenant((tx) => tx.query(statement)), statement).rejects.toMatchObject({ code: "42501" });
    }
    // The runtime reaches them only through the function, which runs as zs_rate_limiter.
    const definer = await fixture.service(async (tx) => (await tx.query<{ owner: string; definer: boolean }>(
      `SELECT proowner::regrole::text AS owner, prosecdef AS definer FROM pg_proc
        WHERE oid='public.rate_limit_take(timestamptz,jsonb)'::regprocedure`)).rows[0]);
    expect(definer).toEqual({ owner: "zs_rate_limiter", definer: true });
  });

  // pg_graphql and PostgREST run a signed-in member's request as the authenticator login with
  // SET ROLE authenticated and the JWT claims set; neither may charge or sweep buckets.
  it("refuses callers other than the API runtime login, such as a Supabase JWT request", async () => {
    const login = `zs_test_authenticator_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await database.pool.query(`CREATE ROLE ${login} LOGIN NOINHERIT; GRANT authenticated, service_role TO ${login}`);
    const url = new URL(database.url);
    url.username = login;
    const authenticator = new Pool({ connectionString: url.href, max: 1 });
    const call = `SELECT public.rate_limit_take($1, $2::jsonb)`;
    const params = [new Date(NOW + 1e12).toISOString(), JSON.stringify([{ key: "b".repeat(64), limit: 1, windowMs: 1000 }])];
    try {
      for (const claims of ['{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', ""]) {
        const client = await authenticator.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('role','authenticated',true), set_config('request.jwt.claims',$1,true)", [claims]);
          await expect(client.query(call, params), claims || "no claims").rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      }
    } finally {
      await authenticator.end();
      await database.pool.query(`DROP ROLE ${login}`);
    }
    // The runtime login itself is refused too while a request's JWT claims are set.
    for (const setting of ["request.jwt.claims", "request.jwt.claim.sub"])
      await expect(database.db.withoutTenant(async (tx) => {
        await tx.query("SELECT set_config($1, 'x', true)", [setting]);
        return tx.query(call, params);
      }), setting).rejects.toMatchObject({ code: "42501" });
    // Nothing was charged or swept by the refused calls.
    expect((await createPostgresRateLimiter(database.db, at(0)).take([{ key: `refused:${randomUUID()}`, rule: rule(1) }])).ok).toBe(true);
  });

  it("answers a lock wait past its timeout, and a lost connection, as an unavailable store", async () => {
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE rate_limit_buckets IN EXCLUSIVE MODE");
      const impatient = createPostgresRateLimiter(createScopedDatabase(database.runtimePool, { lockTimeoutMs: 200 }), at(0));
      // Well inside the request deadline: the lock timeout, not the deadline, ends the wait.
      const started = performance.now();
      await expect(impatient.take([{ key: randomUUID(), rule: rule(1) }], { remainingMs: () => 10_000 }))
        .rejects.toMatchObject({ name: "DatabaseUnavailable", reason: "busy", cause: { code: "55P03" } });
      expect(performance.now() - started).toBeLessThan(5000);

      const waiting = createPostgresRateLimiter(instance(), at(0)).take([{ key: randomUUID(), rule: rule(1) }]);
      let pid: number | undefined;
      for (let i = 0; i < 100 && pid === undefined; i++) {
        pid = (await database.pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE '%rate_limit%' LIMIT 1`)).rows[0]?.pid;
        if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pid).toBeDefined();
      await database.pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await expect(waiting).rejects.toMatchObject({ name: "DatabaseUnavailable", reason: "connect" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("answers a backend lost between the transaction's statements as an unavailable store", async () => {
    const runtime = instance();
    // Kills its own backend after the transaction setup, before the limiter's statement.
    const dropping: ScopedDatabase = {
      ...runtime,
      withoutTenant: (work, options) => runtime.withoutTenant(async (tx) => {
        const { rows } = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await database.pool.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return work(tx);
      }, options),
    };
    await expect(createPostgresRateLimiter(dropping, at(0)).take([{ key: randomUUID(), rule: rule(1) }]))
      .rejects.toMatchObject({ name: "DatabaseUnavailable", reason: "connect" });
  });

  it("refuses malformed charges", async () => {
    const take = (charges: unknown) => database.db.withoutTenant((tx) =>
      tx.query("SELECT public.rate_limit_take($1,$2::jsonb)", [new Date(NOW).toISOString(), JSON.stringify(charges)]));
    const key = "a".repeat(64);
    for (const charges of [
      [],
      {},
      Array.from({ length: 9 }, (_, i) => ({ key: String(i).repeat(64), limit: 1, windowMs: 1000 })),
      [{ key: "A".repeat(64), limit: 1, windowMs: 1000 }],
      [{ key: "a".repeat(63), limit: 1, windowMs: 1000 }],
      [{ key, limit: 0, windowMs: 1000 }],
      [{ key, limit: 1.5, windowMs: 1000 }],
      [{ key, limit: "1", windowMs: 1000 }],
      [{ key, limit: 1e20, windowMs: 1000 }],
      [{ key, limit: 1, windowMs: 86_400_001 }],
      [{ key, limit: 1, windowMs: 1000 }, { key, limit: 2, windowMs: 1000 }],
    ]) await expect(take(charges), JSON.stringify(charges).slice(0, 80)).rejects.toMatchObject({ code: "22023" });
  });

  it("runs within the request's deadline", async () => {
    const limiter = createPostgresRateLimiter(database.db, at(0));
    await expect(limiter.take([{ key: randomUUID(), rule: rule(1) }], { signal: AbortSignal.abort() }))
      .rejects.toBeInstanceOf(DatabaseUnavailable);
    await expect(limiter.take([{ key: randomUUID(), rule: rule(1) }], { remainingMs: () => 0 }))
      .rejects.toBeInstanceOf(DatabaseUnavailable);
  });

  it("sweeps expired buckets a bounded number at a time", async () => {
    // Runs last: at a later time every bucket the tests above made has expired too.
    const later = Date.parse("2026-10-21T00:00:00.000Z");
    const filler = createPostgresRateLimiter(database.db, { now: () => new Date(later) });
    for (let i = 0; i < 40; i++) await filler.take([{ key: `sweep:${i}`, rule: { limit: 1, windowMs: 1000 } }, { key: `sweep:${i}:b`, rule: { limit: 1, windowMs: 1000 } }]);
    const before = await bucketCount();
    expect(before).toBeGreaterThanOrEqual(80);
    const limiter = createPostgresRateLimiter(database.db, { now: () => new Date(later + 2000) });
    const key = `sweep:${randomUUID()}`;
    let previous = before;
    let takes = 0;
    while (previous > 1) {
      expect((await limiter.take([{ key, rule: { limit: 1000, windowMs: 60_000 } }])).ok).toBe(true);
      takes += 1;
      const current = await bucketCount();
      // At most 32 removed per take, plus at most the take's own new bucket.
      expect(current).toBeGreaterThanOrEqual(Math.max(1, previous - 32));
      expect(current).toBeLessThan(previous + 1);
      previous = current;
      expect(takes).toBeLessThanOrEqual(Math.ceil(before / 32) + 1);
    }
    // Only the live bucket is left.
    expect(await bucketCount()).toBe(1);
  });
});
