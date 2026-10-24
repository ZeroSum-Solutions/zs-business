// The scheduled follow-up runner as the API deploys it (agents.md G-13): the environment it parses,
// the cron route Vercel calls, the time-budgeted loop over due tenants, and the production wiring
// against Postgres with the fake model. No network, no system clock, no real model.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeFollowUpModel,
  createFollowUpAgent,
  createSession,
  createTemplateSession,
  signBookingKey,
  followUpRunId,
  scheduledRunKey,
  setGlobalAgentSwitch,
  type FollowUpAgent,
} from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { PLACEHOLDER_BOOKING_KEY_SECRET } from "../src/config.js";
import { parseFollowUpEnv, PLACEHOLDER_CRON_SECRET, type FollowUpRunnerEnv } from "../src/followup/config.js";
import { startFollowUpRunner } from "../src/followup/start.js";
import { followUpCronRoutes } from "../src/followup/cron.js";
import {
  createScheduledFollowUps,
  type ScheduledFollowUpReport,
  type ScheduledFollowUps,
} from "../src/followup/runner.js";
import { call, createApiHarness, KEY_SECRET, NOW, provisionPage, type ApiHarness, type PageSetup, type TenantSetup } from "./helpers.js";

/** Synthetic secrets, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const DB_PASSWORD = ["pw", "d".repeat(20)].join("-");
const CA_CERT = ["-----BEGIN CERTIFICATE-----", "MIIBtest", "-----END CERTIFICATE-----"].join("\n");
const LOCAL_RUNTIME = "postgres://zs_runtime@127.0.0.1:55432/postgres";
const LOCAL_SERVICE = "postgres://postgres@127.0.0.1:55432/postgres";
const REMOTE_DB = `postgres://postgres:${DB_PASSWORD}@db.abcd.supabase.co:5432/postgres`;
const HOUR = 3_600_000;
/** Synthetic vendor keys, built at runtime so secret scanners do not flag a literal. */
const CEREBRAS_KEY = ["csk", "e".repeat(24)].join("-");
const DEEPSEEK_KEY = ["sk", "f".repeat(24)].join("-");

