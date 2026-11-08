// A cron function that cannot start raises a cron alert: a bad configuration is recorded under the job with
// the CronStartupFailed kind, mailed once, and answered 503; the cron call is authenticated before anything
// is built. Postgres is local; the Resend call is an injected fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimePool } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { activepiecesCronRoutes } from "../src/activepieces/cron.js";
import { PLACEHOLDER_CRON_SECRET } from "../src/cron-common.js";
import { createCronAlerts, describeCronError, startCronRun, type ServiceRun } from "../src/cron-alerts.js";
import { createStartupAlerts, guardCronEntry, type CronEntry, type CronHandler, type StartupAlerts } from "../src/cron-startup.js";
import { asService } from "@zs/db";
import { parseDeliveryEnv } from "../src/delivery/config.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { followUpCronRoutes } from "../src/followup/cron.js";

// The pool factory is spied (and still real), so a test can say whether a connection was opened.
vi.mock("@zs/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zs/db")>();
  return { ...actual, createRuntimePool: vi.fn(actual.createRuntimePool) };
});

const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const RESEND_KEY = ["re", "test", "k".repeat(24)].join("_");
const MAIL = { OPS_ALERT_EMAIL: "ops@example.com", RESEND_API_KEY: RESEND_KEY, RESEND_FROM: "ZS Hub <alerts@hub.example>" };
const clock = { now: () => new Date("2026-11-08T10:30:00.000Z") };
const cronRequest = (headers: Record<string, string> = { Authorization: `Bearer ${CRON_SECRET}` }, path = "/cron/delivery", method = "GET") =>
  new Request(`https://workers.example${path}`, { method, headers });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Settings = Record<string, string | undefined>;
let database: TestDatabase;
let serviceUrl: string;
let created: Array<{ dispose(): Promise<void> }> = [];

beforeAll(async () => {
  database = await createTestDatabase();
  const url = new URL(database.url);
  url.username = "zs_service";
  url.password = "";
  serviceUrl = url.href;
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.pool.query("DELETE FROM cron_alerts");
  vi.mocked(createRuntimePool).mockClear();
});
afterEach(async () => {
  await Promise.all(created.map((alerts) => alerts.dispose()));
  created = [];
});

const rows = async () => (await database.pool.query("SELECT * FROM cron_alerts ORDER BY job")).rows;
const okMail = () => vi.fn(async () => new Response('{"id":"em_1"}', { status: 200 }));
const callOf = (send: ReturnType<typeof vi.fn>, call = 0) => send.mock.calls[call] as unknown as [string, RequestInit];
const mailBody = (send: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String(callOf(send, call)[1].body));
const served: CronHandler = () => new Response("ok", { status: 200 });

/** The real startup alerts over `settings`; every log line lands in `logs`. */
function alertsFor(settings: Settings, send = okMail(), databaseUrlVariable = "DELIVERY_DATABASE_URL") {
  const logs: string[] = [];
  const alerts = createStartupAlerts({ env: settings, clock, databaseUrlVariable, fetch: send as never, report: (line) => logs.push(line) });
  created.push(alerts);
  return { alerts, logs, send };
}

/** The delivery entry's config parse and cron route, guarded, over settings the test controls. */
function deliveryEntry(settings: Settings, send = okMail()) {
  const { alerts, logs } = alertsFor(settings, send);
  const build = vi.fn((): CronEntry => ({ fetch: cronRoutes({ cronSecret: parseDeliveryEnv(settings).cronSecret, runner: null }).fetch }));
  const handler = guardCronEntry({
    job: "delivery", cronPath: "/cron/delivery", env: settings, clock, report: (line) => logs.push(line), startupAlerts: alerts, build,
  });
  return { handler, send, logs, build };
}
const broken = (): Settings => ({ ...MAIL, CRON_SECRET, DELIVERY_WORKER: "on", DELIVERY_DATABASE_URL: serviceUrl });
const idleAlerts: StartupAlerts = { record: async () => undefined, closeStartup: async () => undefined };
const guardFor = (settings: Settings, build: () => CronEntry | Promise<CronEntry>, startupAlerts: StartupAlerts = idleAlerts, extra: object = {}) =>
  guardCronEntry({ job: "delivery", cronPath: "/cron/delivery", env: settings, clock, report: () => undefined, startupAlerts, build, ...extra });

