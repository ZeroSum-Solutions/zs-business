import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { apiErrorBodySchema, createOrFindContactOutputSchema, publicBookingReplySchema } from "@zs/contracts";
import { createLocalStubSessionCheck } from "@zs/core";
import { createRuntimePool, createScopedDatabase, DatabaseUnavailable, type ScopedDatabase, type Transaction } from "@zs/db";
import { createApp, createHs256Verifier } from "../src/app.js";
import {
  answeredAtDeadline, call, clock, createApiHarness, KEY_SECRET, ORIGIN, provisionPage, PUBLIC_BASE_URL, SECRET, type ApiHarness, waitUntil,
} from "./helpers.js";

// Real Postgres I/O through a proxy on a possibly busy machine: generous budgets, nothing timed.
const DATABASE_TEST_MS = 120_000;

let h: ApiHarness;
// Public routes on, so a public request's replay goes through the same app as an owner's.
beforeAll(async () => { h = await createApiHarness({ publicIntake: {} }); }, DATABASE_TEST_MS);
afterAll(async () => { await h?.close(); });

/**
 * A TCP proxy to the test database, as the runtime login, that passes a write's COMMIT on to
 * Postgres but never passes the answer back: the commit happens and its reply is lost. Read-only
 * transactions (the membership check before the action) commit normally. `stalled` resolves
 * once a COMMIT's reply has been held back.
 */