const ON: Record<string, string> = {
  FOLLOWUP_AGENT: "on",
  FOLLOWUP_DATABASE_URL: LOCAL_RUNTIME,
  FOLLOWUP_SERVICE_DATABASE_URL: LOCAL_SERVICE,
  AGENT_MODEL_PERSONAL_DATA: "fake",
};
const without = (name: string) => Object.fromEntries(Object.entries(ON).filter(([key]) => key !== name));
const errorOf = (env: Record<string, string | undefined>): string => {
  try {
    parseFollowUpEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseFollowUpEnv accepted the environment");
};

describe("parseFollowUpEnv", () => {
  it("runs nothing and needs nothing else while FOLLOWUP_AGENT is unset or off", () => {
    expect(parseFollowUpEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseFollowUpEnv({ FOLLOWUP_AGENT: "off", FOLLOWUP_MODEL: "gpt", FOLLOWUP_DATABASE_URL: "not a url" }))
      .toEqual({ runner: null, cronSecret: null });
    expect(parseFollowUpEnv({ CRON_SECRET })).toEqual({ runner: null, cronSecret: CRON_SECRET });
  });

  it.each(["ON", "true", "1", "yes", ""])("refuses FOLLOWUP_AGENT=%j", (value) => {
    expect(() => parseFollowUpEnv({ ...ON, FOLLOWUP_AGENT: value })).toThrow(/FOLLOWUP_AGENT must be on or off/);
  });

  it("reads a complete environment with its defaults", () => {
    expect(parseFollowUpEnv({ ...ON, CRON_SECRET })).toEqual({
      cronSecret: CRON_SECRET,
      runner: {
        runtimeDatabaseUrl: LOCAL_RUNTIME,
        serviceDatabaseUrl: LOCAL_SERVICE,
        databaseCaCert: undefined,
        personalData: { provider: "fake" },
        noPersonalData: null,
        stallAfterMs: 900_000,
        slotMinutes: 60,
        maxCandidatesPerRun: 3,
        modelTimeoutMs: 5_000,
        budgetMs: 20_000,
        intervalMs: 300_000,
        templated: null,
      },
    });
  });

  describe("AGENT_TEMPLATED (G-19, G-20)", () => {
    const TEMPLATED = { ...ON, AGENT_TEMPLATED: "on", PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BASE_URL: "https://book.example.test//" };
    const templatedWithout = (name: string) => Object.fromEntries(Object.entries(TEMPLATED).filter(([key]) => key !== name));

    it("is off unless switched on, and then needs no booking key or base URL", () => {
      expect(parseFollowUpEnv(ON).runner?.templated).toBeNull();
      expect(parseFollowUpEnv({ ...ON, AGENT_TEMPLATED: "off", PUBLIC_BOOKING_KEY_SECRET: "short" }).runner?.templated).toBeNull();
      expect(errorOf({ ...ON, AGENT_TEMPLATED: "yes" })).toMatch(/Invalid environment: .*AGENT_TEMPLATED/);
    });

    it("reads the booking key, the trimmed base URL and the candidate cap when on", () => {
      expect(parseFollowUpEnv(TEMPLATED).runner?.templated).toEqual({
        bookingKeySecret: KEY_SECRET, publicBaseUrl: "https://book.example.test", maxCandidatesPerRun: 20,
      });
      expect(parseFollowUpEnv({ ...TEMPLATED, PUBLIC_BASE_URL: "http://localhost:8787", AGENT_TEMPLATED_MAX_CANDIDATES: "1000" }).runner?.templated)
        .toEqual({ bookingKeySecret: KEY_SECRET, publicBaseUrl: "http://localhost:8787", maxCandidatesPerRun: 1000 });
    });

    it("fails closed without a booking key, with a short or placeholder one, or without a base URL", () => {
      expect(errorOf(templatedWithout("PUBLIC_BOOKING_KEY_SECRET"))).toMatch(/Invalid environment: .*PUBLIC_BOOKING_KEY_SECRET/);
      expect(errorOf({ ...TEMPLATED, PUBLIC_BOOKING_KEY_SECRET: "short" })).toMatch(/Invalid environment: .*at least 32 characters/);
      const placeholder = errorOf({ ...TEMPLATED, PUBLIC_BOOKING_KEY_SECRET: PLACEHOLDER_BOOKING_KEY_SECRET });
      expect(placeholder).toMatch(/Invalid environment: .*PUBLIC_BOOKING_KEY_SECRET.*placeholder/);
      expect(errorOf(templatedWithout("PUBLIC_BASE_URL"))).toMatch(/Invalid environment: .*PUBLIC_BASE_URL/);
      expect(errorOf({ ...TEMPLATED, PUBLIC_BASE_URL: "ftp://book.example.test" })).toMatch(/Invalid environment: .*PUBLIC_BASE_URL/);
      expect(errorOf({ ...TEMPLATED, PUBLIC_BASE_URL: "not a url" })).toMatch(/Invalid environment: .*PUBLIC_BASE_URL/);
    });

    it("keeps the booking key out of its errors", () => {
      expect(errorOf({ ...TEMPLATED, PUBLIC_BASE_URL: "nope" })).not.toContain(KEY_SECRET);
    });

    it.each(["0", "1001", "2.5"])("refuses AGENT_TEMPLATED_MAX_CANDIDATES=%s", (value) => {
      expect(errorOf({ ...TEMPLATED, AGENT_TEMPLATED_MAX_CANDIDATES: value })).toMatch(/AGENT_TEMPLATED_MAX_CANDIDATES/);
    });
  });

  it.each(["FOLLOWUP_DATABASE_URL", "FOLLOWUP_SERVICE_DATABASE_URL", "AGENT_MODEL_PERSONAL_DATA"])("with the switch on, requires %s", (name) => {
    expect(errorOf(without(name))).toMatch(new RegExp(`Invalid environment: .*${name}`));
  });

  it("takes FOLLOWUP_MODEL as the older name of the personal-data lane, and refuses two that disagree", () => {
    const { AGENT_MODEL_PERSONAL_DATA: _lane, ...rest } = ON;
    expect(parseFollowUpEnv({ ...rest, FOLLOWUP_MODEL: "fake" }).runner?.personalData).toEqual({ provider: "fake" });
    expect(errorOf({ ...rest, FOLLOWUP_MODEL: "fake", AGENT_MODEL_PERSONAL_DATA: "cerebras", CEREBRAS_API_KEY: CEREBRAS_KEY })).toMatch(/disagree/);
  });

  it("builds the personal-data lane on Cerebras, with a priced default model, and keeps the key out of its errors", () => {
    const lane = { ...ON, AGENT_MODEL_PERSONAL_DATA: "cerebras", FOLLOWUP_DATABASE_URL: LOCAL_RUNTIME };
    expect(parseFollowUpEnv({ ...lane, CEREBRAS_API_KEY: CEREBRAS_KEY }).runner?.personalData)
      .toEqual({ provider: "cerebras", apiKey: CEREBRAS_KEY, model: "gpt-oss-120b" });
    expect(errorOf(lane)).toMatch(/CEREBRAS_API_KEY is required/);
    // A model with no price cannot run (G-15), so it does not start.
    const unpriced = errorOf({ ...lane, CEREBRAS_API_KEY: CEREBRAS_KEY, CEREBRAS_MODEL: "gpt-unpriced" });
    expect(unpriced).toMatch(/CEREBRAS_MODEL=gpt-unpriced has no price/);
    expect(unpriced).not.toContain(CEREBRAS_KEY);
  });

  it("refuses DeepSeek, and anything else, on the personal-data lane (G-18)", () => {
    for (const name of ["AGENT_MODEL_PERSONAL_DATA", "FOLLOWUP_MODEL"] as const) {
      const { AGENT_MODEL_PERSONAL_DATA: _lane, ...rest } = ON;
      expect(errorOf({ ...rest, [name]: "deepseek", DEEPSEEK_API_KEY: DEEPSEEK_KEY })).toMatch(new RegExp(`${name}: DeepSeek cannot serve the personal-data lane`));
      for (const value of ["anthropic", "openai", "FAKE", ""])
        expect(errorOf({ ...rest, [name]: value })).toMatch(new RegExp(`${name}: the personal-data lane takes fake or cerebras|AGENT_MODEL_PERSONAL_DATA is required`));
    }
  });

  it("builds the no-personal-data lane on DeepSeek only, and prices its model", () => {
    const lane = { ...ON, AGENT_MODEL_NO_PERSONAL_DATA: "deepseek" };
    expect(parseFollowUpEnv({ ...lane, DEEPSEEK_API_KEY: DEEPSEEK_KEY }).runner?.noPersonalData)
      .toEqual({ provider: "deepseek", apiKey: DEEPSEEK_KEY, model: "deepseek-flash" });
    expect(errorOf(lane)).toMatch(/DEEPSEEK_API_KEY is required/);
    expect(errorOf({ ...lane, DEEPSEEK_API_KEY: DEEPSEEK_KEY, DEEPSEEK_MODEL: "deepseek-unpriced" })).toMatch(/has no price/);
    expect(errorOf({ ...ON, AGENT_MODEL_NO_PERSONAL_DATA: "cerebras", CEREBRAS_API_KEY: CEREBRAS_KEY })).toMatch(/takes fake or deepseek/);
    expect(parseFollowUpEnv({ ...ON, AGENT_MODEL_NO_PERSONAL_DATA: "fake" }).runner?.noPersonalData).toEqual({ provider: "fake" });
  });

  it("runs the fake model only against loopback databases", () => {
    expect(errorOf({ ...ON, FOLLOWUP_SERVICE_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/the fake model runs only against loopback databases/);
    expect(errorOf({ ...ON, FOLLOWUP_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/the fake model runs only against loopback databases/);
    // A real lane is fine off loopback.
    expect(parseFollowUpEnv({
      ...ON, FOLLOWUP_DATABASE_URL: REMOTE_DB, FOLLOWUP_SERVICE_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT,
      AGENT_MODEL_PERSONAL_DATA: "cerebras", CEREBRAS_API_KEY: CEREBRAS_KEY,
    }).runner?.personalData.provider).toBe("cerebras");
  });

  it("closes a stalled run only after a run could no longer be working (G-16)", () => {
    expect(parseFollowUpEnv({ ...ON, AGENT_STALL_AFTER_MS: "60000" }).runner).not.toBeNull();
    expect(errorOf({ ...ON, FOLLOWUP_RUN_BUDGET_MS: "60000", AGENT_STALL_AFTER_MS: "60000" })).toMatch(/AGENT_STALL_AFTER_MS must exceed/);
    expect(errorOf({ ...ON, AGENT_STALL_AFTER_MS: "59999" })).toMatch(/AGENT_STALL_AFTER_MS/);
    expect(parseFollowUpEnv({ ...ON, AGENT_STALL_AFTER_MS: "120000" }).runner?.stallAfterMs).toBe(120_000);
  });

  it("pins TLS off loopback", () => {
    expect(errorOf({ ...ON, FOLLOWUP_DATABASE_URL: REMOTE_DB })).toMatch(/DATABASE_CA_CERT is required when FOLLOWUP_DATABASE_URL/);
    expect(errorOf({ ...ON, FOLLOWUP_SERVICE_DATABASE_URL: `${REMOTE_DB}?sslmode=disable`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/FOLLOWUP_SERVICE_DATABASE_URL must not carry a query string/);
  });

  it("refuses a tenant's worst case that cannot fit the budget, and out-of-range tuning", () => {
    expect(errorOf({ ...ON, FOLLOWUP_MAX_CANDIDATES: "5", FOLLOWUP_MODEL_TIMEOUT_MS: "5000", FOLLOWUP_RUN_BUDGET_MS: "20000" }))
      .toMatch(/FOLLOWUP_MAX_CANDIDATES × FOLLOWUP_MODEL_TIMEOUT_MS must fit/);
    expect(parseFollowUpEnv({ ...ON, FOLLOWUP_MAX_CANDIDATES: "4" }).runner?.maxCandidatesPerRun).toBe(4);
    for (const [name, value] of [
      ["FOLLOWUP_SLOT_MINUTES", "4"], ["FOLLOWUP_SLOT_MINUTES", "1441"], ["FOLLOWUP_MAX_CANDIDATES", "0"],
      ["FOLLOWUP_MODEL_TIMEOUT_MS", "999"], ["FOLLOWUP_RUN_BUDGET_MS", "600001"], ["FOLLOWUP_INTERVAL_MS", "1.5"],
    ] as const) expect(errorOf({ ...ON, [name]: value })).toMatch(new RegExp(name));
  });

  it("refuses a short or placeholder CRON_SECRET, whatever the switch", () => {
    expect(errorOf({ CRON_SECRET: "short" })).toMatch(/CRON_SECRET must be at least 32 characters/);
    expect(errorOf({ ...ON, CRON_SECRET: PLACEHOLDER_CRON_SECRET })).toMatch(/CRON_SECRET is still the .env.example placeholder/);
  });
});

describe("GET /cron/followup", () => {
  const summary = {
    slot: "2026-10-20T12:00:00.000Z", globalKilled: false, due: 1, finished: 1,
    drafted: 1, skipped: 0, stopped: 0, errors: 0, budgetSpent: false, stalled: 0,
  };
  const runner = (run: ScheduledFollowUps["run"]): ScheduledFollowUps => ({ run });
  const get = (app: ReturnType<typeof followUpCronRoutes>, authorization?: string) =>
    app.request("/cron/followup", authorization ? { headers: { Authorization: authorization } } : {});

  it("is not there without a CRON_SECRET", async () => {
    let calls = 0;
    const app = followUpCronRoutes({ cronSecret: null, runner: runner(async () => { calls += 1; return summary; }) });
    expect((await get(app, `Bearer ${CRON_SECRET}`)).status).toBe(404);
    expect(calls).toBe(0);
  });

  it("refuses a missing or wrong bearer before any work", async () => {
    let calls = 0;
    const app = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: runner(async () => { calls += 1; return summary; }) });
    for (const header of [undefined, CRON_SECRET, `Bearer ${CRON_SECRET}x`, `Basic ${CRON_SECRET}`]) {
      const response = await get(app, header);
      expect(response.status, String(header)).toBe(401);
    }
    expect(calls).toBe(0);
  });

  it("answers 200 without work while the switch is off", async () => {
    const response = await get(followUpCronRoutes({ cronSecret: CRON_SECRET, runner: null }), `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: false, reason: "FOLLOWUP_AGENT is off" });
  });

  it("runs once per call, and answers 503 when the run fails", async () => {
    const app = followUpCronRoutes({ cronSecret: CRON_SECRET, runner: runner(async () => summary) });
    const response = await get(app, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: true, ...summary });

    const errors: unknown[] = [];
    const failing = followUpCronRoutes({
      cronSecret: CRON_SECRET, runner: runner(async () => { throw new Error("database down"); }), onError: (error) => errors.push(error),
    });
    const failed = await get(failing, `Bearer ${CRON_SECRET}`);
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("Unavailable");
    expect(errors).toHaveLength(1);
  });
});

describe("scheduled runs against Postgres (G-13)", () => {
  // Monday 08:00 UTC; the clock moves only when a test moves it.
  let now = Date.parse(NOW);
  const testClock = { now: () => new Date(now) };
  let h: ApiHarness;
  const pages = new Map<string, { page: PageSetup; calendarId: string }>();
  let model: ReturnType<typeof createFakeFollowUpModel>;
  let agent: FollowUpAgent;
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(h.database.servicePool, work);
  const scheduled = (options: { agent?: Pick<FollowUpAgent, "runScheduled" | "stallRun">; stallAfterMs?: number; budgetMs?: number; perTenantMs?: number; report?: (event: ScheduledFollowUpReport) => void } = {}) =>
    createScheduledFollowUps({
      service, agent: options.agent ?? agent, clock: testClock, slotMinutes: 60,
      budgetMs: options.budgetMs ?? 20_000, stallAfterMs: options.stallAfterMs ?? 900_000, perTenantMs: options.perTenantMs ?? 1_000,
      ...(options.report ? { report: options.report } : {}),
    });

  /** A website booking request nobody answered, from a new customer, each for its own hour. */
  let booked = 0;
  async function inquiry(tenant: TenantSetup, name: string) {
    const { page, calendarId } = pages.get(tenant.tenantId)!;
    const response = await call(h.app, "POST", `/public/v1/pages/${page.key}/requests`, {
      key: randomUUID(), headers: { "X-Real-IP": "203.0.113.7" },
      body: {
        resourceId: calendarId, startsAt: new Date(Math.ceil(now / HOUR) * HOUR + (48 + booked++) * HOUR).toISOString(), name,
        email: `${name.split(" ")[0]!.toLowerCase()}.${randomUUID().slice(0, 8)}@haldenrowe.example`,
        phone: null, notes: "Can you resize a ring?", consent: { email: false, sms: false }, disclosureVersion: "v1",
        channel: "widget", website: "",
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }
  const enable = (tenant: TenantSetup, over: { maxDraftsPerDay?: number; quiet?: [number, number] } = {}) => service((tx) => tx.query(
    `INSERT INTO agent_settings (tenant_id,enabled,max_drafts_per_day,quiet_start_minute,quiet_end_minute,updated_at)
     VALUES ($1,true,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, agent_kind) DO UPDATE SET enabled=true, max_drafts_per_day=$2, quiet_start_minute=$3, quiet_end_minute=$4,
       killed_at=NULL, killed_by=NULL, kill_note=NULL, revision=agent_settings.revision+1, updated_at=$5`,
    [tenant.tenantId, over.maxDraftsPerDay ?? 10, over.quiet?.[0] ?? 1260, over.quiet?.[1] ?? 480, new Date(now)],
  ));
  const runsOf = async (tenant: TenantSetup) => (await service((tx) => tx.query<{ id: string; requested_by: string | null; status: string; drafted: number; stop_reason: string | null }>(
    "SELECT id, requested_by, status, drafted, stop_reason FROM agent_runs WHERE tenant_id=$1 ORDER BY started_at, id", [tenant.tenantId],
  ))).rows;

  beforeAll(async () => {
    h = await createApiHarness({ clock: testClock, publicIntake: { keySecrets: { current: KEY_SECRET }, clientIp: { header: "x-real-ip" } } });
    for (const tenant of [h.a, h.b]) {
      const calendarId = randomUUID();
      await h.fixture.service((tx) => tx.query(
        `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
        [tenant.tenantId, calendarId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) =>
          ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })))],
      ));
      pages.set(tenant.tenantId, { page: await provisionPage(h, tenant, { resourceIds: [calendarId] }), calendarId });
    }
    model = createFakeFollowUpModel();
    agent = createFollowUpAgent({ db: h.database.db, clock: testClock, generateId: randomUUID }, { model, maxCandidatesPerRun: 3 });
  });
  afterAll(async () => { await h?.close(); });

  it("drafts for an enabled tenant only, as the agent, and leaves the send to an owner", async () => {
    await inquiry(h.a, "Mira Rowe");
    await inquiry(h.b, "Tomas Halden");
    await enable(h.a);
    // Past the 24-hour wait: Tuesday 12:00 UTC, outside the default quiet hours.
    now += 28 * HOUR;

    const summary = await scheduled().run();
    expect(summary).toEqual({
      slot: "2026-10-20T12:00:00.000Z", globalKilled: false, due: 1, finished: 1,
      drafted: 1, skipped: 0, stopped: 0, errors: 0, budgetSpent: false, stalled: 0, templated: {},
    });
    const [run] = await runsOf(h.a);
    expect(run).toMatchObject({
      id: followUpRunId(h.a.tenantId, scheduledRunKey(summary.slot)), requested_by: null, status: "completed", drafted: 1,
    });
    // B never turned the agent on: no run, no model call with its customer.
    expect(await runsOf(h.b)).toEqual([]);
    expect(model.prompts.map((prompt) => prompt.customerName)).toEqual(["Mira Rowe"]);

    const approvals = await service((tx) => tx.query<{ status: string; action_type: string }>(
      "SELECT status, action_type FROM approvals WHERE tenant_id=$1", [h.a.tenantId]));
    expect(approvals.rows).toEqual([{ status: "pending", action_type: "inbox.reply.send" }]);
    const sends = await service((tx) => tx.query(
      "SELECT 1 FROM outbox WHERE event_type='message.send_requested' AND tenant_id = ANY($1::uuid[])", [[h.a.tenantId, h.b.tenantId]]));
    expect(sends.rows).toEqual([]);
  });

  it("visits a tenant once per slot, and again in the next slot without drafting twice", async () => {
    now += 10 * 60_000;
    expect(await scheduled().run()).toMatchObject({ due: 0, finished: 0, drafted: 0 });
    expect(await runsOf(h.a)).toHaveLength(1);

    now += HOUR;
    expect(await scheduled().run()).toMatchObject({ slot: "2026-10-20T13:00:00.000Z", due: 1, finished: 1, drafted: 0 });
    const runs = await runsOf(h.a);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: "completed", drafted: 0 });
    expect(model.prompts).toHaveLength(1);
  });

  it("runs nothing while the global switch is off, and resumes when it is on", async () => {
    await inquiry(h.a, "Ines Calder");
    now += 25 * HOUR;
    await service((tx) => setGlobalAgentSwitch(tx, { killed: true, note: "Checking the wording", now: new Date(now) }));
    const before = (await runsOf(h.a)).length;
    expect(await scheduled().run()).toMatchObject({ globalKilled: true, due: 0, finished: 0, drafted: 0 });
    expect(await runsOf(h.a)).toHaveLength(before);

    await service((tx) => setGlobalAgentSwitch(tx, { killed: false, now: new Date(now) }));
    expect(await scheduled().run()).toMatchObject({ globalKilled: false, due: 1, drafted: 1 });
    expect(model.prompts.map((prompt) => prompt.customerName)).toContain("Ines Calder");
  });

  it("skips a tenant whose own switch is off or who is in quiet hours", async () => {
    await inquiry(h.a, "Owen Pike");
    now += 25 * HOUR;
    const before = (await runsOf(h.a)).length;
    await service((tx) => tx.query(
      "UPDATE agent_settings SET killed_at=$2, killed_by=$3, kill_note='Paused by staff' WHERE tenant_id=$1",
      [h.a.tenantId, new Date(now), h.a.actorId]));
    expect(await scheduled().run()).toMatchObject({ due: 0, finished: 0 });

    // Resumed, but the quiet window now covers the current hour.
    const hour = new Date(now).getUTCHours();
    await enable(h.a, { quiet: [hour * 60, hour * 60 + 60] });
    expect(await scheduled().run()).toMatchObject({ due: 0, finished: 0 });
    expect(await runsOf(h.a)).toHaveLength(before);
    expect(model.prompts.map((prompt) => prompt.customerName)).not.toContain("Owen Pike");

    await enable(h.a);
    expect(await scheduled().run()).toMatchObject({ due: 1, drafted: 1 });
  });

  it("holds the daily cap: one draft, then the run stops on daily_cap", async () => {
    await inquiry(h.b, "Pia Lund");
    now += 25 * HOUR;
    await enable(h.b, { maxDraftsPerDay: 1 });
    const summary = await scheduled().run();
    // B's two unanswered inquiries meet a cap of one; A has nothing new.
    expect(summary).toMatchObject({ due: 2, finished: 2, drafted: 1, stopped: 1, errors: 0 });
    const runs = await runsOf(h.b);
    expect(runs.at(-1)).toMatchObject({ status: "stopped", drafted: 1, stop_reason: "daily_cap" });
  });

  it("visits the tenant that ran least recently first, and stops before the budget runs out", async () => {
    now += HOUR;
    const order: string[] = [];
    const recording: Pick<FollowUpAgent, "runScheduled" | "stallRun"> = {
      stallRun: (tenantId, runId) => agent.stallRun(tenantId, runId),
      // Each tenant's run takes a second of the injected clock.
      runScheduled: async (tenantId, slot) => {
        order.push(tenantId);
        const run = await agent.runScheduled(tenantId, slot);
        now += 1_000;
        return run;
      },
    };
    const roomForOne = () => scheduled({ agent: recording, budgetMs: 1_500, perTenantMs: 1_000 }).run();

    // Room for one tenant only: the second is left for the next call in the slot.
    expect(await roomForOne()).toMatchObject({ due: 2, finished: 1, budgetSpent: true });
    expect(await roomForOne()).toMatchObject({ due: 1, finished: 1, budgetSpent: false });
    const [first, second] = order;
    expect(second).not.toBe(first);

    // The first tenant runs again (an owner's run now, say), so the second has now waited longest.
    now += 1_000;
    await agent.runScheduled(first!, `manual-${randomUUID()}`);
    now += HOUR;
    expect(await roomForOne()).toMatchObject({ due: 2, finished: 1, budgetSpent: true });
    expect(order[2]).toBe(second);
    expect(await roomForOne()).toMatchObject({ due: 1, finished: 1 });
    expect(order[3]).toBe(first);
  });

  it("starts no tenant whose worst case would outlast the budget", async () => {
    now += HOUR;
    const summary = await scheduled({ budgetMs: 1_000, perTenantMs: 1_001 }).run();
    expect(summary).toMatchObject({ due: 2, finished: 0, budgetSpent: true });
  });

  it("reports a tenant whose run fails and goes on with the next", async () => {
    now += HOUR;
    const reports: ScheduledFollowUpReport[] = [];
    let first = true;
    const flaky: Pick<FollowUpAgent, "runScheduled" | "stallRun"> = {
      stallRun: (tenantId, runId) => agent.stallRun(tenantId, runId),
      runScheduled: async (tenantId, slot) => {
        if (first) { first = false; throw new Error("connection reset"); }
        return agent.runScheduled(tenantId, slot);
      },
    };
    const summary = await scheduled({ agent: flaky, report: (event) => reports.push(event) }).run();
    expect(summary).toMatchObject({ due: 2, finished: 1, errors: 1 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ slot: summary.slot, error: new Error("connection reset") });
    // The failed tenant is still due in this slot, and the next call reaches it.
    expect(await scheduled().run()).toMatchObject({ due: 1, finished: 1, errors: 0 });
  });

  it("closes a run that stayed running past the stall limit, once, and refuses nothing else (G-16)", async () => {
    now += HOUR;
    // A run that started and then died: running, no decisions, started longer ago than the limit.
    const stuck = randomUUID();
    await service((tx) => tx.query(
      "INSERT INTO agent_runs (tenant_id,id,agent,started_at,max_decisions) VALUES ($1,$2,'inquiry_followup',$3,3)",
      [h.a.tenantId, stuck, new Date(now - 16 * 60_000)]));
    const fresh = randomUUID();
    await service((tx) => tx.query(
      "INSERT INTO agent_runs (tenant_id,id,agent,started_at,max_decisions) VALUES ($1,$2,'inquiry_followup',$3,3)",
      [h.b.tenantId, fresh, new Date(now - 60_000)]));
    const summary = await scheduled({ stallAfterMs: 15 * 60_000 }).run();
    expect(summary.stalled).toBe(1);
    const closed = (await service((tx) => tx.query<{ id: string; status: string; stop_reason: string | null }>(
      "SELECT id, status, stop_reason FROM agent_runs WHERE id = ANY($1::uuid[]) ORDER BY id", [[stuck, fresh]]))).rows;
    expect(closed.find((run) => run.id === stuck)).toMatchObject({ status: "stopped", stop_reason: "stalled" });
    expect(closed.find((run) => run.id === fresh)).toMatchObject({ status: "running", stop_reason: null });
    expect((await scheduled({ stallAfterMs: 15 * 60_000 }).run()).stalled).toBe(0);
  });
});

