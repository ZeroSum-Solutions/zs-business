// The scheduled follow-up runner as the API deploys it (agents.md G-13): the environment it parses,
// the cron route Vercel calls, the time-budgeted loop over due tenants, and the production wiring
// against Postgres with the fake model. No network, no system clock, no real model.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFakeFollowUpModel,
  createFollowUpAgent,
  followUpRunId,
  scheduledRunKey,
  setGlobalAgentSwitch,
  type FollowUpAgent,
  type FollowUpModel,
} from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { parseFollowUpEnv, PLACEHOLDER_CRON_SECRET } from "../src/followup/config.js";
import { followUpCronRoutes } from "../src/followup/cron.js";
import {
  createScheduledFollowUps,
  ModelTimedOut,
  withModelTimeout,
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

const ON: Record<string, string> = {
  FOLLOWUP_AGENT: "on",
  FOLLOWUP_DATABASE_URL: LOCAL_RUNTIME,
  FOLLOWUP_SERVICE_DATABASE_URL: LOCAL_SERVICE,
  FOLLOWUP_MODEL: "fake",
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
        model: "fake",
        slotMinutes: 60,
        maxCandidatesPerRun: 3,
        modelTimeoutMs: 5_000,
        budgetMs: 20_000,
        intervalMs: 300_000,
      },
    });
  });

  it.each(["FOLLOWUP_DATABASE_URL", "FOLLOWUP_SERVICE_DATABASE_URL", "FOLLOWUP_MODEL"])("with the switch on, requires %s", (name) => {
    expect(errorOf(without(name))).toMatch(new RegExp(`Invalid environment: .*${name}`));
  });

  it("knows no real model provider yet", () => {
    for (const value of ["anthropic", "openai", "FAKE", ""])
      expect(errorOf({ ...ON, FOLLOWUP_MODEL: value })).toMatch(/FOLLOWUP_MODEL: no real model provider is wired yet/);
  });

  it("runs the fake model only against loopback databases", () => {
    expect(errorOf({ ...ON, FOLLOWUP_SERVICE_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/FOLLOWUP_MODEL=fake runs only against loopback databases/);
    expect(errorOf({ ...ON, FOLLOWUP_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/FOLLOWUP_MODEL=fake runs only against loopback databases/);
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
    drafted: 1, skipped: 0, stopped: 0, errors: 0, budgetSpent: false,
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

describe("withModelTimeout", () => {
  const prompt = { businessName: "Halden & Rowe", customerName: "Mira Rowe", inquiry: null, booking: null } as unknown as Parameters<FollowUpModel["draft"]>[0];

  it("passes a prompt answered in time through", async () => {
    const model = createFakeFollowUpModel();
    expect(await withModelTimeout(model, 1_000).draft(prompt)).toMatchObject({ subject: "Following up from Halden & Rowe" });
    expect(model.prompts).toEqual([prompt]);
  });

  it("gives up on a model that does not answer", async () => {
    const slow: FollowUpModel = { draft: () => new Promise(() => undefined) };
    await expect(withModelTimeout(slow, 20).draft(prompt)).rejects.toBeInstanceOf(ModelTimedOut);
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
  const scheduled = (options: { agent?: Pick<FollowUpAgent, "runScheduled">; budgetMs?: number; perTenantMs?: number; report?: (event: ScheduledFollowUpReport) => void } = {}) =>
    createScheduledFollowUps({
      service, agent: options.agent ?? agent, clock: testClock, slotMinutes: 60,
      budgetMs: options.budgetMs ?? 20_000, perTenantMs: options.perTenantMs ?? 1_000,
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
     ON CONFLICT (tenant_id) DO UPDATE SET enabled=true, max_drafts_per_day=$2, quiet_start_minute=$3, quiet_end_minute=$4,
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
      drafted: 1, skipped: 0, stopped: 0, errors: 0, budgetSpent: false,
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
    const recording: Pick<FollowUpAgent, "runScheduled"> = {
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
    const flaky: Pick<FollowUpAgent, "runScheduled"> = {
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
});
