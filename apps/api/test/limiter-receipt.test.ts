// Connections C-4: the charge receipt and its refund (supabase/migrations/20261108900000_rate_limit_receipt_refund.sql).
// A receipt names the buckets and windows one charge took; the refund consumes it once, in that window only,
// and never takes a count below zero. Real local Postgres for the shared limiter, plus the in-memory twin.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScopedDatabase, type ScopedDatabase } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createMemoryRateLimiter, MAX_MEMORY_RECEIPTS, type ChargeReceipt, type RateLimit, type RateLimiter } from "../src/public/limiter.js";
import { createPostgresRateLimiter } from "../src/public/postgres-limiter.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
const pools: Pool[] = [];
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await database?.close();
});
function instance(): ScopedDatabase {
  const pool = new Pool({ connectionString: database.runtimePool.options.connectionString, max: 10 });
  pools.push(pool);
  return createScopedDatabase(pool);
}

const NOW = Date.parse("2026-11-08T08:00:00.000Z");
const rule = (limit: number, windowMs = 3_600_000): RateLimit => ({ limit, windowMs });
const countOf = (name: string) => fixture.service(async (tx) => {
  const { rows } = await tx.query<{ count: number }>("SELECT count FROM rate_limit_buckets WHERE key=$1", [createHash("sha256").update(name).digest()]);
  return rows[0]?.count;
});
const receiptRows = () => fixture.service(async (tx) =>
  Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM rate_limit_receipts")).rows[0]!.n));

/** A limiter whose clock the test moves. */
function clocked(create: (clock: { now(): Date }) => RateLimiter) {
  let now = NOW;
  const limiter = create({ now: () => new Date(now) });
  return { limiter, set: (ms: number) => { now = NOW + ms; } };
}
async function receiptOf(limiter: RateLimiter, charges: Parameters<RateLimiter["take"]>[0]): Promise<ChargeReceipt> {
  const taken = await limiter.takeWithReceipt!(charges);
  if (!taken.ok) throw new Error("expected the charge to be accepted");
  return taken.receipt;
}

describe.each([
  ["in memory", (clock: { now(): Date }) => createMemoryRateLimiter(clock)],
  ["in Postgres", (clock: { now(): Date }) => createPostgresRateLimiter(database.db, clock)],
] as const)("charge receipt and refund %s", (_, create) => {
  it("gives the charge back in its own window, and the freed unit can be charged again", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const { limiter } = clocked(create);
    const receipts = [];
    for (let i = 0; i < 3; i++) receipts.push(await receiptOf(limiter, [{ key, rule: rule(3) }]));
    expect((await limiter.take([{ key, rule: rule(3) }])).ok).toBe(false);
    expect(await limiter.refund!(receipts[1]!)).toBe(1);
    expect((await limiter.take([{ key, rule: rule(3) }])).ok).toBe(true);
    expect((await limiter.take([{ key, rule: rule(3) }])).ok).toBe(false);
  });

  it("refunds a receipt at most once", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const { limiter } = clocked(create);
    const first = await receiptOf(limiter, [{ key, rule: rule(2) }]);
    await receiptOf(limiter, [{ key, rule: rule(2) }]);
    expect(await limiter.refund!(first)).toBe(1);
    expect(await limiter.refund!(first)).toBe(0);
    expect(await limiter.refund!(first)).toBe(0);
    // One unit came back, not three: the bucket holds one charge and has room for one.
    expect((await limiter.take([{ key, rule: rule(2) }])).ok).toBe(true);
    expect((await limiter.take([{ key, rule: rule(2) }])).ok).toBe(false);
  });

  it("does nothing once the receipt's window has ended, and never touches the window that followed", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const { limiter, set } = clocked(create);
    const old = await receiptOf(limiter, [{ key, rule: rule(2, 1000) }]);
    // Window A ended; B opens with one charge.
    set(2000);
    await receiptOf(limiter, [{ key, rule: rule(2, 1000) }]);
    expect(await limiter.refund!(old)).toBe(0);
    expect((await limiter.take([{ key, rule: rule(2, 1000) }])).ok).toBe(true);
    // B is still at its limit of 2: the stale refund took nothing from it.
    expect((await limiter.take([{ key, rule: rule(2, 1000) }])).ok).toBe(false);

    // A window that ended with nobody charging after it is also left alone.
    const lone = `conn-connect:${randomUUID()}`;
    const receipt = await receiptOf(limiter, [{ key: lone, rule: rule(2, 1000) }]);
    set(5000);
    expect(await limiter.refund!(receipt)).toBe(0);
  });

  it("refunds only the buckets still in the receipt's window", async () => {
    const run = randomUUID();
    const quick = `conn-quick:${run}`;
    const slow = `conn-slow:${run}`;
    const { limiter, set } = clocked(create);
    const receipt = await receiptOf(limiter, [{ key: quick, rule: rule(1, 1000) }, { key: slow, rule: rule(1, 100_000) }]);
    set(1500);
    // quick's window ended and reopened with one charge; slow's window is the receipt's.
    await receiptOf(limiter, [{ key: quick, rule: rule(1, 1000) }]);
    expect(await limiter.refund!(receipt)).toBe(1);
    expect((await limiter.take([{ key: slow, rule: rule(1, 100_000) }])).ok).toBe(true);
    expect((await limiter.take([{ key: quick, rule: rule(1, 1000) }])).ok).toBe(false);
  });

  it("treats a refused charge as nothing: no receipt, nothing charged", async () => {
    const run = randomUUID();
    const { limiter } = clocked(create);
    await receiptOf(limiter, [{ key: `conn-a:${run}`, rule: rule(1) }]);
    const refused = await limiter.takeWithReceipt!([{ key: `conn-a:${run}`, rule: rule(1) }, { key: `conn-b:${run}`, rule: rule(5) }]);
    expect(refused.ok).toBe(false);
    expect((await limiter.take([{ key: `conn-b:${run}`, rule: rule(1) }])).ok).toBe(true);
  });

  it("does nothing for a receipt the limiter never issued", async () => {
    const { limiter } = clocked(create);
    expect(await limiter.refund!({ id: randomUUID() })).toBe(0);
    expect(await limiter.refund!({ id: "not-a-receipt" })).toBe(0);
  });
});

