// A failed cron run leaves one visible alert row; a repeat failure raises its count; the next good
// run closes it. Against Postgres; the row's times come from the database clock. No network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { createCronAlerts, describeCronError, listOpenCronAlerts, startCronRun, type ServiceRun } from "../src/cron-alerts.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { followUpCronRoutes } from "../src/followup/cron.js";
import { activepiecesCronRoutes } from "../src/activepieces/cron.js";

const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
let database: TestDatabase;
// The recorder's own clock only seeds a run's start; every stored time is the database's.
const clock = { now: () => new Date("2026-11-08T10:00:00.000Z") };
const realClock = { now: () => new Date() };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  await database.pool.query("DELETE FROM cron_alerts");
});

describe("cron alert rows", () => {
  it("opens one alert on the first failure, stamped by the database clock", async () => {
    const before = Date.now();
    await alerts().failed("billing", new Error("Stripe read timed out"));
    const [row] = await rows();
    expect(row).toMatchObject({ job: "billing", failure_count: 1, last_error: "Error: Stripe read timed out", resolved_at: null, notified_at: null });
    // The injected clock says 2026-11-08T10:00Z; the stored time is the database's, not that.
    expect(Math.abs(row.opened_at.getTime() - before)).toBeLessThan(10_000);
    expect(row.last_failed_at.getTime()).toBe(row.opened_at.getTime());
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job)).toEqual(["billing"]);
  });

  it("dedups a repeat failure onto the open row and keeps when it began", async () => {
    const a = alerts();
    await a.failed("billing", new Error("first"));
    const [first] = await rows();
    await sleep(15);
    await a.failed("billing", new Error("second"));
    await a.failed("billing", new Error("third"));
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ failure_count: 3, last_error: "Error: third", resolved_at: null });
    expect(found[0].opened_at.getTime()).toBe(first.opened_at.getTime());
    expect(found[0].last_failed_at.getTime()).toBeGreaterThan(first.opened_at.getTime());
  });

  it("loses no increment when runs overlap", async () => {
    await alerts().failed("billing", new Error("seed"));
    const a = createCronAlerts({ service, clock, report: () => undefined });
    await Promise.all(Array.from({ length: 12 }, (_, i) => a.failed("billing", new Error(`overlap ${i}`))));
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].failure_count).toBe(13);
  });

  it("never moves last_failed_at back, and an older write keeps the newer error", async () => {
    await alerts().failed("billing", new Error("recent"));
    // A row whose last failure is ahead of the next write: skew, or an overlapping run that finished first.
    await database.pool.query("UPDATE cron_alerts SET last_failed_at = now() + interval '1 hour', last_error = 'Error: newest'");
    const [skewed] = await rows();
    await alerts().failed("billing", new Error("older write"));
    const [after] = await rows();
    expect(after.failure_count).toBe(2);
    expect(after.last_failed_at.getTime()).toBe(skewed.last_failed_at.getTime());
    expect(after.last_error).toBe("Error: newest");
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
    await sleep(10);
    await a.succeeded("billing", startCronRun(realClock));
    expect(await listOpenCronAlerts(service)).toEqual([]);
    const [closed] = await rows();
    expect(closed.resolved_at).not.toBeNull();

    await sleep(10);
    await a.failed("billing", new Error("down again"));
    const [row] = await rows();
    expect(row).toMatchObject({ failure_count: 1, last_error: "Error: down again", resolved_at: null, notified_at: null });
    expect(row.opened_at.getTime()).toBeGreaterThanOrEqual(closed.resolved_at.getTime());
  });

  it("a stale success does not resolve a newer failure", async () => {
    const a = alerts();
    const slowRun = startCronRun(realClock); // began before the failure below and finishes after it
    await sleep(15);
    await a.failed("billing", new Error("newer failure"));
    await a.succeeded("billing", slowRun);
    expect(await listOpenCronAlerts(service)).toHaveLength(1);
    await sleep(15);
    await a.succeeded("billing", startCronRun(realClock)); // began after the failure: closes it
    expect(await listOpenCronAlerts(service)).toEqual([]);
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

  it("has no ordering constraint a legitimate write could trip", async () => {
    const constraints = await database.pool.query("SELECT conname FROM pg_constraint WHERE conrelid = 'public.cron_alerts'::regclass AND contype = 'c'");
    expect(constraints.rows.map((row: { conname: string }) => row.conname).sort()).toEqual(["cron_alerts_count", "cron_alerts_error_length", "cron_alerts_job"]);
  });
});

