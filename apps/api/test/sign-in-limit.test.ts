// hub-launch L9: the dashboard's sign-in link limits live in the shared Postgres limiter, so they hold across
// dashboard and API instances. Two apps on separate pools stand in for two function instances. Admission is one
// atomic take over the address and global buckets; there is no per-email bucket. A test that spends the global
// bucket or the shared "direct" key runs on a database of its own, so no test depends on another's counts.
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_ADMIT_PATH, SIGN_IN_DEFAULT_LIMITS } from "@zs/contracts";
import { createScopedDatabase } from "@zs/db";
import { createPostgresRateLimiter, type App } from "../src/app.js";
import { appOnDatabase, call, clock, createApiHarness, SIGN_IN_LIMITER_SECRET, type ApiHarness } from "./helpers.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LIMITS = { perAddress: 3, global: 1000 };

const harnesses: ApiHarness[] = [];
const pools: Pool[] = [];
/** A database of its own, for a test whose counts nothing else may touch. */
async function ownDatabase(): Promise<ApiHarness> {
  const harness = await createApiHarness();
  harnesses.push(harness);
  return harness;
}
/** Another API instance: its own pool, one database, the shared limiter. */
function instance(harness: ApiHarness, secrets?: { current: string; previous?: string }): App {
  const pool = new Pool({ connectionString: harness.database.runtimePool.options.connectionString, max: 5 });
  pool.on("error", () => undefined);
  pools.push(pool);
  return appOnDatabase(createScopedDatabase(pool), { signInLimit: secrets === undefined ? {} : { secrets } });
}
let h: ApiHarness;
beforeAll(async () => {
  h = await ownDatabase();
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(harnesses.map((harness) => harness.close()));
});

const auth = { Authorization: `Bearer ${SIGN_IN_LIMITER_SECRET}` };
const admit = (app: App, ip: string, limits: { perAddress: number; global: number } = LIMITS, headers: Record<string, string> = auth) =>
  call(app, "POST", SIGN_IN_ADMIT_PATH, { headers, body: { address: ip, perAddress: limits.perAddress, global: limits.global } });
const statuses = async (app: App, ips: string[], limits = LIMITS) => {
  const out: number[] = [];
  for (const ip of ips) out.push((await admit(app, ip, limits)).status);
  return out;
};

describe("sign-in admission (shared limiter)", () => {
  it("holds the global limit across addresses and instances, and a refused request charges no address", async () => {
    const own = await ownDatabase();
    const [first, second] = [instance(own), instance(own)];
    const limits = { perAddress: 50, global: 4 };
    const outcomes: number[] = [];
    for (let i = 0; i < 8; i++) outcomes.push((await admit(i % 2 ? second : first, `192.0.2.${100 + i}`, limits)).status);
    expect(outcomes).toEqual([204, 204, 204, 204, 429, 429, 429, 429]);
    // Refused at the global bucket, so 192.0.2.104 kept its own budget: with room in the global bucket it passes.
    expect((await admit(first, "192.0.2.104", { ...limits, global: 1000 })).status).toBe(204);
  });

  it("holds the per-address limit across two instances, then answers 429 with Retry-After", async () => {
    const [first, second] = [instance(h), instance(h)];
    const ip = `203.0.113.${(Math.floor(Math.random() * 200)) + 1}`;
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push((await admit(i % 2 ? second : first, ip)).status);
    expect(seen).toEqual([204, 204, 204, 429, 429]);
    const limited = await admit(first, ip);
    expect(limited.body).toMatchObject({ error: { code: "RateLimited" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    // Another address is untouched.
    expect((await admit(second, "198.51.100.77")).status).toBe(204);
  });

  it("takes both buckets in one atomic call: concurrent requests from two instances never pass the limit", async () => {
    const [first, second] = [instance(h), instance(h)];
    const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admit(i % 2 ? second : first, ip, { perAddress: 4, global: 1000 })));
    expect(results.filter((result) => result.status === 204)).toHaveLength(4);
    expect(results.filter((result) => result.status === 429)).toHaveLength(8);
  });

  it("puts the defaults the dashboard used before the move in the contract (no per-email limit)", () => {
    expect(SIGN_IN_DEFAULT_LIMITS).toEqual({ perAddress: 5, global: 30 });
  });

  it("never keys a bucket on the raw address, and has no email bucket at all", async () => {
    const app = instance(h);
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    expect((await admit(app, ip)).status).toBe(204);
    const stored = (await h.fixture.service(async (tx) => (await tx.query<{ key: string }>("SELECT encode(key, 'hex') AS key FROM rate_limit_buckets")).rows)).map((row) => row.key);
    expect(stored).toContain(sha(`sign-in-address:${ip}`));
    expect(stored).toContain(sha("sign-in-global"));
    expect(stored).not.toContain(sha(ip));
    // The old email-scope body is refused outright (strict body), so nothing can charge an email bucket.
    const old = await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: { scope: "email", emailHash: sha("a@example.com"), perEmail: 1 } });
    expect(old.status).toBe(400);
  });

  it("buckets an IPv6 caller by its /64", async () => {
    const app = instance(h);
    const run = Math.floor(Math.random() * 60000).toString(16);
    expect(await statuses(app, [0, 1, 2, 3].map((i) => `2001:db8:${run}:1::${i + 1}`))).toEqual([204, 204, 204, 429]);
  });

  it("puts 'direct', text that is not an address and an oversize value in one shared bucket", async () => {
    const own = await ownDatabase();
    const app = instance(own);
    // All five are the same caller key, so a limit of 3 stops the fourth whichever spelling it uses.
    const spellings = ["direct", "not an ip", "999.1.1.1", "x".repeat(65), "9".repeat(300)];
    expect(await statuses(app, spellings)).toEqual([204, 204, 204, 429, 429]);
    // A real address is a different bucket.
    expect((await admit(app, "192.0.2.77", LIMITS)).status).toBe(204);
  });
});