describe("the templated kinds in the production wiring (G-19, G-20)", () => {
  // Monday 2026-11-02 08:00 UTC; the booking is at 10:00, inside the reminder's 24-hour lead.
  const now = Date.parse("2026-11-02T08:00:00.000Z");
  const testClock = { now: () => new Date(now) };
  const BASE_URL = "https://book.example.test";
  let database: TestDatabase;
  let fixture: TwoTenantFixture;
  let runnerEnv: FollowUpRunnerEnv;
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  const deps = () => ({ db: database.db, clock: testClock, generateId: randomUUID });
  const runCount = async () => Number((await service((tx) => tx.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs"))).rows[0]!.n);

  async function addMember(tenantId: string, role: "owner" | "staff") {
    const userId = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(now)],
    ));
    return userId;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    fixture = await createTwoTenantFixture(database);
    const runtime = new URL(database.url);
    runtime.username = "zs_runtime";
    const parsed = parseFollowUpEnv({
      ...ON, FOLLOWUP_DATABASE_URL: runtime.href, FOLLOWUP_SERVICE_DATABASE_URL: database.url,
      AGENT_TEMPLATED: "on", PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_BASE_URL: `${BASE_URL}/`,
    });
    runnerEnv = parsed.runner!;
  }, 60_000);
  afterAll(async () => { await database?.close(); });

  it("queues a reminder with a signed booking link under the base URL, for the enabled tenant only", async () => {
    const tenantId = fixture.a.tenantId;
    const resourceId = randomUUID();
    const pageId = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
        [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
      );
      await tx.query(
        "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book a fitting',true,'v1',$3)",
        [tenantId, pageId, new Date(now)],
      );
    });
    const owner = await addMember(tenantId, "owner");
    const staff = await addMember(tenantId, "staff");

    // A confirmed booking at 10:00 with a customer who has an email address.
    const staffSession = createSession(deps(), { tenantId, actorId: staff });
    const bookingId = (await staffSession.createBooking({ resourceId, startsAt: "2026-11-02T10:00:00.000Z" }, randomUUID())).result.id;
    const contactId = (await staffSession.upsertContact(
      { displayName: "Ana Ruiz", email: `ana-${randomUUID().slice(0, 8)}@haldenrowe.example` }, randomUUID())).result.contact.id;
    await staffSession.linkBookingContact(bookingId, { contactId, expectedRevision: 0 }, randomUUID());

    // The owner writes and approves the reminder wording, then turns the kind on with no quiet hours.
    const templates = createTemplateSession(deps(), { tenantId, actorId: owner });
    const state = await templates.getTemplate("appointment_reminder");
    await templates.createRevision("appointment_reminder", {
      expectedRevision: state.currentRevision, channel: "email", subject: "A note from {business_name}",
      body: "Hi {customer_first_name}, see you {booking_start_local}. Change it: {booking_link}", timingHours: 24,
    }, randomUUID());
    const revision = (await templates.getTemplate("appointment_reminder")).revisions[0]!;
    await templates.approveTemplate("appointment_reminder", { revision: revision.revision, contentDigest: revision.contentDigest }, randomUUID());
    const ownerSession = createSession(deps(), { tenantId, actorId: owner });
    const status = await ownerSession.getAgentKindStatus("appointment_reminder");
    await ownerSession.updateAgentKindSettings("appointment_reminder", {
      enabled: true, quietStartMinute: 0, quietEndMinute: 0, timeZone: "UTC", maxCostMicrosPerDay: 1_000_000, config: {},
      expectedRevision: status.revision,
    }, randomUUID());

    const { runner, close } = await startFollowUpRunner(runnerEnv, { clock: testClock, generateId: randomUUID });
    try {
      const summary = await runner.run();
      expect(summary.templated?.appointment_reminder).toMatchObject({ due: 1, finished: 1, queued: 1, errors: 0 });
      expect(summary.templated?.review_request).toMatchObject({ due: 0, queued: 0 });
    } finally {
      await close();
    }

    const link = `${BASE_URL}/book/${signBookingKey(KEY_SECRET, { tenantId, pageId })}`;
    const sends = (await service((tx) => tx.query<{ tenant_id: string; payload: { body: string } }>(
      "SELECT tenant_id, payload FROM outbox WHERE event_type='message.send_requested'"))).rows;
    expect(sends).toHaveLength(1);
    expect(sends[0]!.tenant_id).toBe(tenantId);
    expect(sends[0]!.payload.body).toContain(`Change it: ${link}`);
    const runs = (await service((tx) => tx.query<{ tenant_id: string; agent: string; status: string }>(
      "SELECT tenant_id, agent, status FROM agent_runs"))).rows;
    expect(runs).toEqual([{ tenant_id: tenantId, agent: "appointment_reminder", status: "completed" }]);
  });

  it("refuses to start with the templated kinds on but no booking key or base URL, before any run", async () => {
    const before = await runCount();
    for (const templated of [
      { ...runnerEnv.templated!, bookingKeySecret: "" },
      { ...runnerEnv.templated!, publicBaseUrl: "" },
    ]) {
      await expect(startFollowUpRunner({ ...runnerEnv, templated }, { clock: testClock, generateId: randomUUID }))
        .rejects.toThrow(/Invalid environment: (PUBLIC_BOOKING_KEY_SECRET|PUBLIC_BASE_URL)/);
    }
    expect(await runCount()).toBe(before);
  });

  it("a follow-up allowance larger than the budget does not starve the templated kinds", async () => {
    const tenantId = fixture.b.tenantId;
    await service((tx) => tx.query(
      `INSERT INTO agent_settings (tenant_id,agent_kind,enabled,quiet_start_minute,quiet_end_minute,config,updated_at)
       VALUES ($1,'appointment_reminder',true,0,0,'{}'::jsonb,$2)
       ON CONFLICT (tenant_id, agent_kind) DO UPDATE SET enabled=true, quiet_start_minute=0, quiet_end_minute=0, killed_at=NULL`,
      [tenantId, new Date(now)]));
    const ran: string[] = [];
    const run = { status: "completed", drafted: 0, skipped: 0, stopReason: null };
    const scheduled = createScheduledFollowUps({
      service,
      agent: { runScheduled: async () => { throw new Error("no follow-up tenant is due"); }, stallRun: async () => { throw new Error("unused"); } },
      templated: {
        runScheduled: async (kind, tenant) => { ran.push(`${kind}:${tenant}`); return run as never; },
        stallRun: async () => { throw new Error("unused"); },
      },
      // A slot no earlier test used, so the tenant is due.
      clock: testClock, slotMinutes: 7, budgetMs: 5_000, stallAfterMs: 900_000, perTenantMs: 160_000,
    });
    const summary = await scheduled.run();
    expect(ran).toContain(`appointment_reminder:${tenantId}`);
    expect(summary.budgetSpent).toBe(false);
  });

  it("runs no templated kind while they are off", async () => {
    const { runner, close } = await startFollowUpRunner({ ...runnerEnv, templated: null }, { clock: testClock, generateId: randomUUID });
    try {
      expect((await runner.run()).templated).toEqual({});
    } finally {
      await close();
    }
  });
});