describe("memory limiter receipts are bounded", () => {
  it("holds at most MAX_MEMORY_RECEIPTS: the oldest is dropped, and that charge simply cannot be refunded", async () => {
    const { limiter } = clocked((clock) => createMemoryRateLimiter(clock));
    const first = await receiptOf(limiter, [{ key: "k:first", rule: rule(1_000_000) }]);
    for (let i = 0; i < MAX_MEMORY_RECEIPTS; i++) await receiptOf(limiter, [{ key: `k:${i}`, rule: rule(10) }]);
    expect(await limiter.refund!(first)).toBe(0);
    const last = await receiptOf(limiter, [{ key: "k:last", rule: rule(10) }]);
    expect(await limiter.refund!(last)).toBe(1);
  });

  it("sweeps a receipt whose window ended, and a late refund changes nothing", async () => {
    const { limiter, set } = clocked((clock) => createMemoryRateLimiter(clock));
    const old = await receiptOf(limiter, [{ key: "k:old", rule: rule(5, 1_000) }]);
    set(2_000);
    await receiptOf(limiter, [{ key: "k:new", rule: rule(5) }]);
    expect(await limiter.refund!(old)).toBe(0);
  });

  it("a refund to zero holds no window, as in the shared store: the next charge opens a fresh one", async () => {
    const { limiter, set } = clocked((clock) => createMemoryRateLimiter(clock));
    const key = "k:zero";
    const receipt = await receiptOf(limiter, [{ key, rule: rule(1, 10_000) }]);
    set(6_000);
    expect(await limiter.refund!(receipt)).toBe(1);
    expect((await limiter.take([{ key, rule: rule(1, 10_000) }])).ok).toBe(true);
    // The new window started at 6 s, so it is still full at 12 s (the old one would have ended at 10 s).
    set(12_000);
    expect((await limiter.take([{ key, rule: rule(1, 10_000) }])).ok).toBe(false);
  });

  it("an aborted signal throws before anything changes (take, takeWithReceipt, refund)", async () => {
    const { limiter } = clocked((clock) => createMemoryRateLimiter(clock));
    const key = "k:abort";
    const receipt = await receiptOf(limiter, [{ key, rule: rule(2) }]);
    const aborted = AbortSignal.abort();
    await expect(limiter.take([{ key, rule: rule(2) }], { signal: aborted })).rejects.toThrow();
    await expect(limiter.takeWithReceipt!([{ key, rule: rule(2) }], { signal: aborted })).rejects.toThrow();
    await expect(limiter.refund!(receipt, { signal: aborted })).rejects.toThrow();
    // Nothing moved: one slot is left, and the receipt is still good.
    expect((await limiter.take([{ key, rule: rule(2) }])).ok).toBe(true);
    expect((await limiter.take([{ key, rule: rule(2) }])).ok).toBe(false);
    expect(await limiter.refund!(receipt)).toBe(1);
  });
});