describe("sign-in admission credentials", () => {
  const body = { address: "192.0.2.1", perAddress: 1, global: 1000 };

  it("refuses a missing or wrong secret and malformed bodies with no-store, and does not charge for them", async () => {
    const own = await ownDatabase();
    const app = instance(own);
    const fresh = { address: `192.0.2.${Math.floor(Math.random() * 200) + 20}`, perAddress: 1, global: 1000 };
    const none = await call(app, "POST", SIGN_IN_ADMIT_PATH, { body: fresh });
    expect(none.status).toBe(401);
    expect(none.headers.get("cache-control")).toBe("no-store");
    const wrong = await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: { Authorization: `Bearer ${"x".repeat(40)}` }, body: fresh });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("cache-control")).toBe("no-store");
    for (const bad of [{}, { address: "", perAddress: 0, global: 1 }, { address: "a".repeat(513), perAddress: 1, global: 1 }, { ...fresh, extra: true }]) {
      const response = await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: bad });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    // Bad JSON and a wrong content type are 400 and no-store as well.
    const garbled = await app.request(SIGN_IN_ADMIT_PATH, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{" });
    expect(garbled.status).toBe(400);
    expect(garbled.headers.get("cache-control")).toBe("no-store");
    const text = await app.request(SIGN_IN_ADMIT_PATH, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify(fresh) });
    expect(text.status).toBe(400);
    expect(text.headers.get("cache-control")).toBe("no-store");
    const big = await app.request(SIGN_IN_ADMIT_PATH, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ ...fresh, pad: "p".repeat(2000) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get("cache-control")).toBe("no-store");
    // The refused calls above spent nothing: the one allowed take still passes, and the next is limited.
    expect((await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: fresh })).status).toBe(204);
    const limited = await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: fresh });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("accepts the previous secret during a rotation, and only while the API is configured with it", async () => {
    const own = await ownDatabase();
    const previous = ["sign-in", "previous", "p".repeat(32)].join("-");
    const rotating = instance(own, { current: SIGN_IN_LIMITER_SECRET, previous });
    const plain = instance(own);
    const bearer = (secret: string) => ({ Authorization: `Bearer ${secret}` });
    const open = { perAddress: 1000, global: 1000 };
    expect((await admit(rotating, "192.0.2.31", open, bearer(SIGN_IN_LIMITER_SECRET))).status).toBe(204);
    expect((await admit(rotating, "192.0.2.32", open, bearer(previous))).status).toBe(204);
    expect((await admit(rotating, "192.0.2.33", open, bearer("z".repeat(48)))).status).toBe(401);
    // Once the rotation is over, the old value stops working.
    expect((await admit(plain, "192.0.2.34", open, bearer(previous))).status).toBe(401);
    expect((await admit(plain, "192.0.2.35", open, bearer(SIGN_IN_LIMITER_SECRET))).status).toBe(204);
  });

  it("is off (404) without SIGN_IN_LIMITER_SECRET", async () => {
    const off = appOnDatabase(h.database.db, {});
    expect((await call(off, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body })).status).toBe(404);
  });

  it("fails closed: a retryable 503 when the store cannot answer", async () => {
    const lockTimeout = createPostgresRateLimiter(createScopedDatabase(h.database.runtimePool, { lockTimeoutMs: 200 }), clock);
    const app = appOnDatabase(h.database.db, { signInLimit: { limiter: lockTimeout } });
    const holder = await h.database.pool.connect();
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE rate_limit_buckets IN EXCLUSIVE MODE");
      const response = await admit(app, ip);
      expect(response).toMatchObject({ status: 503, body: { error: { code: "Unavailable" } } });
      expect(response.headers.get("retry-after")).toBe("1");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await admit(app, ip)).status).toBe(204);
  });
});
