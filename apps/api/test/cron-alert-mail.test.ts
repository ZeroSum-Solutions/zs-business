// The operator email: one on a new alert, one on a reopen, none on a repeat; unset address skips;
// a send error never reaches the cron. Postgres is local; the Resend call is an injected fetch.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { createOpsAlertMailer } from "../src/cron-alert-mail.js";
import { createCronAlerts, listOpenCronAlerts, type ServiceRun } from "../src/cron-alerts.js";
import { cronRoutes } from "../src/delivery/cron.js";

const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const authed = { headers: { Authorization: `Bearer ${CRON_SECRET}` } };
const ENV = {
  OPS_ALERT_EMAIL: "ops@example.com",
  RESEND_API_KEY: ["re", "test", "k".repeat(24)].join("_"),
  RESEND_FROM: "ZS Hub <alerts@hub.example>",
};
let database: TestDatabase;
let now = Date.parse("2026-11-08T10:00:00.000Z");
const clock = { now: () => new Date(now) };
const minutes = (count: number) => { now += count * 60_000; };
const service: ServiceRun = (work) => asService(database.pool, work);

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

function wired(env: Record<string, string | undefined>, reply: () => Promise<Response> = async () => new Response('{"id":"em_1"}', { status: 200 })) {
  const sent = vi.fn(reply);
  const log = vi.fn();
  const mailer = createOpsAlertMailer({ env, fetch: sent as never, report: log });
  return { sent, log, a: createCronAlerts({ service, clock, report: () => undefined, notify: mailer }) };
}
const bodyOf = (sent: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((sent.mock.calls[call]![1] as RequestInit).body));

describe("the operator email on a new or reopened alert", () => {
  it("sends one email on the first failure, through the Resend sender", async () => {
    const { sent, a } = wired(ENV);
    await a.failed("billing", new Error("pool exhausted"));
    expect(sent).toHaveBeenCalledTimes(1);
    const [url, init] = sent.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ENV.RESEND_API_KEY}`);
    expect(headers["Idempotency-Key"]).toBe("cron-alert:billing:2026-11-08T10:00:00.000Z");
    expect(bodyOf(sent)).toMatchObject({ from: ENV.RESEND_FROM, to: ["ops@example.com"], subject: '[ZS Hub] Cron job "billing" is failing' });
    expect(bodyOf(sent).text).toContain("Error: pool exhausted");
  });

  it("sends nothing on a repeat failure", async () => {
    const { sent, a } = wired(ENV);
    await a.failed("billing", new Error("x"));
    minutes(5);
    await a.failed("billing", new Error("x"));
    minutes(5);
    await a.failed("billing", new Error("x"));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("sends again when an alert reopens after a good run, and per job", async () => {
    const { sent, a } = wired(ENV);
    await a.failed("billing", new Error("x"));
    minutes(5);
    await a.succeeded("billing");
    minutes(5);
    await a.failed("billing", new Error("again"));
    expect(sent).toHaveBeenCalledTimes(2);
    expect(bodyOf(sent, 1).text).toContain("Error: again");
    await a.failed("delivery", new Error("y"));
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it("skips sending when OPS_ALERT_EMAIL is unset, and logs that once", async () => {
    const { sent, log, a } = wired({ ...ENV, OPS_ALERT_EMAIL: undefined });
    await a.failed("billing", new Error("x"));
    await a.failed("delivery", new Error("y"));
    expect(sent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("OPS_ALERT_EMAIL is not set");
    expect(await listOpenCronAlerts(service)).toHaveLength(2);
  });

  it("skips a malformed address and unusable Resend settings", async () => {
    const bad = wired({ ...ENV, OPS_ALERT_EMAIL: "a@example.com, b@example.com" });
    await bad.a.failed("billing", new Error("x"));
    expect(bad.sent).not.toHaveBeenCalled();
    expect(bad.log).toHaveBeenCalledTimes(1);

    const noResend = wired({ OPS_ALERT_EMAIL: "ops@example.com" });
    await noResend.a.failed("calendar", new Error("x"));
    expect(noResend.sent).not.toHaveBeenCalled();
    expect(String(noResend.log.mock.calls[0]![0])).toContain("Resend settings are unusable");
  });

  it("swallows a send error: a thrown fetch, a refusal and a notifier that throws", async () => {
    const thrown = wired(ENV, async () => { throw new Error("network down"); });
    await expect(thrown.a.failed("billing", new Error("x"))).resolves.toBeUndefined();
    expect(String(thrown.log.mock.calls[0]![0])).toContain("not sent");

    const refused = wired(ENV, async () => new Response("{}", { status: 403 }));
    await expect(refused.a.failed("delivery", new Error("x"))).resolves.toBeUndefined();
    expect(String(refused.log.mock.calls[0]![0])).toContain("HTTP 403");

    const report = vi.fn();
    const hostile = createCronAlerts({ service, clock, report, notify: () => Promise.reject(new Error("hook bug")) });
    await expect(hostile.failed("calendar", new Error("x"))).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect((await listOpenCronAlerts(service)).map((alert) => alert.job).sort()).toEqual(["billing", "calendar", "delivery"]);
  });

  it("a send error does not change the cron's answer", async () => {
    const { a } = wired(ENV, async () => { throw new Error("network down"); });
    const app = cronRoutes({
      path: "/cron/billing", cronSecret: CRON_SECRET, alerts: a, onError: () => undefined,
      runner: { run: async () => { throw new Error("boom"); } },
    });
    const reply = await app.request("/cron/billing", authed);
    expect(reply.status).toBe(503);
    expect(await reply.json()).toMatchObject({ error: { code: "Unavailable" } });
  });

  it("does not email when the alert could not be written", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    const a = createCronAlerts({
      service: () => Promise.reject(new Error("db down")), clock, report: () => undefined,
      notify: createOpsAlertMailer({ env: ENV, fetch: sent as never, report: () => undefined }),
    });
    await a.failed("billing", new Error("x"));
    expect(sent).not.toHaveBeenCalled();
  });
});
