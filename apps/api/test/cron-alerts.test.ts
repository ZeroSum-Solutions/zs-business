// A failed cron run leaves one visible alert row; a repeat failure raises its count; the next good
// run closes it. Against Postgres with an injected clock; no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { createCronAlerts, describeCronError, listOpenCronAlerts, type ServiceRun } from "../src/cron-alerts.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { followUpCronRoutes } from "../src/followup/cron.js";
import { activepiecesCronRoutes } from "../src/activepieces/cron.js";

const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
let database: TestDatabase;
let now = Date.parse("2026-11-08T10:00:00.000Z");
const clock = { now: () => new Date(now) };
const minutes = (count: number) => { now += count * 60_000; };
const service: ServiceRun = (work) => asService(database.pool, work);
const alerts = () => createCronAlerts({ service, clock, report: () => undefined });
const rows = async () => (await database.pool.query("SELECT * FROM cron_alerts ORDER BY job")).rows;
const authed = { headers: { Authorization: `Bearer ${CRON_SECRET}` } };

beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  now = Date.parse("2026-11-08T10:00:00.000Z");
  await database.pool.query("DELETE FROM cron_alerts");
});

describe("cron alert rows", () => {
  it("opens one alert on the first failure", async () => {
    await alerts().failed("billing", new Error("Stripe read timed out"));
    const [row] = await rows();
    expect(row).toMatchObject({ job: "billing", failure_count: 1, last_error: "Error: Stripe read timed out", resolved_at: null });
    expect(row.opened_at.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job)).toEqual(["billing"]);
  });

  it("dedups a repeat failure onto the open row and keeps when it began", async () => {
    const a = alerts();
    await a.failed("billing", new Error("first"));
    minutes(5);
    await a.failed("billing", new Error("second"));
    minutes(5);
    await a.failed("billing", new Error("third"));
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ failure_count: 3, last_error: "Error: third", resolved_at: null });
    expect(found[0].opened_at.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(found[0].last_failed_at.toISOString()).toBe("2026-11-08T10:10:00.000Z");
  });

  it("keeps jobs apart", async () => {
    const a = alerts();
    await a.failed("billing", new Error("x"));
    await a.failed("connections", new Error("y"));
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job).sort()).toEqual(["billing", "connections"]);
  });

  it("closes the alert on the next good run, and a later failure opens it afresh", async () => {
    const a = alerts();
    await a.failed("billing", new Error("down"));
    await a.failed("billing", new Error("down"));
    minutes(5);
    await a.succeeded("billing");
    expect(await listOpenCronAlerts(service)).toEqual([]);
    expect((await rows())[0].resolved_at.toISOString()).toBe("2026-11-08T10:05:00.000Z");

    minutes(5);
    await a.failed("billing", new Error("down again"));
    const [row] = await rows();
    expect(row).toMatchObject({ failure_count: 1, last_error: "Error: down again", resolved_at: null });
    expect(row.opened_at.toISOString()).toBe("2026-11-08T10:10:00.000Z");
  });

  it("a good run with nothing open writes nothing", async () => {
    await alerts().succeeded("delivery");
    expect(await rows()).toEqual([]);
  });

  it("is closed to the runtime role and the Data API roles", async () => {
    await alerts().failed("billing", new Error("x"));
    await expect(database.db.withoutTenant((tx) => tx.query("SELECT * FROM cron_alerts"))).rejects.toThrow(/permission denied/);
    await expect(database.db.withoutTenant((tx) => tx.query(
      "INSERT INTO cron_alerts (job, opened_at, last_failed_at, last_error) VALUES ('x', now(), now(), 'x')"))).rejects.toThrow(/permission denied/);
  });

  it("never throws when the alert cannot be written, and tells the operator log", async () => {
    const report = vi.fn();
    const broken = createCronAlerts({ service: () => Promise.reject(new Error("db down")), clock, report });
    await expect(broken.failed("billing", new Error("x"))).resolves.toBeUndefined();
    await expect(broken.succeeded("billing")).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("stores no URL, key or stack, and at most 500 characters", () => {
    const error = new Error(`connect failed postgres://user:hunter2@db.example.com:5432/app with Bearer abc.def and rk_live_ABCDEFGH12345678`);
    const text = describeCronError(error);
    expect(text).toBe("Error: connect failed <url> with Bearer <secret> and <secret>");
    expect(text).not.toContain("hunter2");
    expect(describeCronError(new Error("x".repeat(2000)))).toHaveLength(500);
    expect(describeCronError("")).toBe("unknown error");
  });
});

