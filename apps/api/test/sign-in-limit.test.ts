// hub-launch L9: the dashboard's sign-in link limits live in the shared Postgres limiter, so they hold across
// dashboard and API instances. Two apps on separate pools stand in for two function instances.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGN_IN_ADMIT_PATH, SIGN_IN_DEFAULT_LIMITS } from "@zs/contracts";
import { createScopedDatabase } from "@zs/db";
import { createPostgresRateLimiter, type App } from "../src/app.js";
import { appOnDatabase, call, clock, createApiHarness, SIGN_IN_LIMITER_SECRET, type ApiHarness } from "./helpers.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LIMITS = { perAddress: 3, global: 1000, perEmail: 2 };

let h: ApiHarness;
const pools: Pool[] = [];
/** Another API instance: its own pool, one database, the shared limiter. */
function instance(): App {
  const pool = new Pool({ connectionString: h.database.runtimePool.options.connectionString, max: 5 });
  pool.on("error", () => undefined);
  pools.push(pool);
  return appOnDatabase(createScopedDatabase(pool), { signInLimit: {} });
}
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await h.close();
});

const auth = { Authorization: `Bearer ${SIGN_IN_LIMITER_SECRET}` };
const address = (app: App, ip: string, limits = LIMITS) =>
  call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: { scope: "address", address: ip, perAddress: limits.perAddress, global: limits.global } });
const email = (app: App, emailHash: string, perEmail = LIMITS.perEmail) =>
  call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: { scope: "email", emailHash, perEmail } });

describe("sign-in admission (shared limiter)", () => {
  it("holds the global limit across addresses and instances, and a refused request charges no address", async () => {
    // First in the file: the global bucket is shared, and the later tests allow far more than they spend.
    const [first, second] = [instance(), instance()];
    const limits = { perAddress: 50, global: 4, perEmail: 5 };
    const outcomes: number[] = [];
    for (let i = 0; i < 8; i++) outcomes.push((await address(i % 2 ? second : first, `192.0.2.${100 + i}`, limits)).status);
    expect(outcomes).toEqual([204, 204, 204, 204, 429, 429, 429, 429]);
    // Refused at the global bucket, so 192.0.2.104 kept its own budget.
    expect((await address(first, "192.0.2.104", { ...limits, global: 1000 })).status).toBe(204);
  });

  it("holds the per-address limit across two instances, then answers 429 with Retry-After", async () => {
    const [first, second] = [instance(), instance()];
    const ip = `203.0.113.${(Math.floor(Math.random() * 200)) + 1}`;
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await address(i % 2 ? second : first, ip)).status);
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    const limited = await address(first, ip);
    expect(limited.body).toMatchObject({ error: { code: "RateLimited" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    // Another address is untouched.
    expect((await address(second, "198.51.100.77")).status).toBe(204);
  });

  it("holds the per-email limit across two instances and never keys a bucket on the raw email", async () => {
    const [first, second] = [instance(), instance()];
    const raw = `${randomUUID()}@example.com`;
    const hash = sha(raw);
    expect([(await email(first, hash)).status, (await email(second, hash)).status, (await email(first, hash)).status, (await email(second, hash)).status])
      .toEqual([204, 204, 429, 429]);
    const stored = (await h.fixture.service(async (tx) => (await tx.query<{ key: string }>("SELECT encode(key, 'hex') AS key FROM rate_limit_buckets")).rows)).map((row) => row.key);
    expect(stored).toContain(sha(`sign-in-email:${hash}`));
    expect(stored).not.toContain(sha(raw));
    expect(stored).not.toContain(sha(`sign-in-email:${raw}`));
  });

  it("puts the defaults the dashboard used before the move in the contract", () => {
    expect(SIGN_IN_DEFAULT_LIMITS).toEqual({ perAddress: 5, global: 30, perEmail: 5 });
  });

  it("buckets an IPv6 caller by its /64 and any unreadable address under one 'direct' key", async () => {
    const app = instance();
    const run = Math.floor(Math.random() * 60000).toString(16);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await address(app, `2001:db8:${run}:1::${i + 1}`)).status);
    expect(statuses).toEqual([204, 204, 204, 429]);
    const direct = [];
    for (const value of ["direct", "not an ip", "999.1.1.1"]) direct.push((await address(app, value)).status);
    for (const status of direct) expect([204, 429]).toContain(status);
  });

  it("refuses a missing or wrong secret and malformed bodies, and does not charge for them", async () => {
    const app = instance();
    const body = { scope: "email", emailHash: sha(randomUUID()), perEmail: 1 };
    expect((await call(app, "POST", SIGN_IN_ADMIT_PATH, { body })).status).toBe(401);
    expect((await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: { Authorization: `Bearer ${"x".repeat(40)}` }, body })).status).toBe(401);
    for (const bad of [{}, { scope: "email", emailHash: "owner@example.com", perEmail: 1 }, { scope: "email", emailHash: sha("a"), perEmail: 0 }, { scope: "address", address: "", perAddress: 1, global: 1 }])
      expect((await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: bad })).status).toBe(400);
    // The refused calls above spent nothing: the one allowed take still passes.
    expect((await call(app, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body })).status).toBe(204);
  });

  it("is off (404) without SIGN_IN_LIMITER_SECRET", async () => {
    const off = appOnDatabase(h.database.db, {});
    expect((await call(off, "POST", SIGN_IN_ADMIT_PATH, { headers: auth, body: { scope: "email", emailHash: sha("x"), perEmail: 1 } })).status).toBe(404);
  });

  it("fails closed: a retryable 503 when the store cannot answer", async () => {
    const lockTimeout = createPostgresRateLimiter(createScopedDatabase(h.database.runtimePool, { lockTimeoutMs: 200 }), clock);
    const app = appOnDatabase(h.database.db, { signInLimit: { limiter: lockTimeout } });
    const holder = await h.database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE rate_limit_buckets IN EXCLUSIVE MODE");
      const response = await email(app, sha(randomUUID()));
      expect(response).toMatchObject({ status: 503, body: { error: { code: "Unavailable" } } });
      expect(response.headers.get("retry-after")).toBe("1");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect((await email(app, sha(randomUUID()))).status).toBe(204);
  });
});
