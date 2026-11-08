// A cron function that cannot start raises a cron alert: a bad configuration is recorded under the job with
// the CronStartupFailed kind, mailed once, and answered 503. Postgres is local; the Resend call is an injected fetch.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { parseDeliveryEnv } from "../src/delivery/config.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { createStartupRecorder, guardCronEntry, type CronHandler, type StartupRecorder } from "../src/cron-startup.js";

const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const RESEND_KEY = ["re", "test", "k".repeat(24)].join("_");
const MAIL = { OPS_ALERT_EMAIL: "ops@example.com", RESEND_API_KEY: RESEND_KEY, RESEND_FROM: "ZS Hub <alerts@hub.example>" };
const clock = { now: () => new Date("2026-11-08T10:30:00.000Z") };
const cronRequest = (headers: Record<string, string> = { Authorization: `Bearer ${CRON_SECRET}` }, path = "/cron/delivery", method = "GET") =>
  new Request(`https://workers.example${path}`, { method, headers });
type Settings = Record<string, string | undefined>;
let database: TestDatabase;
let serviceUrl: string;

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
});

const rows = async () => (await database.pool.query("SELECT * FROM cron_alerts ORDER BY job")).rows;
const okMail = () => vi.fn(async () => new Response('{"id":"em_1"}', { status: 200 }));
const mailBody = (send: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String(((send.mock.calls[call] as unknown as [string, RequestInit])[1]).body));

/** The delivery entry's real build step (the config parse and the cron route), over settings the test controls. */
function deliveryEntry(settings: Settings, send = okMail(), recorder?: StartupRecorder) {
  const report = vi.fn();
  const handler = guardCronEntry({
    job: "delivery",
    cronPath: "/cron/delivery",
    env: settings,
    clock,
    report,
    recordStartupFailure: recorder
      ?? createStartupRecorder({ env: settings, clock, databaseUrlVariable: "DELIVERY_DATABASE_URL", fetch: send as never, report: () => undefined }),
    build: () => cronRoutes({ cronSecret: parseDeliveryEnv(settings).cronSecret, runner: null }).fetch,
  });
  return { handler, send, report };
}
const broken = (): Settings => ({ ...MAIL, CRON_SECRET, DELIVERY_WORKER: "on", DELIVERY_DATABASE_URL: serviceUrl });

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

  it("records an invalid value (a CRON_SECRET that is too short)", async () => {
    const { handler } = deliveryEntry({ ...MAIL, CRON_SECRET: "short", DELIVERY_DATABASE_URL: serviceUrl });
    expect((await handler(cronRequest({ Authorization: "Bearer short" }))).status).toBe(503);
    expect((await rows())[0]!.last_error).toContain("CRON_SECRET must be at least 32 characters");
  });

  it("a repeat failing tick raises the count and mails nothing more", async () => {
    const { handler, send } = deliveryEntry(broken());
    await handler(cronRequest());
    await handler(cronRequest());
    expect((await rows())[0]).toMatchObject({ failure_count: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries the build on the next request after a failure", async () => {
    let attempts = 0;
    const served: CronHandler = () => new Response("ok", { status: 200 });
    const handler = guardCronEntry({
      job: "delivery", cronPath: "/cron/delivery", env: { CRON_SECRET }, clock, report: () => undefined,
      recordStartupFailure: async () => undefined,
      build: () => { attempts += 1; if (attempts === 1) throw new Error("database was down"); return served; },
    });
    expect((await handler(cronRequest())).status).toBe(503);
    expect((await handler(cronRequest())).status).toBe(200);
    expect((await handler(cronRequest())).status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("answers an unauthorised call 401 and a call with no CRON_SECRET 404, recording nothing", async () => {
    const { handler, send } = deliveryEntry(broken());
    expect((await handler(cronRequest({ Authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await handler(cronRequest({}))).status).toBe(401);
    const noSecret = deliveryEntry({ ...broken(), CRON_SECRET: undefined });
    expect((await noSecret.handler(cronRequest({}))).status).toBe(404);
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers another path of the same function 503 without recording an alert", async () => {
    const { handler } = deliveryEntry(broken());
    expect((await handler(cronRequest({ Authorization: `Bearer ${CRON_SECRET}` }, "/internal/connections/run", "POST"))).status).toBe(503);
    expect(await rows()).toEqual([]);
  });

  it("keeps secret text out of the alert, the email and the log line", async () => {
    const leak = `connect failed postgres://svc:hunter2pw@db.example.co:5432/postgres?x=1 password=hunter2pw ${RESEND_KEY} Bearer abc.def-ghi ops@example.com`;
    const send = okMail();
    const report = vi.fn();
    const settings: Settings = { ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl };
    const handler = guardCronEntry({
      job: "delivery", cronPath: "/cron/delivery", env: settings, clock, report,
      recordStartupFailure: createStartupRecorder({ env: settings, clock, databaseUrlVariable: "DELIVERY_DATABASE_URL", fetch: send as never, report: () => undefined }),
      build: () => { throw new Error(leak); },
    });
    await handler(cronRequest());
    const stored = (await rows())[0]!.last_error as string;
    const sentText = mailBody(send).text as string;
    const logged = String(report.mock.calls[0]![0]);
    for (const text of [stored, sentText, logged]) {
      expect(text).not.toMatch(/hunter2pw|k{24}|abc\.def|svc:|db\.example\.co/);
      expect(text).toContain("CronStartupFailed");
    }
  });

  it("does not mask the failure when the recorder itself throws", async () => {
    const { handler, report } = deliveryEntry({ CRON_SECRET, DELIVERY_WORKER: "maybe" }, undefined, async () => { throw new Error("recorder exploded"); });
    const response = await handler(cronRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "Unavailable", message: "delivery failed to start" } });
    const lines = report.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("DELIVERY_WORKER must be on or off"))).toBe(true);
    expect(lines.some((line) => line.includes("recorder exploded"))).toBe(true);
  });

  it("falls back to the email alone when the alert row cannot be written (database unreachable)", async () => {
    const { handler, send } = deliveryEntry({ ...broken(), DELIVERY_DATABASE_URL: "postgres://zs_service@127.0.0.1:1/postgres" });
    expect((await handler(cronRequest())).status).toBe(503);
    expect(await rows()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(((send.mock.calls[0] as unknown as [string, RequestInit])[1]).headers).toMatchObject({ "Idempotency-Key": "cron-alert:delivery:2026-11-08T10:00:00.000Z" });
    expect(mailBody(send).text).toContain("CronStartupFailed");
  });

  it("with no database URL at all the row is not written, the email still goes, and the answer is 503", async () => {
    const { handler, send } = deliveryEntry({ ...broken(), DELIVERY_DATABASE_URL: undefined });
    expect((await handler(cronRequest())).status).toBe(503);
    expect(await rows()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never opens an unpinned connection to a hosted database", async () => {
    // No DATABASE_CA_CERT and a non-loopback host: the row is skipped (a write would have failed to resolve), the email goes.
    const { handler, send } = deliveryEntry({ ...broken(), DELIVERY_DATABASE_URL: "postgres://svc:pw@db.example.co:5432/postgres" });
    expect((await handler(cronRequest())).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([]);
  });

  it("serves a good start unchanged and raises no alert", async () => {
    const { handler, send } = deliveryEntry({ ...MAIL, CRON_SECRET, DELIVERY_DATABASE_URL: serviceUrl });
    const response = await handler(cronRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ran: false });
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