describe("a cron worker that fails at start-up", () => {
  it("records a startup alert for a missing required variable, mails it, and answers 503", async () => {
    const { handler, send } = deliveryEntry(broken());
    const response = await handler(cronRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [row] = await rows();
    expect(row).toMatchObject({ job: "delivery", failure_count: 1, resolved_at: null });
    expect(row.last_error).toMatch(/^CronStartupFailed: delivery failed to start: Invalid environment: /);
    expect(row.last_error).toContain("DELIVERY_PRICE_EMAIL");
    expect(row.notified_at).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(mailBody(send).subject).toContain('Cron job "delivery" is failing');
  });

  it("a repeat failing tick raises the count, reuses one pool and mails nothing more", async () => {
    const { handler, send } = deliveryEntry(broken());
    await handler(cronRequest());
    await handler(cronRequest());
    await handler(cronRequest());
    expect((await rows())[0]).toMatchObject({ failure_count: 3 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(createRuntimePool).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls onto one build and one recording", async () => {
    const settings = broken();
    const { alerts } = alertsFor(settings);
    const build = vi.fn(async (): Promise<CronEntry> => { await sleep(30); throw new Error("Invalid environment: X is missing"); });
    const handler = guardFor(settings, build, alerts);
    const answers = await Promise.all([handler(cronRequest()), handler(cronRequest()), handler(cronRequest())]);
    expect(answers.map((a) => a.status)).toEqual([503, 503, 503]);
    expect(build).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ failure_count: 1 });
    expect(createRuntimePool).toHaveBeenCalledTimes(1);
  });

  it("builds the mailer once, so a missing OPS_ALERT_EMAIL is logged once per instance", async () => {
    const settings = { ...broken(), OPS_ALERT_EMAIL: undefined };
    const { handler, logs } = deliveryEntry(settings);
    await handler(cronRequest());
    await handler(cronRequest());
    await handler(cronRequest());
    expect(logs.filter((line) => line.includes("OPS_ALERT_EMAIL is not set"))).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ failure_count: 3, notified_at: null });
  });
});

