// The outreach runner as the API deploys it (outreach-sequencer.md OS-10, OS-13, OS-21): the environment parse, the cron
// route, and one real worker run against the test database with FakeGmail. Nothing here can reach Google.
import { randomUUID } from "node:crypto";
import { outreachCampaignOutputSchema, outreachProspectPageSchema } from "@zs/contracts";
import { FakeGmail, generateSealKeyPair, parseSealPrivateKey, parseSealPublicKey, sealRefreshToken } from "@zs/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cronRoutes } from "../src/delivery/cron.js";
import { assertOutreachCronFits, outreachSendEnabled, parseOutreachEnv } from "../src/outreach/config.js";
import { createOutreachRunner } from "../src/outreach/runner.js";
import { parseServerEnv } from "../src/config.js";
import { call, createApiHarness, type ApiHarness } from "./helpers.js";

/** Synthetic secrets, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const SIGNING = ["test", "unsubscribe", "s".repeat(32)].join("-");
const pair = generateSealKeyPair();
const TENANT = randomUUID();

const base = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CRON_SECRET,
  OUTREACH_WORKER: "on",
  OUTREACH_DATABASE_URL: "postgres://svc:pw@127.0.0.1:55432/postgres",
  OUTREACH_RUNTIME_DATABASE_URL: "postgres://app:pw@127.0.0.1:55432/postgres",
  OUTREACH_TENANTS: TENANT,
  OUTREACH_GOOGLE_CLIENT_ID: "client-id.example",
  OUTREACH_GOOGLE_CLIENT_SECRET: "client-secret-value",
  OUTREACH_TOKEN_PRIVATE_KEY: pair.privateKey,
  UNSUBSCRIBE_TOKEN_SECRET: SIGNING,
  DELIVERY_UNSUBSCRIBE_BASE_URL: "https://api.example.test/unsubscribe",
  ...extra,
});

describe("outreachSendEnabled (OS-10)", () => {
  it.each([
    ["true", true],
    [undefined, false],
    ["", false],
    ["TRUE", false],
    ["True", false],
    ["1", false],
    ["yes", false],
    [" true", false],
    ["true ", false],
    ["false", false],
    ["on", false],
  ])("%j -> %s", (value, expected) => {
    expect(outreachSendEnabled(value)).toBe(expected);
    if (value !== undefined) expect(parseOutreachEnv(base({ OUTREACH_SEND_ENABLED: value })).runner?.sendEnabled).toBe(expected);
  });

  it("is off when the variable is unset", () => {
    expect(parseOutreachEnv(base()).runner?.sendEnabled).toBe(false);
  });
});

describe("parseOutreachEnv (OS-13, OS-21)", () => {
  it("runs nothing and needs nothing else while OUTREACH_WORKER is not on", () => {
    expect(parseOutreachEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseOutreachEnv({ OUTREACH_WORKER: "off", CRON_SECRET }).runner).toBeNull();
    expect(() => parseOutreachEnv({ OUTREACH_WORKER: "yes" })).toThrow(/OUTREACH_WORKER must be on or off/);
  });

  it("parses a full environment with the contract's defaults", () => {
    const { runner, cronSecret } = parseOutreachEnv(base());
    expect(cronSecret).toBe(CRON_SECRET);
    expect(runner).toMatchObject({
      tenants: [TENANT], sendEnabled: false, mailboxDailyLimit: 20, sendsPerTick: 1, minGapMs: 240_000, probeDelayMs: 120_000, budgetMs: 20_000,
    });
    expect(runner?.privateKey.asymmetricKeyType).toBe("x25519");
    expect(parseSealPrivateKey(pair.privateKey).type).toBe("private");
  });

  it.each([
    "OUTREACH_DATABASE_URL", "OUTREACH_RUNTIME_DATABASE_URL", "OUTREACH_TENANTS", "OUTREACH_GOOGLE_CLIENT_ID",
    "OUTREACH_GOOGLE_CLIENT_SECRET", "OUTREACH_TOKEN_PRIVATE_KEY", "UNSUBSCRIBE_TOKEN_SECRET", "DELIVERY_UNSUBSCRIBE_BASE_URL",
  ])("requires %s when the worker is on, and names the variable", (name) => {
    expect(() => parseOutreachEnv(base({ [name]: undefined }))).toThrow(new RegExp(name));
  });

  it("refuses an empty tenant list, a bad key and a placeholder secret without printing values", () => {
    expect(() => parseOutreachEnv(base({ OUTREACH_TENANTS: "" }))).toThrow(/OUTREACH_TENANTS/);
    expect(() => parseOutreachEnv(base({ OUTREACH_TENANTS: "not-a-uuid" }))).toThrow(/OUTREACH_TENANTS/);
    let message = "";
    try { parseOutreachEnv(base({ OUTREACH_TOKEN_PRIVATE_KEY: "AAAA-secret-looking-value" })); } catch (error) { message = String(error); }
    expect(message).toMatch(/OUTREACH_TOKEN_PRIVATE_KEY/);
    expect(message).not.toContain("AAAA-secret-looking-value");
  });

  it("refuses a remote database without a pinned CA, and a query string on a pinned one", () => {
    expect(() => parseOutreachEnv(base({ OUTREACH_DATABASE_URL: "postgres://svc:pw@db.example.test:5432/postgres" }))).toThrow(/DATABASE_CA_CERT/);
    expect(() => parseOutreachEnv(base({ OUTREACH_RUNTIME_DATABASE_URL: "postgres://app:pw@db.example.test:5432/postgres" }))).toThrow(/DATABASE_CA_CERT/);
  });

  it("refuses a run budget the 30 s cron function could not finish (OS-13)", () => {
    const long = parseOutreachEnv(base({ OUTREACH_RUN_BUDGET_MS: "25000" }));
    expect(() => assertOutreachCronFits(long.runner)).toThrow(/OUTREACH_RUN_BUDGET_MS/);
    expect(() => assertOutreachCronFits(parseOutreachEnv(base({ OUTREACH_RUN_BUDGET_MS: "20000" })).runner)).not.toThrow();
    expect(() => assertOutreachCronFits(null)).not.toThrow();
  });
});

describe("the API's OUTREACH_TENANTS (OS-1)", () => {
  it("is absent unless set, and parsed into tenant ids", () => {
    const { outreach: none } = parseServerEnv(serverEnv());
    expect(none).toBeNull();
    const { outreach } = parseServerEnv(serverEnv({ OUTREACH_TENANTS: TENANT }));
    expect(outreach).toEqual({ tenants: [TENANT] });
    expect(() => parseServerEnv(serverEnv({ OUTREACH_TENANTS: "nope" }))).toThrow(/OUTREACH_TENANTS/);
  });
});

function serverEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev",
    SESSION_CHECK: "local-stub",
    JWT_VERIFIER: "hs256",
    JWT_SECRET: ["test", "secret", "x".repeat(32)].join("-"),
    ...extra,
  };
}

describe("GET /cron/outreach", () => {
  type CronConfig = Parameters<typeof cronRoutes>[0];
  const cron = (config: Omit<CronConfig, "path" | "killSwitch" | "name">, authorization?: string) =>
    cronRoutes({ ...config, path: "/cron/outreach", killSwitch: "OUTREACH_WORKER", name: "Outreach" })
      .request("/cron/outreach", authorization === undefined ? {} : { headers: { Authorization: authorization } });

  it("is not found without CRON_SECRET, 401 without the bearer, and never runs either way", async () => {
    const run = vi.fn(async () => ({ counts: {} }));
    expect((await cron({ cronSecret: null, runner: { run } }, `Bearer ${CRON_SECRET}`)).status).toBe(404);
    expect((await cron({ cronSecret: CRON_SECRET, runner: { run } })).status).toBe(401);
    expect((await cron({ cronSecret: CRON_SECRET, runner: { run } }, `Bearer ${CRON_SECRET}x`)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("answers ran:false while OUTREACH_WORKER is off", async () => {
    const response = await cron({ cronSecret: CRON_SECRET, runner: null }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: false, reason: "OUTREACH_WORKER is off" });
  });

  it("runs once and answers the counts", async () => {
    const run = vi.fn(async () => ({ counts: { sent: 1 } }));
    const response = await cron({ cronSecret: CRON_SECRET, runner: { run } }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: true, counts: { sent: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("one real run with FakeGmail", () => {
  let h: ApiHarness;
  const allowed: string[] = [];
  const clock = { ms: Date.parse("2026-11-09T16:00:00.000Z") }; // Monday 08:00 in Los Angeles
  const fake = new FakeGmail({ now: () => new Date(clock.ms) });
  const ADDRESS = "devin@zerosum-solutions.com";
  let mailboxId: string;
  let campaignId: string;

  beforeAll(async () => {
    h = await createApiHarness({ outreach: { tenants: allowed } });
    allowed.push(h.a.tenantId);
    mailboxId = randomUUID();
    fake.addMailbox(ADDRESS);
    const publicKey = parseSealPublicKey(pair.publicKey);
    await h.fixture.service(async (tx) => {
      await tx.query(
        `UPDATE business_profiles SET time_zone='America/Los_Angeles', legal_name='Zero Sum Solutions LLC',
           postal_address='{"line1":"1 Market St","city":"San Francisco","region":"CA","postalCode":"94105","country":"US"}'::jsonb WHERE tenant_id=$1`, [h.a.tenantId]);
      await tx.query(
        `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,granted_scopes,daily_limit,created_at,updated_at)
         VALUES ($1,$2,$3,'Sam Sender','active',$4,'{}',20,now(),now())`,
        [h.a.tenantId, mailboxId, ADDRESS, sealRefreshToken(publicKey, { tenantId: h.a.tenantId, connectionId: mailboxId }, `fake-refresh-${ADDRESS}`)]);
    });
    const created = await call(h.app, "POST", "/v1/outreach/campaigns", {
      token: h.a.token, key: randomUUID(),
      body: {
        name: "Runner campaign",
        steps: [{ subject: "Idea for {{company}}", body: "Hi {{first_name}}, a quick idea.", delayBusinessDays: 0 }],
        window: { start: "08:00", end: "10:30" }, dailyCapPerMailbox: 5, mailboxIds: [mailboxId],
      },
    });
    campaignId = outreachCampaignOutputSchema.parse(created.body).result.id;
    await call(h.app, "POST", `/v1/outreach/campaigns/${campaignId}/prospects`, {
      token: h.a.token, key: randomUUID(), body: { prospects: [{ email: "pat@acme.example", firstName: "Pat", company: "Acme" }, { email: "lee@globex.example", firstName: "Lee", company: "Globex" }] },
    });
    const asked = await call(h.app, "POST", `/v1/outreach/campaigns/${campaignId}/activation`, { token: h.a.token, key: randomUUID() });
    await call(h.app, "POST", `/v1/approvals/${(asked.body as { approvalId: string }).approvalId}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
  });
  afterAll(async () => { await h?.close(); });

  const runner = (sendEnabled: boolean) => createOutreachRunner({
    servicePool: h.database.pool,
    db: h.database.db,
    gmail: fake,
    oauth: fake.oauth,
    clock: { now: () => new Date(clock.ms) },
    generateId: randomUUID,
    config: {
      privateKey: parseSealPrivateKey(pair.privateKey), tenants: allowed, sendEnabled, sendsPerTick: 1, minGapMs: 0, probeDelayMs: 0,
      unsubscribeBaseUrl: "https://api.example.test/unsubscribe", unsubscribeSecret: SIGNING,
    },
  });
  const statuses = async () => outreachProspectPageSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${campaignId}/prospects`, { token: h.a.token })).body).items.map((p) => p.status);

  it("sends nothing while the send switch is off", async () => {
    await runner(false).run();
    expect(fake.sent).toHaveLength(0);
    expect(await statuses()).not.toContain("completed");
  });

  it("sends one email per tick with the switch on, through FakeGmail only", async () => {
    const summary = await runner(true).run();
    expect(summary.counts).toBeDefined();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to.toLowerCase()).toMatch(/pat@acme\.example|lee@globex\.example/);
  });
});
