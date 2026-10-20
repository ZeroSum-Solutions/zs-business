// The M3d delivery runner as the API deploys it (resend.md R-9): the environment it parses, the
// cron route Vercel calls, the time-budgeted run loop, and the production wiring end to end
// against Postgres with an injected fetch standing in for Resend. No network, no system clock.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemberRole } from "@zs/contracts";
import { createSession, creditWallet, type DeliveryReport, type DeliveryWorker, type EdgeDependencies, type StepResult } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { parseDeliveryEnv, PLACEHOLDER_CRON_SECRET } from "../src/delivery/config.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { createDeliveryRunner, createDeliveryWorkerFromEnv, type DeliveryRunner, type RunSummary } from "../src/delivery/runner.js";
import { PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET } from "../src/config.js";
import { UNSUBSCRIBE_SECRET } from "./helpers.js";

/** Synthetic secrets, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const RESEND_KEY = ["re", "test", "k".repeat(24)].join("_");
const TWILIO_ACCOUNT = `AC${"c3".repeat(16)}`;
const TWILIO_KEY_SID = `SK${"d4".repeat(16)}`;
const TWILIO_KEY_SECRET = ["twilio", "s".repeat(24)].join("-");
const DB_PASSWORD = ["pw", "d".repeat(20)].join("-");
const CA_CERT = ["-----BEGIN CERTIFICATE-----", "MIIBtest", "-----END CERTIFICATE-----"].join("\n");
const UNSUBSCRIBE_BASE = "https://api.example.test/public/v1/unsubscribe";
const LOCAL_DB = "postgres://postgres@127.0.0.1:55432/postgres";
const REMOTE_DB = `postgres://postgres:${DB_PASSWORD}@db.abcd.supabase.co:5432/postgres`;

const ON: Record<string, string> = {
  DELIVERY_WORKER: "on",
  DELIVERY_DATABASE_URL: LOCAL_DB,
  DELIVERY_PRICE_EMAIL: "2",
  DELIVERY_PRICE_SMS_SEGMENT: "3",
  UNSUBSCRIBE_TOKEN_SECRET: UNSUBSCRIBE_SECRET,
  DELIVERY_UNSUBSCRIBE_BASE_URL: UNSUBSCRIBE_BASE,
  RESEND_API_KEY: RESEND_KEY,
  RESEND_FROM: "Halden Rowe <hello@haldenrowe.example>",
};
const without = (name: string) => Object.fromEntries(Object.entries(ON).filter(([key]) => key !== name));
const errorOf = (env: Record<string, string | undefined>): string => {
  try {
    parseDeliveryEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseDeliveryEnv accepted the environment");
};

describe("parseDeliveryEnv", () => {
  it("runs nothing and needs nothing else while DELIVERY_WORKER is unset or off", () => {
    expect(parseDeliveryEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseDeliveryEnv({ DELIVERY_WORKER: "off" })).toEqual({ runner: null, cronSecret: null });
    // Broken runner variables do not matter while the switch is off.
    expect(parseDeliveryEnv({ DELIVERY_WORKER: "off", DELIVERY_DATABASE_URL: "not a url", DELIVERY_CLAIM_LIMIT: "999" }))
      .toEqual({ runner: null, cronSecret: null });
    expect(parseDeliveryEnv({ CRON_SECRET })).toEqual({ runner: null, cronSecret: CRON_SECRET });
  });

  it.each(["ON", "true", "1", "yes", ""])("refuses DELIVERY_WORKER=%j", (value) => {
    expect(() => parseDeliveryEnv({ ...ON, DELIVERY_WORKER: value })).toThrow(/DELIVERY_WORKER must be on or off/);
  });

  it("reads a complete environment with its defaults", () => {
    expect(parseDeliveryEnv({ ...ON, CRON_SECRET })).toEqual({
      cronSecret: CRON_SECRET,
      runner: {
        serviceDatabaseUrl: LOCAL_DB,
        databaseCaCert: undefined,
        workerId: "delivery",
        pricing: { currency: "usd", email: 2, smsSegment: 3 },
        unsubscribe: { secret: UNSUBSCRIBE_SECRET, baseUrl: UNSUBSCRIBE_BASE },
        resend: { apiKey: RESEND_KEY, from: ON.RESEND_FROM },
        twilio: null,
        budgetMs: 20_000,
        claimLimit: 2,
        providerTimeoutMs: 5_000,
        intervalMs: 15_000,
      },
    });
  });

  it("keeps SMS refused unless SMS_PROVIDER=twilio, and then needs the Twilio sender (twilio.md T-9)", () => {
    const twilio = {
      SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT, TWILIO_API_KEY_SID: TWILIO_KEY_SID,
      TWILIO_API_KEY_SECRET: TWILIO_KEY_SECRET, TWILIO_WEBHOOK_BASE_URL: "https://api.example.test",
    };
    // Twilio variables alone turn nothing on.
    expect(parseDeliveryEnv({ ...ON, ...twilio, SMS_PROVIDER: "none" }).runner?.twilio).toBeNull();
    expect(parseDeliveryEnv({ ...ON, TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT }).runner?.twilio).toBeNull();
    expect(parseDeliveryEnv({ ...ON, ...twilio }).runner?.twilio).toEqual({
      accountSid: TWILIO_ACCOUNT, apiKeySid: TWILIO_KEY_SID, apiKeySecret: TWILIO_KEY_SECRET, webhookBaseUrl: "https://api.example.test",
    });
    expect(errorOf({ ...ON, SMS_PROVIDER: "sms" })).toMatch(/SMS_PROVIDER/);
    const missing = errorOf({ ...ON, SMS_PROVIDER: "twilio", TWILIO_WEBHOOK_BASE_URL: "https://api.example.test" });
    expect(missing).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(errorOf({ ...ON, ...twilio, TWILIO_API_KEY_SECRET: undefined })).toMatch(/TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET/);
    const plain = errorOf({ ...ON, ...twilio, TWILIO_WEBHOOK_BASE_URL: "http://api.example.test" });
    expect(plain).toMatch(/TWILIO_WEBHOOK_BASE_URL/);
    expect(plain).not.toContain(TWILIO_KEY_SECRET);
  });

  it.each([
    "DELIVERY_DATABASE_URL", "DELIVERY_PRICE_EMAIL", "DELIVERY_PRICE_SMS_SEGMENT", "UNSUBSCRIBE_TOKEN_SECRET",
    "DELIVERY_UNSUBSCRIBE_BASE_URL", "RESEND_API_KEY", "RESEND_FROM",
  ])("with the switch on, requires %s", (name) => {
    expect(errorOf(without(name))).toMatch(new RegExp(`Invalid environment: .*${name}`));
  });

  it("refuses prices that are not positive whole minor units", () => {
    for (const value of ["0", "-1", "1.5", "abc", "1000001"])
      expect(errorOf({ ...ON, DELIVERY_PRICE_EMAIL: value })).toMatch(/DELIVERY_PRICE_EMAIL/);
  });

  it("takes the unsubscribe base URL over https only", () => {
    for (const value of ["http://api.example.test/public/v1/unsubscribe", "ftp://api.example.test/u", "/public/v1/unsubscribe"])
      expect(errorOf({ ...ON, DELIVERY_UNSUBSCRIBE_BASE_URL: value })).toMatch(/DELIVERY_UNSUBSCRIBE_BASE_URL/);
  });

  it("refuses a short or placeholder UNSUBSCRIBE_TOKEN_SECRET", () => {
    expect(errorOf({ ...ON, UNSUBSCRIBE_TOKEN_SECRET: "too-short" })).toMatch(/UNSUBSCRIBE_TOKEN_SECRET must be at least 32/);
    expect(errorOf({ ...ON, UNSUBSCRIBE_TOKEN_SECRET: PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET })).toMatch(/placeholder/);
  });

  it("needs DATABASE_CA_CERT for a database that is not on loopback", () => {
    expect(errorOf({ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB })).toMatch(/DATABASE_CA_CERT is required/);
    expect(errorOf({ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: "not a certificate" })).toMatch(/DATABASE_CA_CERT/);
    expect(parseDeliveryEnv({ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }).runner)
      .toMatchObject({ serviceDatabaseUrl: REMOTE_DB, databaseCaCert: CA_CERT });
    for (const loopback of ["postgres://postgres@localhost:55432/postgres", "postgres://postgres@[::1]:55432/postgres", "postgres://postgres@LOCALHOST/postgres"])
      expect(parseDeliveryEnv({ ...ON, DELIVERY_DATABASE_URL: loopback }).runner).toMatchObject({ databaseCaCert: undefined });
  });

  it("refuses a query string that would replace the pinned TLS settings", () => {
    expect(errorOf({ ...ON, DELIVERY_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    expect(errorOf({ ...ON, DELIVERY_DATABASE_URL: `${LOCAL_DB}?sslmode=disable`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    // A query `host` that points away from loopback counts as the host.
    expect(errorOf({ ...ON, DELIVERY_DATABASE_URL: `${LOCAL_DB}?host=db.abcd.supabase.co` })).toMatch(/DATABASE_CA_CERT is required/);
    // Plain local development may pass options on a loopback URL.
    expect(parseDeliveryEnv({ ...ON, DELIVERY_DATABASE_URL: `${LOCAL_DB}?sslmode=disable` }).runner).not.toBeNull();
  });

  it("refuses a claim limit whose provider waits could outlast the run budget", () => {
    expect(errorOf({ ...ON, DELIVERY_CLAIM_LIMIT: "5" })).toMatch(/DELIVERY_CLAIM_LIMIT × DELIVERY_PROVIDER_TIMEOUT_MS/);
    expect(errorOf({ ...ON, DELIVERY_RUN_BUDGET_MS: "9999" })).toMatch(/must fit in DELIVERY_RUN_BUDGET_MS/);
    expect(parseDeliveryEnv({ ...ON, DELIVERY_CLAIM_LIMIT: "4" }).runner).toMatchObject({ claimLimit: 4, budgetMs: 20_000 });
    expect(parseDeliveryEnv({ ...ON, DELIVERY_CLAIM_LIMIT: "10", DELIVERY_PROVIDER_TIMEOUT_MS: "2000" }).runner)
      .toMatchObject({ claimLimit: 10, providerTimeoutMs: 2_000 });
    for (const [name, value] of [["DELIVERY_CLAIM_LIMIT", "0"], ["DELIVERY_CLAIM_LIMIT", "51"], ["DELIVERY_PROVIDER_TIMEOUT_MS", "999"], ["DELIVERY_RUN_BUDGET_MS", "600001"]] as const)
      expect(errorOf({ ...ON, [name]: value })).toMatch(new RegExp(name));
  });

  it("refuses a short or placeholder CRON_SECRET, with the switch on or off", () => {
    for (const env of [{}, ON]) {
      expect(errorOf({ ...env, CRON_SECRET: "short-cron" })).toMatch(/CRON_SECRET must be at least 32 characters/);
      expect(errorOf({ ...env, CRON_SECRET: PLACEHOLDER_CRON_SECRET })).toMatch(/CRON_SECRET is still the .env.example placeholder/);
    }
  });

  it("never puts a secret value in an error message", () => {
    const shortCron = ["cron", "s".repeat(10)].join("-");
    const shortUnsubscribe = ["unsub", "t".repeat(10)].join("-");
    const badKey = ["re", "bad key", "k".repeat(10)].join("_");
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...ON, CRON_SECRET: shortCron }, shortCron],
      [{ CRON_SECRET: shortCron }, shortCron],
      [{ ...ON, UNSUBSCRIBE_TOKEN_SECRET: shortUnsubscribe }, shortUnsubscribe],
      [{ ...ON, RESEND_API_KEY: badKey }, badKey],
      [{ ...ON, RESEND_API_KEY: "re_k" }, "re_k"],
      [{ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB }, DB_PASSWORD],
      [{ ...ON, DELIVERY_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }, DB_PASSWORD],
      [{ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT, DELIVERY_CLAIM_LIMIT: "50" }, DB_PASSWORD],
      [{ ...ON, DELIVERY_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: "MIIB-not-a-pem-" + "x".repeat(10) }, "MIIB-not-a-pem-"],
    ];
    for (const [env, secret] of cases) {
      const message = errorOf(env);
      expect(message).toMatch(/^Invalid environment/);
      expect(message).not.toContain(secret);
      // Nor any of the valid secrets that sat beside the bad one.
      for (const other of [UNSUBSCRIBE_SECRET, RESEND_KEY, CRON_SECRET]) expect(message).not.toContain(other);
    }
  });
});

const summary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  passes: 1, ingested: 0, claimed: 0, sent: 0, retried: 0, blocked: 0, dead: 0, errors: 0, budgetSpent: false, ...overrides,
});
const stubRunner = (run: () => Promise<RunSummary>) => {
  const fn = vi.fn(run);
  return { runner: { run: fn } satisfies DeliveryRunner, run: fn };
};
const cron = (config: Parameters<typeof cronRoutes>[0], authorization?: string) =>
  cronRoutes(config).request("/cron/delivery", authorization === undefined ? {} : { headers: { Authorization: authorization } });

describe("GET /cron/delivery", () => {
  it("is not found while CRON_SECRET is unset, and never runs", async () => {
    const { runner, run } = stubRunner(async () => summary());
    const response = await cron({ cronSecret: null, runner }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NotFound" } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty header", ""],
    ["the bare secret", CRON_SECRET],
    ["a wrong secret", `Bearer ${CRON_SECRET.slice(0, -1)}x`],
    ["a longer secret", `Bearer ${CRON_SECRET}x`],
    ["another scheme", `Basic ${CRON_SECRET}`],
    ["a lower-case scheme", `bearer ${CRON_SECRET}`],
  ])("answers 401 to %s and never runs", async (_label, authorization) => {
    const { runner, run } = stubRunner(async () => summary());
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner, onError }, authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "Unauthorized" } });
    expect(run).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("answers 200 without running while the kill switch is off", async () => {
    const response = await cron({ cronSecret: CRON_SECRET, runner: null }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: false, reason: "DELIVERY_WORKER is off" });
  });

  it("answers 503 and reports the error when a run throws", async () => {
    const failure = new Error("database went away");
    const { runner, run } = stubRunner(async () => { throw failure; });
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner, onError }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "Unavailable" } });
    expect(JSON.stringify(body)).not.toContain("database went away");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("runs once and answers the summary, never cached", async () => {
    const result = summary({ passes: 2, ingested: 3, claimed: 3, sent: 2, blocked: 1 });
    const { runner, run } = stubRunner(async () => result);
    const response = await cron({ cronSecret: CRON_SECRET, runner }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: true, ...result });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers 404 to any other path", async () => {
    const { runner, run } = stubRunner(async () => summary());
    const response = await cronRoutes({ cronSecret: CRON_SECRET, runner })
      .request("/cron/other", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("createDeliveryRunner", () => {
  const START = Date.parse("2026-10-20T09:00:00.000Z");
  let now = START;
  const clock = { now: () => new Date(now) };
  beforeEach(() => { now = START; });

  type Pass = { claimed: number; results?: StepResult[]; ingested?: number; takesMs?: number };
  /** A worker that answers the given passes in order, moving the clock by each pass's `takesMs`. */
  function stubWorker(passes: Pass[], providerTimeoutMs = 1_000) {
    const calls: Array<{ claimLimit?: number }> = [];
    const worker = {
      config: { providerTimeoutMs },
      async runOnce(options: { claimLimit?: number } = {}) {
        calls.push(options);
        const pass = passes[calls.length - 1];
        if (!pass) throw new Error("runOnce called more often than the test expected");
        now += pass.takesMs ?? 0;
        return { ingested: pass.ingested ?? 0, duplicates: 0, invalid: 0, claimed: pass.claimed, results: pass.results ?? [] };
      },
    };
    return { worker: worker as unknown as DeliveryWorker, calls };
  }
  const sent = (n: number): StepResult[] => Array.from({ length: n }, (_, i) => ({ outcome: "sent", providerMessageId: `m${i}` }));

  it("stops after a pass that claims fewer than the limit", async () => {
    const { worker, calls } = stubWorker([{ claimed: 1, ingested: 2, results: sent(1) }]);
    const result = await createDeliveryRunner({ worker, clock, budgetMs: 20_000, claimLimit: 3 }).run();
    expect(calls).toEqual([{ claimLimit: 3 }]);
    expect(result).toEqual(summary({ passes: 1, ingested: 2, claimed: 1, sent: 1 }));
  });

  it("runs one pass when nothing is due", async () => {
    const { worker, calls } = stubWorker([{ claimed: 0 }]);
    expect(await createDeliveryRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run())
      .toEqual(summary({ passes: 1 }));
    expect(calls).toHaveLength(1);
  });

  it("keeps going while passes come back full", async () => {
    const { worker, calls } = stubWorker([
      { claimed: 2, ingested: 5, results: sent(2) },
      { claimed: 2, results: sent(2) },
      { claimed: 1, results: sent(1) },
    ]);
    const result = await createDeliveryRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run();
    expect(calls).toHaveLength(3);
    expect(result).toEqual(summary({ passes: 3, ingested: 5, claimed: 5, sent: 5 }));
  });

  it("stops before a pass that could outlast the budget, and says the budget is spent", async () => {
    // claimLimit 2 × timeout 1s = 2s per pass; a 5s budget.
    const { worker, calls } = stubWorker([
      { claimed: 2, results: sent(2), takesMs: 1_500 }, // 1.5s in: 1.5 + 2 <= 5, go on
      { claimed: 2, results: sent(2), takesMs: 1_600 }, // 3.1s in: 3.1 + 2 > 5, stop
      { claimed: 2, results: sent(2) },
    ]);
    const result = await createDeliveryRunner({ worker, clock, budgetMs: 5_000, claimLimit: 2 }).run();
    expect(calls).toHaveLength(2);
    expect(result).toEqual(summary({ passes: 2, claimed: 4, sent: 4, budgetSpent: true }));
  });

  it("starts a pass that ends exactly on the budget", async () => {
    const { worker, calls } = stubWorker([
      { claimed: 2, results: sent(2), takesMs: 3_000 }, // 3s in: 3 + 2 == 5, still fits
      { claimed: 1, results: sent(1), takesMs: 2_000 },
    ]);
    const result = await createDeliveryRunner({ worker, clock, budgetMs: 5_000, claimLimit: 2 }).run();
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ passes: 2, budgetSpent: false });
  });

  it("does not start at all when one pass could not fit the budget", async () => {
    const { worker, calls } = stubWorker([{ claimed: 0 }], 5_000);
    expect(await createDeliveryRunner({ worker, clock, budgetMs: 4_000, claimLimit: 1 }).run())
      .toEqual(summary({ passes: 0, budgetSpent: true }));
    expect(calls).toHaveLength(0);
  });

  it("sums the step results by outcome", async () => {
    const { worker } = stubWorker([
      {
        claimed: 4, ingested: 1, results: [
          { outcome: "sent", providerMessageId: "a" },
          { outcome: "retry", status: "uncertain", reason: "resend_500" },
          { outcome: "blocked", reason: "approval_revoked" },
          { outcome: "lost_lease" },
        ],
      },
      {
        claimed: 3, ingested: 2, results: [
          { outcome: "dead", reason: "outcome_unknown" },
          { outcome: "error", error: "boom" },
          { outcome: "retry", status: "pending", reason: "resend_429" },
        ],
      },
    ]);
    const result = await createDeliveryRunner({ worker, clock, budgetMs: 60_000, claimLimit: 4 }).run();
    expect(result).toEqual({
      passes: 2, ingested: 3, claimed: 7, sent: 1, retried: 2, blocked: 1, dead: 1, errors: 1, budgetSpent: false,
    });
  });

  it("lets a throwing pass fail the run", async () => {
    const worker = { config: { providerTimeoutMs: 1_000 }, runOnce: async () => { throw new Error("pool closed"); } } as unknown as DeliveryWorker;
    await expect(createDeliveryRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run()).rejects.toThrow("pool closed");
  });
});