describe("the cron call is authenticated before anything is built", () => {
  const unauthorised: Array<[string, () => Settings, Record<string, string>, number]> = [
    ["the .env.example placeholder", () => ({ ...broken(), CRON_SECRET: PLACEHOLDER_CRON_SECRET }), { Authorization: `Bearer ${PLACEHOLDER_CRON_SECRET}` }, 401],
    ["a secret under 32 characters", () => ({ ...broken(), CRON_SECRET: "short" }), { Authorization: "Bearer short" }, 401],
    ["a wrong bearer", broken, { Authorization: "Bearer wrong" }, 401],
    ["no Authorization header", broken, {}, 401],
    ["CRON_SECRET unset", () => ({ ...broken(), CRON_SECRET: undefined }), {}, 404],
  ];
  it.each(unauthorised)("%s: no build, no pool, no log, no row, no email", async (_name, settings, headers, status) => {
    const { handler, send, logs, build } = deliveryEntry(settings());
    expect((await handler(cronRequest(headers))).status).toBe(status);
    expect(build).not.toHaveBeenCalled();
    expect(createRuntimePool).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers any other path or method of a single-route entry 404 without building", async () => {
    const { handler, build, logs } = deliveryEntry(broken());
    expect((await handler(cronRequest({ Authorization: `Bearer ${CRON_SECRET}` }, "/internal/connections/run", "POST"))).status).toBe(404);
    expect((await handler(cronRequest({ Authorization: `Bearer ${CRON_SECRET}` }, "/cron/delivery", "POST"))).status).toBe(404);
    expect(build).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("with otherPaths=build, an unauthenticated path starts the build but logs and records nothing, and backs off", async () => {
    const settings = broken();
    const { alerts, logs } = alertsFor(settings);
    const build = vi.fn((): CronEntry => { throw new Error("pool refused"); });
    const handler = guardFor(settings, build, alerts, { otherPaths: "build", report: (line: string) => logs.push(line) });
    const other = () => handler(cronRequest({}, "/webhooks/shopify", "POST"));
    expect((await other()).status).toBe(503);
    expect((await other()).status).toBe(503);
    expect(build).toHaveBeenCalledTimes(1); // the second call was inside the back-off
    expect(logs).toEqual([]);
    expect(await rows()).toEqual([]);
    // The authorised cron call still gets its own build and its alert.
    expect((await handler(cronRequest())).status).toBe(503);
    expect(build).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(1);
  });

  it("an unreadable request URL is answered, not rejected", async () => {
    const handler = guardFor(broken(), () => ({ fetch: served }));
    const odd = { method: "GET", url: "not a url", headers: new Headers() } as unknown as Request;
    expect((await handler(odd)).status).toBe(404);
  });
});

describe("only the build is a startup failure", () => {
  it("lets an error thrown by the built handler reach the caller as before, with no alert", async () => {
    const record = vi.fn(async () => undefined);
    const boom = new Error("route bug");
    const handler = guardFor({ ...broken() }, () => ({ fetch: () => { throw boom; } }), { ...idleAlerts, record });
    await expect(handler(cronRequest())).rejects.toBe(boom);
    await expect(handler(cronRequest())).rejects.toBe(boom);
    expect(record).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it("serves a good start unchanged and raises no alert", async () => {
    const send = okMail();
    const { alerts } = alertsFor({ ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl }, send);
    const runner = { run: vi.fn(async () => ({ sent: 2, retried: 0, blocked: 0, dead: 0, errors: 0 })) };
    const log = vi.fn();
    const handler = guardFor({ ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl }, () => ({
      fetch: cronRoutes({ cronSecret: CRON_SECRET, runner, alerts: createCronAlerts({ service: (work) => asService(database.pool, work), clock: { now: () => new Date() }, report: log }) }).fetch,
    }), alerts);
    const response = await handler(cronRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ran: true, sent: 2 });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(createRuntimePool).not.toHaveBeenCalled();
  });
});

describe("a startup alert closes on the next good run", () => {
  const routes: Array<[string, string, string, (alerts: ReturnType<typeof createCronAlerts>) => CronEntry]> = [
    ["billing", "billing", "/cron/billing", (alerts) => ({
      fetch: cronRoutes({ path: "/cron/billing", killSwitch: "BILLING_WORKER", name: "Billing", cronSecret: CRON_SECRET, runner: { run: async () => ({ outcomes: { paid: 1 } }) }, alerts }).fetch,
    })],
    ["calendar", "calendar", "/cron/calendar", (alerts) => ({
      fetch: cronRoutes({ path: "/cron/calendar", killSwitch: "CALENDAR_WORKER", name: "Calendar", cronSecret: CRON_SECRET, runner: { run: async () => ({ counts: { synced: 1 } }) }, alerts }).fetch,
    })],
    ["delivery", "delivery", "/cron/delivery", (alerts) => ({ fetch: cronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => ({ sent: 1 }) }, alerts }).fetch })],
    ["followup", "followup", "/cron/followup", (alerts) => ({ fetch: followUpCronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => ({ drafted: 1 }) } as never, alerts }).fetch })],
    ["activepieces", "activepieces", "/cron/activepieces", (alerts) => ({
      fetch: activepiecesCronRoutes({ cronSecret: CRON_SECRET, runner: { run: async () => ({ delivered: 1 }) } as never, alerts }).fetch,
    })],
  ];
  it.each(routes)("%s: startup failure, then a good run, then the alert is closed", async (_name, job, path, entryFor) => {
    const settings = { ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl };
    const { alerts: startup } = alertsFor(settings);
    let attempts = 0;
    const alerts = createCronAlerts({ service: (work) => asService(database.pool, work), clock: { now: () => new Date() }, report: () => undefined });
    const handler = guardCronEntry({
      job, cronPath: path, env: settings, clock, report: () => undefined, startupAlerts: startup,
      build: () => { attempts += 1; if (attempts === 1) throw new Error("Invalid environment: X is missing"); return entryFor(alerts); },
    });
    expect((await handler(cronRequest(undefined, path))).status).toBe(503);
    const [open] = await rows();
    expect(open).toMatchObject({ job, resolved_at: null });
    expect(open.last_error).toContain("CronStartupFailed");
    await sleep(20);
    expect((await handler(cronRequest(undefined, path))).status).toBe(200);
    const [closed] = await rows();
    expect(closed).toMatchObject({ job });
    expect(closed.resolved_at).not.toBeNull();
  });

  it("a worker switched off closes a stale startup alert once, and leaves a run failure open", async () => {
    const settings = { ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl };
    const { alerts } = alertsFor(settings);
    await database.pool.query(
      `INSERT INTO cron_alerts (job, opened_at, last_failed_at, failure_count, last_error) VALUES
         ('delivery', now(), now(), 2, 'CronStartupFailed: delivery failed to start: Invalid environment: X'),
         ('billing', now(), now(), 1, 'Error: Stripe read timed out')`,
    );
    const closeStartup = vi.spyOn(alerts, "closeStartup");
    const handler = guardFor(settings, () => ({ fetch: served, disabled: true }), alerts);
    expect((await handler(cronRequest())).status).toBe(200);
    expect((await handler(cronRequest())).status).toBe(200);
    expect(closeStartup).toHaveBeenCalledTimes(1);
    const byJob = Object.fromEntries((await rows()).map((row) => [row.job, row]));
    expect(byJob.delivery.resolved_at).not.toBeNull();
    expect(byJob.billing.resolved_at).toBeNull();
  });

  it("an unauthorised call does not close anything", async () => {
    const settings = { ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl };
    const { alerts } = alertsFor(settings);
    await database.pool.query("INSERT INTO cron_alerts (job, opened_at, last_failed_at, last_error) VALUES ('delivery', now(), now(), 'CronStartupFailed: x')");
    const handler = guardFor(settings, () => ({ fetch: served, disabled: true }), alerts);
    expect((await handler(cronRequest({ Authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await rows())[0]!.resolved_at).toBeNull();
  });
});

describe("the build runs to a deadline and one at a time", () => {
  it("the next build waits until the previous failure is on its row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const record = vi.fn(async () => { await gate; });
    let builds = 0;
    const handler = guardFor(broken(), () => { builds += 1; if (builds === 1) throw new Error("transient"); return { fetch: served }; }, { ...idleAlerts, record });
    const first = handler(cronRequest());
    await sleep(30);
    const second = handler(cronRequest());
    await sleep(30);
    expect(record).toHaveBeenCalledTimes(1);
    expect(builds).toBe(1); // the retry has not started: the failure is not recorded yet
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([503, 200]);
    expect(builds).toBe(2);
  });

  it("a build that hangs answers 503 at the deadline, is recorded, and is adopted when it finishes", async () => {
    let finish!: (entry: CronEntry) => void;
    const build = vi.fn(() => new Promise<CronEntry>((resolve) => { finish = resolve; }));
    const record = vi.fn(async () => undefined);
    const handler = guardFor(broken(), build, { ...idleAlerts, record }, { buildTimeoutMs: 40 });
    const began = Date.now();
    expect((await handler(cronRequest())).status).toBe(503);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(record).toHaveBeenCalledTimes(1);
    expect(String((record.mock.calls[0] as unknown as [{ error: Error }])[0].error.message)).toContain("build timed out");
    expect((await handler(cronRequest())).status).toBe(503); // still the same build, not a second one
    expect(build).toHaveBeenCalledTimes(1);
    finish({ fetch: served });
    await sleep(10);
    expect((await handler(cronRequest())).status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("gives the email no time past the shared deadline", async () => {
    const send = okMail();
    const { alerts, logs } = alertsFor({ ...MAIL, CRON_SECRET }, send); // no database URL: the email would be next
    const error = new Error("late") as never;
    const late = { startedAt: new Date(), startedMonotonicMs: performance.now() - 29_000 };
    const began = Date.now();
    await alerts.record({ job: "delivery", error, run: late });
    expect(Date.now() - began).toBeLessThan(500);
    expect(send).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("no time left for the email"))).toBe(true);
  });
});

describe("what is written, and what is mailed when no row can be", () => {
  it("a refused email leaves the row persisted and sends no second, fallback email", async () => {
    const send = vi.fn(async () => new Response("no", { status: 500 }));
    const { handler } = deliveryEntry(broken(), send);
    expect((await handler(cronRequest())).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ failure_count: 1, notified_at: null });
  });

  it("an unreachable database: the email alone, with its own text and a deployment-keyed hourly key", async () => {
    const settings = { ...broken(), DELIVERY_DATABASE_URL: "postgres://zs_service@127.0.0.1:1/postgres", VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "hub-preview.example.app" };
    const { handler, send } = deliveryEntry(settings);
    expect((await handler(cronRequest())).status).toBe(503);
    expect(createRuntimePool).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(callOf(send)[1].headers).toMatchObject({ "Idempotency-Key": "cron-alert:unrecorded:preview:hub-preview.example.app:delivery:2026-11-08T10:00:00.000Z" });
    const mail = mailBody(send);
    expect(mail.subject).toContain("failed to start (not recorded)");
    expect(mail.text).toContain("could not be written to cron_alerts");
    expect(mail.text).toContain("at most once an hour");
    expect(mail.text).not.toContain("closes by itself");
    expect(mail.text).not.toContain("SELECT job");
  });

  it("no database URL at all: no row, no pool, the email still goes, the answer is 503", async () => {
    const { handler, send, logs } = deliveryEntry({ ...broken(), DELIVERY_DATABASE_URL: undefined });
    expect((await handler(cronRequest())).status).toBe(503);
    expect(createRuntimePool).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes("has no usable DELIVERY_DATABASE_URL"))).toBe(true);
  });

  const refused: Array<[string, Settings]> = [
    ["a hosted host with no DATABASE_CA_CERT", { DELIVERY_DATABASE_URL: "postgres://svc:pw@db.example.co:5432/postgres" }],
    ["a CA that is not a certificate, on a loopback host", { DATABASE_CA_CERT: "not a certificate" }],
    ["an empty CA, on a loopback host", { DATABASE_CA_CERT: "" }],
    ["a URL with options", { DELIVERY_DATABASE_URL: "postgres://zs_service@127.0.0.1:55432/postgres?sslmode=disable" }],
  ];
  it.each(refused)("never opens a connection for %s", async (_name, patch) => {
    const { handler, send } = deliveryEntry({ ...broken(), ...patch });
    expect((await handler(cronRequest())).status).toBe(503);
    expect(createRuntimePool).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1); // the email, not a database write
  });

  it("a recorder that throws does not mask the failure", async () => {
    const logs: string[] = [];
    const handler = guardFor({ CRON_SECRET, DELIVERY_WORKER: "maybe" }, () => { parseDeliveryEnv({ CRON_SECRET, DELIVERY_WORKER: "maybe" }); return { fetch: served }; },
      { ...idleAlerts, record: async () => { throw new Error("recorder exploded"); } }, { report: (line: string) => logs.push(line) });
    const response = await handler(cronRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "Unavailable", message: "delivery failed to start" } });
    expect(logs.some((line) => line.includes("DELIVERY_WORKER must be on or off"))).toBe(true);
    expect(logs.some((line) => line.includes("recorder exploded"))).toBe(true);
  });
});

