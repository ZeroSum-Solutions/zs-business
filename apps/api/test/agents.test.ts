import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  DEFAULT_FOLLOW_UP_SETTINGS,
  followUpRunDetailSchema,
  followUpRunPageSchema,
  followUpStatusOutputSchema,
  followUpStatusSchema,
  type FollowUpSettings,
} from "@zs/contracts";
import { createFakeFollowUpModel, createLocalStubSessionCheck, type FakeFollowUpModel } from "@zs/core";
import { createApp, createHs256Verifier, type App } from "../src/app.js";
import { signDevToken } from "../src/dev-token.js";
import {
  call,
  createApiHarness,
  KEY_SECRET,
  NOW,
  ORIGIN,
  provisionPage,
  SECRET,
  signedInMember,
  type ApiHarness,
  type MemberSetup,
  type PageSetup,
} from "./helpers.js";

// agents.md G-11 over HTTP, as zs_runtime on a real database. The injected clock starts at the
// fixed test instant (Monday 08:00 UTC) and moves only when a test ticks it; tokens are minted
// at the current test time, so they stay valid after a tick.
let now = Date.parse(NOW);
const testClock = { now: () => new Date(now) };
const HOUR = 3_600_000;
const BASE = "/v1/agents/followup";

let h: ApiHarness;
/** The same database and clock, with a fake model configured: `POST /runs` is on. */
let agentApp: App;
let model: FakeFollowUpModel;
let page: PageSetup;
let calendarId: string;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness({
    clock: testClock,
    publicIntake: { keySecrets: { current: KEY_SECRET }, clientIp: { header: "x-real-ip" } },
  });
  model = createFakeFollowUpModel();
  agentApp = createApp({
    verifier: createHs256Verifier(SECRET, { clock: testClock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, testClock),
    clock: testClock,
    db: h.database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    followUp: { model, maxCandidatesPerRun: 50 },
  });
  calendarId = randomUUID();
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'Fitting room','UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
    [h.a.tenantId, calendarId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) =>
      ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })))],
  ));
  page = await provisionPage(h, h.a, { resourceIds: [calendarId] });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const tokenOf = (member: MemberSetup) => signDevToken(SECRET, member, testClock, 3600);
const as = async (member: MemberSetup, method: string, path: string, body?: unknown, options: { key?: string; app?: App } = {}) =>
  call(options.app ?? h.app, method, `${BASE}${path}`, {
    token: await tokenOf(member),
    ...(body === undefined ? {} : { body, key: options.key ?? randomUUID() }),
  });
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const status = async (member: MemberSetup = h.a) => {
  const response = await as(member, "GET", "");
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return followUpStatusSchema.parse(response.body);
};
const settings = (over: Partial<FollowUpSettings>, expectedRevision: number) =>
  ({ ...DEFAULT_FOLLOW_UP_SETTINGS, ...over, expectedRevision });