describe("the recorder never throws and never overruns its budget", () => {
  it("never throws when the alert cannot be written, and tells the operator log", async () => {
    const report = vi.fn();
    const broken = createCronAlerts({ service: () => Promise.reject(new Error("db down")), clock, report });
    await expect(broken.failed("billing", new Error("x"))).resolves.toBeUndefined();
    await expect(broken.succeeded("billing")).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("never throws for any thrown value", async () => {
    const report = vi.fn();
    const a = createCronAlerts({ service, clock, report });
    const nullProto = Object.assign(Object.create(null), { message: "no toString" });
    const hostile = { toString() { throw new Error("toString bug"); } };
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const thrown = [nullProto, hostile, circular, undefined, null, Symbol("s"), 42, "text", { message: "plain object" }];
    for (const value of thrown) await expect(a.failed("billing", value)).resolves.toBeUndefined();
    expect((await rows())[0].failure_count).toBe(thrown.length);
    for (const value of [nullProto, hostile, undefined, null]) expect(typeof describeCronError(value)).toBe("string");
    expect(report).not.toHaveBeenCalled();
  });

  it("a report hook that throws does not escape", async () => {
    const a = createCronAlerts({ service: () => Promise.reject(new Error("down")), clock, report: () => { throw new Error("log bug"); } });
    await expect(a.failed("billing", new Error("x"))).resolves.toBeUndefined();
  });

  it("a database that hangs is cut at the cap, and the cron answers within it", async () => {
    const report = vi.fn();
    const hung = createCronAlerts({ service: () => new Promise(() => undefined), clock, report, capMs: 300 });
    const began = Date.now();
    await hung.failed("billing", new Error("x"));
    await hung.succeeded("billing");
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("starts no work when the function has no time left", async () => {
    const hold = vi.fn();
    const a = createCronAlerts({ service: hold as never, clock, report: () => undefined, monotonicMs: () => 60_000 });
    await a.failed("billing", new Error("x"), { startedAt: new Date(), startedMonotonicMs: 0 });
    await a.succeeded("billing", { startedAt: new Date(), startedMonotonicMs: 0 });
    expect(hold).not.toHaveBeenCalled();
  });

  it("hands the email only the time left, and a refused send leaves the row unnotified", async () => {
    const notify = vi.fn(async (_message: unknown, options?: { timeoutMs?: number }) => {
      expect(options?.timeoutMs).toBeLessThanOrEqual(3_000);
      expect(options?.timeoutMs).toBeGreaterThan(0);
      return false;
    });
    await createCronAlerts({ service, clock, report: () => undefined, notify }).failed("billing", new Error("x"));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await rows())[0].notified_at).toBeNull();
  });

  it("sets notified_at after a send, retries an unnotified open alert on any later failure, and mails a reopen again", async () => {
    let accepted = false;
    const notify = vi.fn(async (_message: unknown) => accepted);
    const a = createCronAlerts({ service, clock, report: () => undefined, notify });
    await a.failed("billing", new Error("first"));
    await a.failed("billing", new Error("second"));
    expect(notify).toHaveBeenCalledTimes(2); // not accepted: tried again on the repeat failure
    expect((await rows())[0].notified_at).toBeNull();
    accepted = true;
    await a.failed("billing", new Error("third"));
    expect(notify).toHaveBeenCalledTimes(3);
    expect((await rows())[0].notified_at).not.toBeNull();
    await a.failed("billing", new Error("fourth"));
    expect(notify).toHaveBeenCalledTimes(3); // notified: a repeat is quiet
    await sleep(10);
    await a.succeeded("billing", startCronRun(realClock));
    await sleep(10);
    await a.failed("billing", new Error("back"));
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify.mock.calls[2]![0]).toMatchObject({ job: "billing", failureCount: 3, error: "Error: third" });
    // The idempotency key is job + opened_at: the retries of one opening share it, the reopen has its own.
    expect(notify.mock.calls[0]![0]).toMatchObject({ openedAt: (notify.mock.calls[2]![0] as { openedAt: string }).openedAt });
    expect(notify.mock.calls[3]![0]).not.toMatchObject({ openedAt: (notify.mock.calls[2]![0] as { openedAt: string }).openedAt });
  });
});

describe("what the table keeps of an error", () => {
  const cases: Array<[string, string, string]> = [
    ["a URL", "connect failed postgres://user:hunter2@db.example.com:5432/app", "<url>"],
    ["a Resend key", "key re_AbCdEf1234567890xyz was refused", "<secret>"],
    ["a Shopify admin token", `bad ${"shp" + "at"}_0123456789abcdef0123456789abcdef`, "<secret>"],
    ["a Shopify custom-app token", `bad ${"shp" + "ca"}_0123456789abcdef0123456789abcdef`, "<secret>"],
    ["a Shopify shared secret", `bad ${"shp" + "ss"}_0123456789abcdef0123456789abcdef`, "<secret>"],
    ["a Stripe secret key", "sk_live_ABCDEFGH12345678", "<secret>"],
    ["a Stripe restricted key", "rk_live_ABCDEFGH12345678", "<secret>"],
    ["a Stripe webhook secret", "whsec_ABCDEFGH12345678", "<secret>"],
    ["a JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl rejected", "<jwt>"],
    ["a bearer token", "Authorization: Bearer abc.def-123", "Bearer <secret>"],
    ["a password pair", "login failed password=hunter2 for user", "password=<secret>"],
    ["a token pair", "call failed token: s3cr3tvalue", "token=<secret>"],
    ["an api_key pair", "bad api_key=ABCD1234", "api_key=<secret>"],
    ["a secret pair", "client_secret=ABCD1234 invalid", "client_secret=<secret>"],
    ["a key pair", "invalid key=ABCD1234", "key=<secret>"],
    ["an email address", "no mailbox for jane.doe+test@example.co.uk", "<email>"],
  ];
  const LEAKS = ["hunter2", "AbCdEf1234567890", "0123456789abcdef", "ABCDEFGH12345678", "eyJhbGci", "abc.def-123", "s3cr3tvalue", "ABCD1234", "jane.doe", "example.co.uk"];
  it.each(cases)("redacts %s", (_label, message, marker) => {
    const text = describeCronError(new Error(message));
    expect(text).toContain(marker);
    for (const leaked of LEAKS) expect(text).not.toContain(leaked);
  });

  it("keeps the class and the plain words of the message", () => {
    expect(describeCronError(new TypeError("pool exhausted after 3 tries"))).toBe("TypeError: pool exhausted after 3 tries");
  });

  it("stores no stack and at most 500 characters", () => {
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
    expect((await app.request("/cron/billing", authed)).status).toBe(503);
    const open = await listOpenCronAlerts(service);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ job: "billing", failureCount: 2, lastError: "Error: pool exhausted" });

    fail = false;
    await sleep(15);
    const good = await app.request("/cron/billing", authed);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ran: true, done: 1 });
    expect(await listOpenCronAlerts(service)).toEqual([]);
  });

  it("a run that returns only failures alerts, still answers 200, and the next run with a success closes it", async () => {
    let summary: object = { passes: 1, ingested: 0, claimed: 3, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 3, budgetSpent: false };
    const app = cronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => summary }, alerts: alerts() });
    expect((await app.request("/cron/delivery", authed)).status).toBe(200);
    const open = await listOpenCronAlerts(service);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ job: "delivery", lastError: "CronRunFailed: delivery run finished with only failures: every delivery of the run failed (3 errors)" });

    summary = { passes: 1, ingested: 0, claimed: 3, sent: 2, retried: 0, blocked: 0, dead: 0, errors: 1, budgetSpent: false };
    await sleep(15);
    expect((await app.request("/cron/delivery", authed)).status).toBe(200);
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

  it("a hung alert write does not hold the cron's answer", async () => {
    const app = cronRoutes({
      cronSecret: CRON_SECRET,
      runner: { run: async () => { throw new Error("boom"); } },
      alerts: createCronAlerts({ service: () => new Promise(() => undefined), clock, report: () => undefined, capMs: 300 }),
      onError: () => undefined,
    });
    const began = Date.now();
    expect((await app.request("/cron/delivery", authed)).status).toBe(503);
    expect(Date.now() - began).toBeLessThan(1_500);
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

    await sleep(15);
    const okFollowUp = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: ok as never, alerts: alerts() });
    expect((await okFollowUp.request("/cron/followup", authed)).status).toBe(200);
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job)).toEqual(["activepieces"]);
  });

  it("the follow-up and Activepieces crons alert on an all-failed run", async () => {
    const followUp = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => ({ errors: 2, drafted: 0, skipped: 0, stopped: 0 }) } as never, alerts: alerts() });
    const activepieces = activepiecesCronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => ({ errors: 2, delivered: 0, retried: 0, dead: 0 }) } as never, alerts: alerts() });
    expect((await followUp.request("/cron/followup", authed)).status).toBe(200);
    expect((await activepieces.request("/cron/activepieces", authed)).status).toBe(200);
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job).sort()).toEqual(["activepieces", "followup"]);
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