describe("secret text stays out of the row, the email and every log line", () => {
  it("redacts a leaking build error everywhere", async () => {
    const leak = [
      "connect failed postgres://svc:hunter2pw@db.example.co:5432/postgres?x=1", "password=hunter2pw", RESEND_KEY, "Bearer abc.def-ghi", "ops@example.com",
      "re_abc-1234567890zz", "sb_secret_abcdefgh1234", "csk-abcdefgh1234",
    ].join(" ");
    const send = okMail();
    const settings: Settings = { ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl };
    const { alerts, logs } = alertsFor(settings, send);
    const handler = guardCronEntry({ job: "delivery", cronPath: "/cron/delivery", env: settings, clock, report: (line) => logs.push(line), startupAlerts: alerts, build: () => { throw new Error(leak); } });
    await handler(cronRequest());
    const texts = [(await rows())[0]!.last_error as string, mailBody(send).text as string, mailBody(send).subject as string, ...logs];
    expect(logs.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toMatch(/hunter2pw|k{24}|abc\.def|svc:|db\.example\.co|ops@example\.com|abc-1234567890|abcdefgh1234/);
    expect(texts[0]).toContain("CronStartupFailed");
  });

  it("does not turn a validation message into a secret", () => {
    expect(describeCronError(new Error("GOOGLE_TOKEN_PRIVATE_KEY: must be base64; X_SECRET: Invalid input: expected string"))).toBe(
      "Error: GOOGLE_TOKEN_PRIVATE_KEY: must be base64; X_SECRET: Invalid input: expected string",
    );
    expect(describeCronError(new Error("api_key: hunter2 and TOKEN=abc123"))).toBe("Error: api_key=<secret> and TOKEN=<secret>");
  });

  it("redacts hyphenated and Supabase-style tokens", () => {
    const text = describeCronError(new Error("re_abc-1234567890zz sb_secret_abcdefgh1234 csk-abcdefgh1234 sk-ant-abcdefghij"));
    expect(text).toBe("Error: <secret> <secret> <secret> <secret>");
  });

  it("starts a run clock the recorder can read (shared deadline)", () => {
    const run = startCronRun({ now: () => new Date() });
    expect(performance.now() - run.startedMonotonicMs).toBeLessThan(1_000);
  });
});