describe("status and settings (G-2, G-11)", () => {
  it("reads the defaults at revision 0 before an owner saves settings", async () => {
    expect(await status()).toEqual({
      settings: DEFAULT_FOLLOW_UP_SETTINGS, revision: 0, updatedAt: null, killed: null,
      globalKilled: false, canDraft: false, blockedBy: "disabled",
    });
    // Staff read it too (inbox.drafts).
    expect((await status(staff)).revision).toBe(0);
  });

  it("lets an owner replace the settings, compare-and-set on the revision", async () => {
    const saved = await as(h.a, "PUT", "/settings", settings({ enabled: true, maxDraftsPerDay: 5 }, 0));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const output = followUpStatusOutputSchema.parse(saved.body);
    expect(output.result).toMatchObject({ revision: 1, settings: { enabled: true, maxDraftsPerDay: 5 }, updatedAt: NOW });
    expect(await status()).toMatchObject({ revision: 1, settings: { enabled: true, maxDraftsPerDay: 5 } });

    const stale = await as(h.a, "PUT", "/settings", settings({ enabled: true, maxDraftsPerDay: 7 }, 0));
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 1 } });
    expect((await status()).settings.maxDraftsPerDay).toBe(5);
    // The other tenant is untouched.
    expect(await status(h.b)).toMatchObject({ revision: 0, settings: DEFAULT_FOLLOW_UP_SETTINGS });
  });

  it("refuses invalid settings, a missing key, a reserved key, and non-JSON bodies", async () => {
    const invalid = await as(h.a, "PUT", "/settings", settings({ maxDraftsPerDay: 0 }, 1));
    expect(invalid.status).toBe(400);
    expect(errorOf(invalid).code).toBe("ValidationFailed");
    const extra = await as(h.a, "PUT", "/settings", { ...settings({}, 1), surprise: true });
    expect(extra.status).toBe(400);
    const noKey = await call(h.app, "PUT", `${BASE}/settings`, { token: await tokenOf(h.a), body: settings({}, 1) });
    expect(noKey.status).toBe(400);
    const reserved = await as(h.a, "PUT", "/settings", settings({}, 1), { key: `agent:${randomUUID()}` });
    expect(reserved.status).toBe(400);
    expect(errorOf(reserved).code).toBe("ValidationFailed");
    const reservedKill = await as(staff, "POST", "/kill", {}, { key: `agent:${randomUUID()}` });
    expect(reservedKill.status).toBe(400);
    const text = await call(h.app, "PUT", `${BASE}/settings`, {
      token: await tokenOf(h.a), key: randomUUID(), headers: { "Content-Type": "text/plain" },
    });
    expect(text.status).toBe(400);
    expect((await status()).revision).toBe(1);
  });

  it("refuses staff settings changes (agents is owner only)", async () => {
    const response = await as(staff, "PUT", "/settings", settings({ enabled: false }, 1));
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe("Forbidden");
    expect((await status()).settings.enabled).toBe(true);
  });

  it("allows PUT in CORS preflight", async () => {
    const response = await h.app.request(`${BASE}/settings`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT" },
    });
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
  });
});