describe("shared Postgres limiter: receipts in the database", () => {
  const limiterOn = (db: ScopedDatabase, offset = 0) => createPostgresRateLimiter(db, { now: () => new Date(NOW + offset) });

  it("stores the bucket and window each receipt names, and plain take issues none", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const before = await receiptRows();
    await limiterOn(database.db).take([{ key, rule: rule(5) }]);
    expect(await receiptRows()).toBe(before);
    const receipt = await receiptOf(limiterOn(database.db), [{ key, rule: rule(5) }]);
    const stored = await fixture.service(async (tx) => (await tx.query<{ charges: { key: string; windowStart: string }[] }>(
      "SELECT charges FROM rate_limit_receipts WHERE id=$1", [receipt.id])).rows[0]);
    expect(stored?.charges.map((c) => ({ key: c.key, windowStart: new Date(c.windowStart).getTime() })))
      .toEqual([{ key: createHash("sha256").update(key).digest("hex"), windowStart: NOW }]);
    expect(await countOf(key)).toBe(2);
    await limiterOn(database.db).refund!(receipt);
    expect(await countOf(key)).toBe(1);
    // The refund consumed the receipt.
    expect(await receiptRows()).toBe(before);
  });

  it("never takes a count below zero", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const limiter = limiterOn(database.db);
    const receipt = await receiptOf(limiter, [{ key, rule: rule(5) }]);
    // An operator cleared the count to zero in the meantime.
    await database.pool.query("UPDATE rate_limit_buckets SET count = 0 WHERE key = $1", [createHash("sha256").update(key).digest()]);
    expect(await limiter.refund!(receipt)).toBe(0);
    expect(await countOf(key)).toBe(0);
  });

  it("a concurrent charge and refund on several instances keep the count exact", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const dbs = [instance(), instance(), database.db];
    const [a, b, c] = dbs.map((db) => limiterOn(db)) as [RateLimiter, RateLimiter, RateLimiter];
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await receiptOf(a, [{ key, rule: rule(6) }]));
    const takers = [a, b, c];
    const results = await Promise.all([
      ...held.map((receipt, i) => takers[i % 3]!.refund!(receipt)),
      ...Array.from({ length: 12 }, (_, i) => takers[i % 3]!.take([{ key, rule: rule(6) }])),
    ]);
    const refunded = results.slice(0, 4) as number[];
    const granted = (results.slice(4) as { ok: boolean }[]).filter((r) => r.ok).length;
    // Every refund found its window (the window never closed, and no receipt was spent twice).
    expect(refunded).toEqual([1, 1, 1, 1]);
    // The four held charges are gone, so the count is exactly what the new takes were granted, within the limit.
    expect(await countOf(key)).toBe(granted);
    expect(granted).toBeLessThanOrEqual(6);
    expect(granted).toBeGreaterThanOrEqual(2);
  });

  it("refunds one receipt once however many instances race to refund it", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const dbs = [instance(), instance(), database.db];
    const limiters = dbs.map((db) => limiterOn(db));
    await receiptOf(limiters[0]!, [{ key, rule: rule(10) }]);
    const target = await receiptOf(limiters[0]!, [{ key, rule: rule(10) }]);
    const gave = await Promise.all(Array.from({ length: 9 }, (_, i) => limiters[i % 3]!.refund!(target)));
    expect(gave.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(await countOf(key)).toBe(1);
  });

  it("sweeps receipts whose windows ended", async () => {
    const key = `conn-connect:${randomUUID()}`;
    const stale = await receiptOf(limiterOn(database.db), [{ key, rule: rule(5, 1000) }]);
    const filler = `conn-connect:${randomUUID()}`;
    await receiptOf(limiterOn(database.db, 10_000), [{ key: filler, rule: rule(5, 1000) }]);
    const left = await fixture.service(async (tx) => (await tx.query("SELECT 1 FROM rate_limit_receipts WHERE id=$1", [stale.id])).rowCount);
    expect(left).toBe(0);
  });

  it("gives the runtime role no direct access to receipts, and refuses a JWT request", async () => {
    for (const statement of [
      "SELECT * FROM rate_limit_receipts",
      "INSERT INTO rate_limit_receipts (id,charges,expires_at) VALUES (gen_random_uuid(),'[]',now())",
      "DELETE FROM rate_limit_receipts",
    ]) await expect(database.db.withoutTenant((tx) => tx.query(statement)), statement).rejects.toMatchObject({ code: "42501" });
    for (const fn of ["rate_limit_receipt_take(timestamptz,jsonb)", "rate_limit_refund(timestamptz,uuid)"]) {
      const row = await fixture.service(async (tx) => (await tx.query<{ owner: string; definer: boolean; path: string[] }>(
        "SELECT proowner::regrole::text AS owner, prosecdef AS definer, proconfig AS path FROM pg_proc WHERE oid=$1::regprocedure", [`public.${fn}`])).rows[0]);
      expect(row).toEqual({ owner: "zs_rate_limiter", definer: true, path: ["search_path=pg_catalog, pg_temp"] });
    }
    const calls: [string, unknown[]][] = [
      ["SELECT public.rate_limit_receipt_take($1, $2::jsonb)", [new Date(NOW).toISOString(), JSON.stringify([{ key: "b".repeat(64), limit: 1, windowMs: 1000 }])]],
      ["SELECT public.rate_limit_refund($1, $2::uuid)", [new Date(NOW).toISOString(), randomUUID()]],
    ];
    for (const [call, params] of calls) {
      for (const setting of ["request.jwt.claims", "request.jwt.claim.sub"])
        await expect(database.db.withoutTenant(async (tx) => {
          await tx.query("SELECT set_config($1, 'x', true)", [setting]);
          return tx.query(call, params);
        }), `${call} ${setting}`).rejects.toMatchObject({ code: "42501" });
      // service_role (a different login) is refused as well.
      await expect(fixture.service((tx) => tx.query(call, params)), call).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("refuses malformed charges like rate_limit_take does", async () => {
    await expect(database.db.withoutTenant((tx) => tx.query("SELECT public.rate_limit_receipt_take($1, $2::jsonb)", [new Date(NOW).toISOString(), "[]"])))
      .rejects.toMatchObject({ code: "22023" });
  });
});
