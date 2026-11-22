// The request deadline over a real database, in process: it reaches Postgres as a capped lock
// wait, and it ends a wait for a pool connection. Neither test reads the wall clock: the app's
// clock is fixed, and the Node timers are fake, so only the logic under test can end each wait.
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createScopedDatabase } from "@zs/db";
import { answeredAtDeadline, appOnDatabase, call, createApiHarness, type ApiHarness } from "./helpers.js";

const DEADLINE_MS = 1000;
// Far past any test timeout: a wait that only these limits could end hangs the test instead.
const PATIENT = { lockTimeoutMs: 600_000, statementTimeoutMs: 600_000 };
// Real Postgres I/O on a busy machine; nothing below is timed against it.
const DATABASE_TEST_MS = 120_000;

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); }, 120_000);
afterAll(async () => { await h?.close(); });

/** A service-role transaction that holds an exclusive lock on the table the request reads. */
async function lockResources(): Promise<PoolClient> {
  const holder = await h.database.pool.connect();
  onTestFinished(async () => {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  });
  await holder.query("BEGIN");
  await holder.query("LOCK TABLE booking_resources IN ACCESS EXCLUSIVE MODE");
  return holder;
}

describe("request deadline over the database", () => {
  it("caps the Postgres lock wait at the time the request has left", async () => {
    await lockResources();
    const app = appOnDatabase(createScopedDatabase(h.database.runtimePool, PATIENT), { requestTimeoutMs: DEADLINE_MS });
    // With setTimeout faked and never advanced, neither the deadline's abort nor the abandon
    // grace can fire, and the fixed clock leaves the full deadline as time left. Only the
    // lock_timeout that Postgres got (the deadline, not the patient 600 s) ends the wait.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => { vi.useRealTimers(); });
    const answered = await call(app, "GET", "/v1/booking/resources", { token: h.a.token });
    vi.useRealTimers();
    expect(answered.status, JSON.stringify(answered.body)).toBe(503);
    expect(answered.headers.get("retry-after")).toBe("1");
    expect(answered.body).toEqual({ error: { code: "Unavailable", message: "Service unavailable", details: {} } });
  }, DATABASE_TEST_MS);

  it("answers 503 at the deadline while the only pool connection is busy, then serves again", async () => {
    // No connect timeout and patient limits: only the deadline can end the wait for the client.
    const pool = new Pool({ connectionString: h.database.runtimePool.options.connectionString, max: 1, connectionTimeoutMillis: 0 });
    onTestFinished(() => pool.end());
    const app = appOnDatabase(createScopedDatabase(pool, PATIENT), { requestTimeoutMs: DEADLINE_MS });
    const busy = await pool.connect();
    let released = false;
    const release = () => { if (!released) { released = true; busy.release(); } };
    onTestFinished(release);
    // setImmediate stays real under the fake setTimeout, so this poll runs while time stands still.
    const parked = (async () => {
      while (pool.waitingCount === 0) await new Promise((resolve) => setImmediate(resolve));
    })();
    const answered = await answeredAtDeadline(() => call(app, "GET", "/v1/booking/resources", { token: h.a.token }), parked, DEADLINE_MS);
    expect(answered.status, JSON.stringify(answered.body)).toBe(503);
    expect(answered.headers.get("retry-after")).toBe("1");
    release();
    // The abandoned checkout gives its client back: the same pool serves the next request.
    const after = await call(app, "GET", "/v1/booking/resources", { token: h.a.token });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  }, DATABASE_TEST_MS);
});