describe("kill and resume (G-3)", () => {
  it("lets staff stop the agent, and only an owner resume it", async () => {
    const killed = await as(staff, "POST", "/kill", { note: "Pausing while we check the wording" });
    expect(killed.status, JSON.stringify(killed.body)).toBe(200);
    expect(followUpStatusOutputSchema.parse(killed.body).result.killed).toEqual({
      at: NOW, by: staff.actorId, note: "Pausing while we check the wording",
    });
    expect(await status()).toMatchObject({ killed: { by: staff.actorId }, canDraft: false, blockedBy: "tenant_killed" });

    const staffResume = await as(staff, "POST", "/resume", {});
    expect(staffResume.status).toBe(403);
    expect((await status()).killed).not.toBeNull();

    const badResume = await as(h.a, "POST", "/resume", { note: "no fields here" });
    expect(badResume.status).toBe(400);

    const resumed = await as(h.a, "POST", "/resume", {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(followUpStatusOutputSchema.parse(resumed.body).result.killed).toBeNull();
    expect((await status()).killed).toBeNull();
  });
});

describe("runs (G-7, G-11)", () => {
  let runId: string;
  let requestId: string;

  it("runs the agent now for an owner when a model is configured, and lists the run", async () => {
    const startsAt = new Date(now + 48 * HOUR).toISOString();
    const request = await call(h.app, "POST", `/public/v1/pages/${page.key}/requests`, {
      key: randomUUID(), headers: { "X-Real-IP": "203.0.113.7" },
      body: {
        resourceId: calendarId, startsAt, name: "Mira Rowe", email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`,
        phone: null, notes: "Can you resize a ring?", consent: { email: false, sms: false }, disclosureVersion: "v1",
        channel: "widget", website: "",
      },
    });
    expect(request.status, JSON.stringify(request.body)).toBe(201);
    requestId = request.body.requestId as string;

    // Past the 24-hour wait, at Tuesday 12:00 UTC, outside the default quiet hours.
    now += 28 * HOUR;
    expect(await status()).toMatchObject({ canDraft: true, blockedBy: null });

    const ran = await as(h.a, "POST", "/runs", {}, { app: agentApp });
    expect(ran.status, JSON.stringify(ran.body)).toBe(201);
    const run = followUpRunDetailSchema.parse(ran.body);
    expect(run).toMatchObject({
      status: "completed", stopReason: null, considered: 1, drafted: 1, skipped: 0, requestedBy: h.a.actorId,
    });
    expect(run.decisions).toHaveLength(1);
    expect(run.decisions[0]).toMatchObject({ intakeItemId: requestId, outcome: "drafted", reason: null });
    expect(model.prompts).toHaveLength(1);
    runId = run.id;

    const list = await as(h.a, "GET", "/runs");
    expect(list.status).toBe(200);
    expect(followUpRunPageSchema.parse(list.body).items.map((item) => item.id)).toEqual([runId]);
    const staffList = await as(staff, "GET", "/runs?limit=10");
    expect(followUpRunPageSchema.parse(staffList.body).items).toHaveLength(1);

    const detail = await as(h.a, "GET", `/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(followUpRunDetailSchema.parse(detail.body)).toEqual(run);

    // The draft waits for an owner; nothing was sent.
    const sends = await h.fixture.service((tx) => tx.query(
      "SELECT 1 FROM outbox WHERE tenant_id=$1 AND event_type='message.send_requested'", [h.a.tenantId]));
    expect(sends.rows).toHaveLength(0);
  });

  it("replays a run with the same key", async () => {
    const key = randomUUID();
    const first = await as(h.a, "POST", "/runs", {}, { app: agentApp, key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await as(h.a, "POST", "/runs", {}, { app: agentApp, key });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
  });

  it("refuses staff, bad bodies, and is not found without a configured model", async () => {
    const staffRun = await as(staff, "POST", "/runs", {}, { app: agentApp });
    expect(staffRun.status).toBe(403);
    const extra = await as(h.a, "POST", "/runs", { now: true }, { app: agentApp });
    expect(extra.status).toBe(400);
    const reserved = await as(h.a, "POST", "/runs", {}, { app: agentApp, key: `agent:${randomUUID()}` });
    expect(reserved.status).toBe(400);

    const off = await as(h.a, "POST", "/runs", {});
    expect(off.status).toBe(404);
    expect(errorOf(off).code).toBe("NotFound");
    // The reads stay on without a model.
    expect((await as(h.a, "GET", "/runs")).status).toBe(200);
  });

  it("hides another tenant's runs and refuses malformed IDs", async () => {
    const other = await as(h.b, "GET", `/runs/${runId}`);
    expect(other.status).toBe(404);
    expect(followUpRunPageSchema.parse((await as(h.b, "GET", "/runs")).body).items).toEqual([]);
    expect((await as(h.a, "GET", `/runs/${randomUUID()}`)).status).toBe(404);
    expect((await as(h.a, "GET", "/runs/not-a-uuid")).status).toBe(400);
    expect((await as(h.a, "GET", "/runs?limit=0")).status).toBe(400);
  });
});

describe("authentication", () => {
  it("answers 401 without a token on every agent route", async () => {
    for (const [method, path, app] of [
      ["GET", "", h.app], ["PUT", "/settings", h.app], ["POST", "/kill", h.app], ["POST", "/resume", h.app],
      ["GET", "/runs", h.app], ["GET", `/runs/${randomUUID()}`, h.app], ["POST", "/runs", agentApp], ["POST", "/runs", h.app],
    ] as const) {
      const response = await call(app, method, `${BASE}${path}`, method === "GET" ? {} : { body: {}, key: randomUUID() });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });
});