async function commitReplyLosingProxy(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let held!: () => void;
  const stalled = new Promise<void>((resolve) => { held = resolve; });
  const server = createServer((client) => {
    let wrote = false;
    let stalled = false;
    // The end of the previous chunk: a marker can straddle two TCP chunks.
    let tail = Buffer.alloc(0);
    const upstream = connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("data", (chunk: Buffer) => {
      upstream.write(chunk);
      const seen = Buffer.concat([tail, chunk]);
      tail = seen.subarray(Math.max(0, seen.length - 16));
      if (seen.includes("INSERT INTO")) wrote = true;
      // The simple-query message for COMMIT ends in its NUL; "READ COMMITTED" does not match.
      if (wrote && seen.includes("COMMIT\0")) stalled = true;
    });
    upstream.on("data", () => { if (stalled) held(); });
    upstream.on("data", (chunk) => { if (!stalled) client.write(chunk); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(databaseUrl);
  url.username = "zs_runtime";
  url.password = "";
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.href,
    stalled,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const DEADLINE_MS = 30_000;

describe("a COMMIT whose reply is lost at the deadline", () => {
  it("answers 503, reports the outcome as unknown, and the retry with the same key replays the committed contact", async () => {
    const proxy = await commitReplyLosingProxy(h.database.url);
    const pool = createRuntimePool({ connectionString: proxy.url, max: 2, connectionTimeoutMs: 2000, onError: () => undefined });
    const inner = createScopedDatabase(pool);
    const failures: unknown[] = [];
    const db: ScopedDatabase = {
      ...inner,
      tenant: (tenantId, work, options) => inner.tenant(tenantId, work, options)
        .catch((error: unknown) => { failures.push(error); throw error; }),
    };
    const stalling = createApp({
      verifier: createHs256Verifier(SECRET, { clock }),
      // The session check reads the auth stub directly; only the action's transaction goes through the proxy.
      sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
      clock,
      db,
      generateId: randomUUID,
      config: { allowedOrigins: [ORIGIN], requestTimeoutMs: DEADLINE_MS },
    });
    try {
      const key = randomUUID();
      const body = { displayName: "Lost Reply", email: "lost-reply@example.com" };
      const first = await answeredAtDeadline(
        () => call(stalling, "POST", "/v1/crm/contacts", { token: h.a.token, key, body }), proxy.stalled, DEADLINE_MS);
      expect(first.status).toBe(503);
      expect(apiErrorBodySchema.parse(first.body).error.code).toBe("Unavailable");
      // The transaction says its COMMIT may have applied, not that nothing committed.
      // The transaction reports after the response; the test's timeout bounds the wait.
      await waitUntil(() => failures.length > 0, "the transaction to report its outcome");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(DatabaseUnavailable);
      expect((failures[0] as DatabaseUnavailable).reason).toBe("commit_unknown");

      // It did apply.
      const rows = await h.database.pool.query<{ id: string }>(
        "SELECT id FROM crm_contacts WHERE tenant_id = $1 AND normalized_email = $2",
        [h.a.tenantId, body.email],
      );
      expect(rows.rows).toHaveLength(1);

      // The caller retries with the same key and gets the committed contact, not a second write.
      const retried = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key, body });
      expect(retried.status).toBe(201);
      const replayed = createOrFindContactOutputSchema.parse(retried.body).result;
      expect(replayed).toMatchObject({ created: true, contact: { id: rows.rows[0]!.id } });
      const after = await h.database.pool.query(
        "SELECT 1 FROM crm_contacts WHERE tenant_id = $1 AND normalized_email = $2",
        [h.a.tenantId, body.email],
      );
      expect(after.rowCount).toBe(1);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  }, DATABASE_TEST_MS);
});

const publicIntake = { keySecrets: { current: KEY_SECRET }, publicBaseUrl: PUBLIC_BASE_URL };

/** A weekday 09:00-17:00 UTC resource on its own published page, so no test shares a slot. */
async function bookablePage() {
  const resourceId = randomUUID();
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [h.a.tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5].map((weekday) =>
      ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
  ));
  const page = await provisionPage(h, h.a, { resourceIds: [resourceId] });
  const body = {
    resourceId, startsAt: "2026-10-20T10:00:00.000Z", name: "Mira Rowe",
    email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`, phone: null, notes: null,
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  };
  const bookings = async () => (await h.database.pool.query(
    "SELECT id FROM bookings WHERE tenant_id=$1 AND resource_id=$2", [h.a.tenantId, resourceId])).rows;
  return { path: `/public/v1/pages/${page.key}/requests`, body, bookings };
}

describe("a public booking request under the request deadline", () => {
  it("answers 503 when its COMMIT reply is lost, and the retry with the same key replays the booking", async () => {
    const proxy = await commitReplyLosingProxy(h.database.url);
    const pool = createRuntimePool({ connectionString: proxy.url, max: 2, connectionTimeoutMs: 2000, onError: () => undefined });
    const stalling = createApp({
      verifier: createHs256Verifier(SECRET, { clock }),
      sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
      clock,
      db: createScopedDatabase(pool),
      generateId: randomUUID,
      config: { allowedOrigins: [ORIGIN], requestTimeoutMs: DEADLINE_MS },
      publicIntake,
    });
    try {
      const { path, body, bookings } = await bookablePage();
      const key = randomUUID();
      // Before this was bounded the request waited for a reply that never came.
      const first = await answeredAtDeadline(() => call(stalling, "POST", path, { key, body }), proxy.stalled, DEADLINE_MS);
      expect(first.status).toBe(503);
      expect(apiErrorBodySchema.parse(first.body).error.code).toBe("Unavailable");
      expect(first.headers.get("retry-after")).toBe("1");
      expect(first.headers.get("cache-control")).toBe("no-store");
      // It did commit.
      expect(await bookings()).toHaveLength(1);

      const retried = await call(h.app, "POST", path, { key, body });
      expect(retried.status).toBe(201);
      expect(publicBookingReplySchema.parse(retried.body).startsAt).toBe(body.startsAt);
      expect(await bookings()).toHaveLength(1);
    } finally {
      await proxy.close();
      await pool.end().catch(() => undefined);
    }
  }, DATABASE_TEST_MS);

  it("answers a retry that times out waiting on its key with 503, and a later replay returns the booking", async () => {
    // The original request takes its idempotency key lock, then stalls until released.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The held transaction ends however the test ends.
    onTestFinished(() => release());
    let holding!: () => void;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const runtime = createScopedDatabase(h.database.runtimePool);
    const slow: ScopedDatabase = {
      ...runtime,
      tenant: (tenantId, work, options) => runtime.tenant(tenantId, (tx) => {
        let first = true;
        const gated: Transaction = {
          query: (async (...args: unknown[]) => {
            const result = await (tx.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (first && String(args[0]).includes("pg_advisory_xact_lock")) {
              first = false;
              holding();
              await gate;
            }
            return result;
          }) as Transaction["query"],
        };
        return work(gated);
      }, options),
    };
    const app = (db: ScopedDatabase) => createApp({
      verifier: createHs256Verifier(SECRET, { clock }),
      sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
      clock,
      db,
      generateId: randomUUID,
      // Far past the 200 ms lock wait, so the timeout is the lock's own at any machine speed.
      config: { allowedOrigins: [ORIGIN], requestTimeoutMs: 600_000 },
      publicIntake,
    });
    const { path, body, bookings } = await bookablePage();
    const key = randomUUID();
    const original = call(app(slow), "POST", path, { key, body });
    original.catch(() => undefined); // awaited below; never an unhandled rejection if the test fails first
    await held;
    // A short lock wait, well inside the deadline, so the timeout is the lock's own.
    const retry = await call(app(createScopedDatabase(h.database.runtimePool, { lockTimeoutMs: 200 })), "POST", path, { key, body });
    expect(retry.status).toBe(503);
    expect(apiErrorBodySchema.parse(retry.body).error.code).toBe("Unavailable");
    release();
    expect((await original).status).toBe(201);
    const replay = await call(h.app, "POST", path, { key, body });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual((await original).body);
    expect(await bookings()).toHaveLength(1);
  }, DATABASE_TEST_MS);
});