describe("cron routes raise and clear the alert", () => {
  const ok = { run: async () => ({ done: 1 }) };

  it("a failing run answers 503 and records one alert; the next good run closes it", async () => {
    let fail = true;
    const runner = { run: async () => { if (fail) throw new Error("pool exhausted"); return { done: 1 }; } };
    const app = cronRoutes({ path: "/cron/billing", name: "Billing", cronSecret: CRON_SECRET, runner, alerts: alerts(), onError: () => undefined });

    expect((await app.request("/cron/billing", authed)).status).toBe(503);
    minutes(5);
    expect((await app.request("/cron/billing", authed)).status).toBe(503);
    const open = await listOpenCronAlerts(service);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ job: "billing", failureCount: 2, lastError: "Error: pool exhausted" });

    fail = false;
    minutes(5);
    const good = await app.request("/cron/billing", authed);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ran: true, done: 1 });
    expect(await listOpenCronAlerts(service)).toEqual([]);
  });

  it("the alert write failing does not change the cron's answer", async () => {
    const app = cronRoutes({
      cronSecret: CRON_SECRET,
      runner: { run: async () => { throw new Error("boom"); } },
      alerts: createCronAlerts({ service: () => Promise.reject(new Error("db down")), clock, report: () => undefined }),
      onError: () => undefined,
    });
    const reply = await app.request("/cron/delivery", authed);
    expect(reply.status).toBe(503);
    expect(await reply.json()).toMatchObject({ error: { code: "Unavailable" } });
  });

  it("a refused caller, a missing secret and a switched-off job record nothing", async () => {
    const failing = { run: async () => { throw new Error("must not run"); } };
    const app = cronRoutes({ cronSecret: CRON_SECRET, runner: failing, alerts: alerts() });
    expect((await app.request("/cron/delivery", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await cronRoutes({ cronSecret: null, runner: failing, alerts: alerts() }).request("/cron/delivery")).status).toBe(404);
    const off = await cronRoutes({ cronSecret: CRON_SECRET, runner: null, alerts: alerts() }).request("/cron/delivery", authed);
    expect(off.status).toBe(200);
    expect(await rows()).toEqual([]);
  });

  it("the follow-up and Activepieces crons raise their own alerts", async () => {
    const failing = { run: async () => { throw new Error("nope"); } };
    const followUp = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: failing as never, alerts: alerts(), onError: () => undefined });
    const activepieces = activepiecesCronRoutes({ cronSecret: CRON_SECRET, runner: failing as never, alerts: alerts(), onError: () => undefined });
    expect((await followUp.request("/cron/followup", authed)).status).toBe(503);
    expect((await activepieces.request("/cron/activepieces", authed)).status).toBe(503);
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job).sort()).toEqual(["activepieces", "followup"]);

    const okFollowUp = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: ok as never, alerts: alerts() });
    expect((await okFollowUp.request("/cron/followup", authed)).status).toBe(200);
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job)).toEqual(["activepieces"]);
  });

  it("cron answers carry nosniff and no-store", async () => {
    const reply = await cronRoutes({ cronSecret: CRON_SECRET, runner: ok }).request("/cron/delivery", authed);
    expect(reply.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    const unknown = await cronRoutes({ cronSecret: CRON_SECRET, runner: ok }).request("/cron/other");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