describe("the production runner against Postgres", () => {
  const START = Date.parse("2026-10-20T09:00:00.000Z");
  let now = START;
  const clock = { now: () => new Date(now) };
  let database: TestDatabase;
  let fixture: TwoTenantFixture;
  let tenantId: string;
  let owner: string;
  let staff: string;
  type Request = { url: string; init: RequestInit; body: Record<string, unknown> };
  let requests: Request[];
  let reports: DeliveryReport[];
  let messageIds = 0;
  const fakeResend = async (url: string, init: RequestInit) => {
    requests.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    messageIds += 1;
    return new Response(JSON.stringify({ id: `re_msg_${messageIds}` }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const env = () => parseDeliveryEnv({ ...ON, CRON_SECRET, DELIVERY_WORKER_ID: "api-test" }).runner!;
  const runner = () => {
    const runnerEnv = env();
    const worker = createDeliveryWorkerFromEnv({
      env: runnerEnv, pool: database.servicePool, clock, generateId: randomUUID, fetch: fakeResend,
      report: (event) => reports.push(event),
    });
    return createDeliveryRunner({ worker, clock, budgetMs: runnerEnv.budgetMs, claimLimit: runnerEnv.claimLimit });
  };

  const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
  const sessionFor = (actorId: string) => createSession(deps(), { tenantId, actorId });
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
    service(async (tx) => (await tx.query(sql, params)).rows as T[]);

  async function addMember(role: MemberRole) {
    const userId = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
    ));
    return userId;
  }
  async function customer() {
    const email = `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const { result } = await sessionFor(owner).upsertContact({ displayName: "Halden Guest", email }, randomUUID());
    return { contactId: result.contact.id, email };
  }
  /** Staff drafts, an owner approves: the reply is `approved` and its send event is committed. */
  async function approvedReply(contactId: string, body = "Your table is ready at 7.") {
    const draft = await sessionFor(staff).draftReply({ contactId, subject: "Your booking", body }, randomUUID());
    const approved = await sessionFor(owner).approveReply(draft.result.id, {}, randomUUID());
    expect(approved.result.status).toBe("approved");
    const approval = (await rows<{ id: string }>(
      "SELECT id FROM approvals WHERE tenant_id=$1 AND target_type='inbox_reply' AND target_id=$2 AND status='approved'",
      [tenantId, draft.result.id]))[0]!;
    return { replyId: draft.result.id, approvalId: approval.id };
  }
  const reply = async (replyId: string) => (await rows<{ status: string; settled_at: Date | null }>(
    "SELECT status, settled_at FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, replyId]))[0]!;
  const delivery = async (replyId: string) => (await rows<{
    id: string; status: string; provider: string | null; provider_message_id: string | null; final_reason: string | null; attempts: number;
  }>("SELECT id, status, provider, provider_message_id, final_reason, attempts FROM message_deliveries WHERE tenant_id=$1 AND message_id=$2",
    [tenantId, replyId]))[0];
  const balance = async () => Number((await rows<{ balance: string }>("SELECT balance FROM wallets WHERE tenant_id=$1", [tenantId]))[0]!.balance);

  beforeAll(async () => {
    database = await createTestDatabase();
    fixture = await createTwoTenantFixture(database);
    tenantId = fixture.a.tenantId;
    owner = await addMember("owner");
    staff = await addMember("staff");
    await service((tx) => creditWallet(tx, {
      tenantId, ledgerId: randomUUID(), amount: 1_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(START),
    }));
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    now = START;
    requests = [];
    reports = [];
    // Each test starts with no unprocessed send event from an earlier one.
    await service((tx) => tx.query("UPDATE outbox SET processed_at=$1 WHERE processed_at IS NULL", [clock.now()]));
  });

  it("sends an owner-approved Inbox reply through Resend once and settles it as sent", async () => {
    const { contactId, email } = await customer();
    const { replyId } = await approvedReply(contactId);
    const before = await balance();
    now += 60_000;

    const first = await runner().run();
    expect(first).toEqual({ passes: 1, ingested: 1, claimed: 1, sent: 1, retried: 0, blocked: 0, dead: 0, errors: 0, budgetSpent: false });
    expect(reports).toEqual([]);
    expect(requests).toHaveLength(1);
    const row = await delivery(replyId);
    expect(row).toMatchObject({ status: "sent", provider: "resend", provider_message_id: "re_msg_" + messageIds, final_reason: null, attempts: 1 });

    const [request] = requests as [Request];
    expect(request.url).toBe("https://api.resend.com/emails");
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`zsd-${row!.id}`);
    expect(headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(request.body).toMatchObject({
      from: ON.RESEND_FROM,
      to: [email],
      subject: "Your booking",
      tags: [{ name: "zs_tenant", value: tenantId }, { name: "zs_delivery", value: row!.id }],
    });
    const mailHeaders = request.body.headers as Record<string, string>;
    expect(mailHeaders["List-Unsubscribe"]).toMatch(new RegExp(`^<${UNSUBSCRIBE_BASE.replaceAll(".", "\\.")}/[^/<>]+>$`));
    expect(mailHeaders["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(String(request.body.text).startsWith("Your table is ready at 7.")).toBe(true);

    expect(await reply(replyId)).toEqual({ status: "sent", settled_at: new Date(now) });
    expect(await balance()).toBe(before - 2);

    // Nothing is left to do: a second run neither resends, re-charges nor re-settles.
    const settledAt = now;
    now += 60_000;
    expect(await runner().run()).toMatchObject({ passes: 1, ingested: 0, claimed: 0, sent: 0 });
    expect(requests).toHaveLength(1);
    expect(await reply(replyId)).toEqual({ status: "sent", settled_at: new Date(settledAt) });
    expect(await balance()).toBe(before - 2);

    // Under the runtime role, tenant B sees none of it; tenant A sees its own delivery.
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM message_deliveries"))).rows).toEqual([]);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM inbox_replies"))).rows).toEqual([]);
    expect((await fixture.b.run((tx) => tx.query("SELECT delivery_id FROM message_delivery_attempts"))).rows).toEqual([]);
    expect((await fixture.a.run((tx) => tx.query("SELECT id FROM message_deliveries WHERE message_id=$1", [replyId]))).rows)
      .toEqual([{ id: row!.id }]);
  });

  it("blocks a reply whose approval was revoked before the run, and never calls Resend", async () => {
    const { contactId } = await customer();
    const { replyId, approvalId } = await approvedReply(contactId);
    await sessionFor(owner).revokeApproval(approvalId, { note: "Wrong customer" }, randomUUID());
    const before = await balance();
    now += 60_000;

    expect(await runner().run()).toMatchObject({ passes: 1, ingested: 1, claimed: 1, sent: 0, blocked: 1 });
    expect(requests).toHaveLength(0);
    expect(await delivery(replyId)).toMatchObject({ status: "blocked", final_reason: "approval_revoked", attempts: 0 });
    expect(await reply(replyId)).toMatchObject({ status: "failed" });
    expect(await balance()).toBe(before);
    expect((await fixture.b.run((tx) => tx.query("SELECT id FROM message_deliveries"))).rows).toEqual([]);
  });
});
