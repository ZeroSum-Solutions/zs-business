// M6 agent kinds, usage and cost caps, stalled runs and the model port (docs/requirements/agents.md
// G-14..G-18) under the runtime role. The clock is injected; each test starts a month after the last.
// Models are fakes: no test reaches a vendor.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ActionError, AGENT_KINDS, Conflict, TenantDenied, ValidationFailed,
  type ActionCommand, type AgentKind, type FollowUpSettings, type MemberRole,
} from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  agentActorId,
  agentAuthorize,
  agentAuthorizeFor,
  assertKindModel,
  createDeepSeekModel,
  createFakeFollowUpModel,
  createFollowUpAgent,
  createFollowUpModel,
  createHangingFollowUpModel,
  createPublicSession,
  createSession,
  directDispatch,
  FAKE_MODEL_PRICES,
  followUpRunId,
  runFollowUps,
  setGlobalAgentSwitch,
  stalledRuns,
  type EdgeDependencies,
  type Session,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-20T12:00:00.000Z");
let epoch = START;
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let pageId: string;
let resourceId: string;
let owner: string;
let staff: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

let slot = 0;
async function inquiry(name = "Halden Guest") {
  const n = slot++;
  const day = new Date(Math.floor(now / DAY) * DAY + (21 + Math.floor(n / 8)) * DAY);
  const startsAt = new Date(day.getTime() + (9 + (n % 8)) * HOUR).toISOString();
  const reply = await createPublicSession(deps(), { tenantId, pageId }).request({
    resourceId, startsAt, name, email: `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`, phone: null, notes: "Do you have parking?",
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  const item = (await rows<{ contact_id: string }>("SELECT contact_id FROM intake_items WHERE tenant_id=$1 AND id=$2", [tenantId, reply.requestId]))[0]!;
  return { itemId: reply.requestId, contactId: item.contact_id };
}
/** Make inquiries now, then move past the wait so they are due. */
async function dueInquiries(count: number) {
  const made = [];
  for (let i = 0; i < count; i += 1) made.push(await inquiry(`Guest ${i}`));
  now += 25 * HOUR;
  return made;
}

const BASE: FollowUpSettings = {
  enabled: true, maxDraftsPerDay: 10, maxDraftsPerContact: 1, contactWindowHours: 168, waitHours: 24, lookbackDays: 14,
  quietStartMinute: 21 * 60, quietEndMinute: 8 * 60, timeZone: "UTC",
};
async function configure(maxCostMicrosPerDay?: number) {
  const session = sessionFor(owner);
  const status = await session.getFollowUpStatus();
  if (status.killed) await session.resumeFollowUp({}, randomUUID());
  return (await session.updateFollowUpSettings({
    ...BASE, ...(maxCostMicrosPerDay === undefined ? {} : { maxCostMicrosPerDay }), expectedRevision: status.revision,
  }, randomUUID())).result;
}

const calls = (runId?: string) => rows<{
  call_key: string; outcome: string; model: string; input_tokens: number; output_tokens: number; cost_micros: string;
  provider_request_id: string | null; lane: string;
}>(
  `SELECT call_key, outcome, model, lane, input_tokens, output_tokens, cost_micros::text, provider_request_id FROM agent_model_calls
    WHERE tenant_id=$1 AND ($2::uuid IS NULL OR run_id=$2) AND created_at >= $3 ORDER BY created_at, call_key`, [tenantId, runId ?? null, new Date(epoch)]);
const runTotals = async (id: string) => (await rows<{ model: string | null; input_tokens: number; output_tokens: number; cost_micros: string }>(
  "SELECT model, input_tokens, output_tokens, cost_micros::text FROM agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, id]))[0]!;
const warnings = () => rows("SELECT 1 FROM outbox WHERE tenant_id=$1 AND event_type='agent.cost_warning'", [tenantId]);
const costOf = (inputTokens: number, outputTokens: number) => Math.ceil((inputTokens * 350_000 + outputTokens * 750_000) / 1_000_000);

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  resourceId = randomUUID();
  pageId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`,
      [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
    await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [tenantId, pageId, new Date(START)]);
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, resourceId]);
  });
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
});
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  epoch += 30 * DAY;
  now = epoch;
  slot = 0;
  await configure(10_000_000);
  await service((tx) => setGlobalAgentSwitch(tx, { killed: false, now: clock.now() }));
});

describe("usage and cost caps (G-15, G-17)", () => {
  it("times out a model that never answers through its abort signal, records the call at its worst case, then caps the day", async () => {
    await dueInquiries(1);
    const hanging = createHangingFollowUpModel();
    const agent = (model: Parameters<typeof createFollowUpAgent>[1]["model"]) =>
      createFollowUpAgent(deps(), { model, maxCandidatesPerRun: 5, modelTimeoutMs: 40 });

    const startedAt = Date.now();
    const first = await agent(hanging).runScheduled(tenantId, randomUUID());
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first).toMatchObject({ status: "completed", considered: 1, drafted: 0, skipped: 1, stopReason: null });
    expect(first.decisions).toEqual([expect.objectContaining({ outcome: "skipped", reason: "model_error" })]);
    const [aborted] = await calls(first.id);
    // No usage came back, so the reserved worst case stands (never an undercount).
    expect(aborted).toMatchObject({ outcome: "error", model: "fake-follow-up", lane: "personal_data" });
    const worst = Number(aborted!.cost_micros);
    expect(worst).toBeGreaterThan(400);
    expect(await runTotals(first.id)).toMatchObject({ model: "fake-follow-up", input_tokens: 820, output_tokens: 600, cost_micros: String(worst) });

    // The next call's usage fills the call row and the run totals. The inquiry the model_error
    // left undrafted is asked again: a new, separately priced call in the new run.
    now += 25 * HOUR;
    const second = await agent(createFakeFollowUpModel()).runScheduled(tenantId, randomUUID());
    expect(second).toMatchObject({ drafted: 1 });
    expect(await runTotals(second.id)).toEqual({ model: "fake-follow-up", input_tokens: 120, output_tokens: 60, cost_micros: String(costOf(120, 60)) });
    expect(await calls(second.id)).toEqual([expect.objectContaining({
      outcome: "ok", input_tokens: 120, output_tokens: 60, cost_micros: String(costOf(120, 60)),
    })]);

    // A cap just above what the last 24 hours cost (the aborted call is a day old by now): the next
    // run stops before it calls the model, because the call's worst case does not fit.
    const spent = costOf(120, 60);
    await configure(spent + 1);
    const status = await sessionFor(owner).getFollowUpStatus();
    expect(status).toMatchObject({ costSpentMicros: spent, costCapMicros: spent + 1, costWarning: true, canDraft: true });
    await inquiry("Third");
    now += 25 * HOUR;
    const model = createFakeFollowUpModel();
    const third = await agent(model).runScheduled(tenantId, randomUUID());
    expect(third).toMatchObject({ status: "stopped", stopReason: "cost_cap", considered: 0, drafted: 0 });
    expect(model.prompts).toHaveLength(0);
    expect(await calls(third.id)).toEqual([]);

    // A cap of zero refuses every call: a new run does not even start a candidate.
    await configure(0);
    expect(await sessionFor(owner).getFollowUpStatus()).toMatchObject({ canDraft: false, blockedBy: "cost_cap" });
    const fourth = await agent(model).runScheduled(tenantId, randomUUID());
    expect(fourth).toMatchObject({ status: "stopped", stopReason: "cost_cap" });
    expect(model.prompts).toHaveLength(0);
  });

  it("reserves the worst case before the call goes out", async () => {
    await dueInquiries(1);
    let during: Awaited<ReturnType<typeof calls>> = [];
    const model = createFakeFollowUpModel(async () => {
      during = await calls();
      return { subject: "Hello", body: "Thanks for asking." };
    });
    await createFollowUpAgent(deps(), { model, maxCandidatesPerRun: 5 }).runScheduled(tenantId, randomUUID());
    expect(during).toEqual([expect.objectContaining({ outcome: "started" })]);
    expect(Number(during[0]!.cost_micros)).toBeGreaterThan(costOf(120, 60));
    const [settled] = await calls();
    expect(Number(settled!.cost_micros)).toBe(costOf(120, 60));
  });

  it("a call whose worst case does not fit under the cap is never made", async () => {
    await configure(50);
    await dueInquiries(1);
    const model = createFakeFollowUpModel();
    const run = await createFollowUpAgent(deps(), { model, maxCandidatesPerRun: 5 }).runScheduled(tenantId, randomUUID());
    expect(run).toMatchObject({ status: "stopped", stopReason: "cost_cap", considered: 0 });
    expect(model.prompts).toHaveLength(0);
    expect(await calls()).toEqual([]);
  });

  it("a model with no price runs nothing, and the wrong lane or a wrong model cannot be installed", () => {
    const unpriced = createFakeFollowUpModel();
    expect(() => createFollowUpAgent(deps(), { model: unpriced, maxCandidatesPerRun: 1, modelPrices: {} })).toThrow(ValidationFailed);
    const deepseek = createFollowUpModel(createDeepSeekModel({ apiKey: "k", fetch: () => Promise.reject(new Error("no network")) }) as never);
    expect(() => createFollowUpAgent(deps(), { model: deepseek, maxCandidatesPerRun: 1, modelPrices: { "deepseek-chat": { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } } }))
      .toThrow(/personal_data/);
    expect(() => assertKindModel("inquiry_followup", { lane: "personal_data", model: "fake-follow-up" }, FAKE_MODEL_PRICES)).not.toThrow();
    return expect(runFollowUps({
      db: database.db, clock, model: unpriced, config: { maxCandidatesPerRun: 1 }, modelPrices: {}, dispatch: () => Promise.reject(new Error("unreachable")),
    }, tenantId, { key: "k", requestedBy: null })).rejects.toBeInstanceOf(ValidationFailed);
  });

  it("warns once at 80% of the cap per local date", async () => {
    await configure(900);
    const before = (await warnings()).length;
    await dueInquiries(2);
    const agent = () => createFollowUpAgent(deps(), { model: createFakeFollowUpModel(), maxCandidatesPerRun: 1 });
    // Each call's worst case is about 700 of 900: the line is crossed at the reserve.
    await agent().runScheduled(tenantId, randomUUID());
    expect(await warnings()).toHaveLength(before + 1);
    // The second run the same local date crosses it again: the same key, so still one warning.
    await agent().runScheduled(tenantId, randomUUID());
    expect(await warnings()).toHaveLength(before + 1);
    const event = (await rows<{ payload: { agentKind: string; localDate: string; capMicros: number } }>(
      "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='agent.cost_warning'", [tenantId]))[0]!.payload;
    expect(event).toMatchObject({ agentKind: "inquiry_followup", localDate: new Date(now).toISOString().slice(0, 10), capMicros: 900 });
    // The next local date, a new warning.
    now += 26 * HOUR;
    await inquiry("Next day");
    now += 25 * HOUR;
    await agent().runScheduled(tenantId, randomUUID());
    expect(await warnings()).toHaveLength(before + 2);
  });

  it("keeps the cap per kind and reads the status of any kind", async () => {
    const status = await sessionFor(owner).getAgentKindStatus("review_request");
    expect(status).toMatchObject({ costSpentMicros: 0, costCapMicros: 1_000_000, costWarning: false });
  });
});

describe("stalled runs (G-16)", () => {
  async function openRun() {
    await dueInquiries(3);
    const real = directDispatch(deps(), tenantId, agentActorId(tenantId), agentAuthorize);
    let drafts = 0;
    const flaky = async (command: ActionCommand) => {
      if (command.actionType === "agent.followup.draft" && ++drafts === 2) throw new Error("connection lost");
      return real(command);
    };
    const key = `schedule:${randomUUID()}`;
    await expect(runFollowUps({
      db: database.db, clock, model: createFakeFollowUpModel(), config: { maxCandidatesPerRun: 3 }, dispatch: flaky, report: () => undefined,
    }, tenantId, { key, requestedBy: null })).rejects.toThrow("connection lost");
    return { runId: followUpRunId(tenantId, key), real };
  }

  it("closes a run that stayed running with the counts that committed, and refuses its late step", async () => {
    const { runId, real } = await openRun();
    const agent = createFollowUpAgent(deps(), { model: createFakeFollowUpModel(), maxCandidatesPerRun: 3 });
    expect(await service((tx) => stalledRuns(tx, clock.now(), 15 * 60_000))).toEqual([]);
    now += 16 * 60_000;
    expect(await service((tx) => stalledRuns(tx, clock.now(), 15 * 60_000))).toEqual([{ tenantId, runId, agentKind: "inquiry_followup" }]);

    const closed = await agent.stallRun(tenantId, runId);
    // The failed candidate does not stop the run: the third was drafted too. Three model calls were made.
    expect(closed).toMatchObject({ status: "stopped", stopReason: "stalled", considered: 2, drafted: 2, skipped: 0 });
    expect(Number((await runTotals(runId)).cost_micros)).toBe(3 * costOf(120, 60));
    expect(await service((tx) => stalledRuns(tx, clock.now(), 15 * 60_000))).toEqual([]);
    // A repeat returns the closed run unchanged.
    expect(await agent.stallRun(tenantId, runId)).toEqual(closed);

    // A late step of the stalled run is refused.
    const [item] = await rows<{ id: string; contact_id: string }>(
      `SELECT i.id, i.contact_id FROM intake_items i WHERE i.tenant_id=$1 AND NOT EXISTS
         (SELECT 1 FROM agent_followups f WHERE f.tenant_id=i.tenant_id AND f.intake_item_id=i.id) ORDER BY i.id LIMIT 1`, [tenantId]);
    const followupId = randomUUID();
    const late = await rejection(real({
      actionType: "agent.followup.skip", idempotencyKey: `agent:late:${followupId}`,
      target: { tenantId, type: "agent_followup", id: followupId }, approvalReference: { tenantId, id: randomUUID() },
      payload: { followupId, runId, intakeItemId: item!.id, contactId: item!.contact_id, reason: "suppressed" },
    }));
    expect(late).toBeInstanceOf(Conflict);
    expect(late.details).toMatchObject({ reason: "run_closed" });
  });

  it("leaves a run that finished first as it is", async () => {
    await dueInquiries(1);
    const agent = createFollowUpAgent(deps(), { model: createFakeFollowUpModel(), maxCandidatesPerRun: 3 });
    const done = await agent.runScheduled(tenantId, randomUUID());
    expect(await agent.stallRun(tenantId, done.id)).toMatchObject({ status: "completed", stopReason: null, drafted: 1 });
  });

  it("only the run's own kind's principal may stall it, and a run of another tenant is not found", async () => {
    const { runId } = await openRun();
    const asReview = directDispatch(deps(), tenantId, agentActorId(tenantId, "review_request"), agentAuthorizeFor("review_request"));
    const stall = (kind: AgentKind) => asReview({
      actionType: "agent.run.stall", idempotencyKey: `agent:${kind}:stall:${runId}`, target: { tenantId, type: "agent_run", id: runId },
      approvalReference: { tenantId, id: randomUUID() }, payload: { runId, agentKind: kind },
    });
    // The review agent cannot close the follow-up agent's run, whichever kind it names.
    await expect(stall("inquiry_followup")).rejects.toBeInstanceOf(TenantDenied);
    await expect(stall("review_request")).rejects.toBeInstanceOf(TenantDenied);
    expect((await rows<{ status: string }>("SELECT status FROM agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId]))[0]!.status).toBe("running");
    const asOther = directDispatch(deps(), fixture.b.tenantId, agentActorId(fixture.b.tenantId), agentAuthorize);
    await expect(asOther({
      actionType: "agent.run.stall", idempotencyKey: `agent:x:${runId}`, target: { tenantId: fixture.b.tenantId, type: "agent_run", id: runId },
      approvalReference: { tenantId: fixture.b.tenantId, id: randomUUID() }, payload: { runId, agentKind: "inquiry_followup" },
    })).rejects.toBeInstanceOf(ActionError);
  });
});

describe("agent kinds (G-14)", () => {
  const OTHER_KINDS = AGENT_KINDS.filter((kind) => kind !== "inquiry_followup");

  it("every other kind is off by default and has its own switch", async () => {
    const owners = sessionFor(owner);
    for (const kind of OTHER_KINDS) {
      expect(await owners.getAgentKindStatus(kind)).toMatchObject({
        agentKind: kind, canRun: false, blockedBy: "disabled", revision: 0, killed: null, settings: { enabled: false },
      });
    }
    // Turn one on; the others stay off, and so does the follow-up agent's own row.
    const review = await owners.getAgentKindStatus("review_request");
    const enabled = (await owners.updateAgentKindSettings("review_request", {
      ...review.settings, enabled: true, quietStartMinute: 0, quietEndMinute: 0, config: { timingHours: 48 }, expectedRevision: review.revision,
    }, randomUUID())).result;
    expect(enabled).toMatchObject({
      canRun: true, blockedBy: null, revision: 1,
      settings: { enabled: true, config: { timingHours: 48, lookbackDays: 7, contactWindowDays: 180, maxSendsPerDay: 20 } },
    });
    expect((await owners.getAgentKindStatus("appointment_reminder")).canRun).toBe(false);

    // Staff kill one kind; only that kind stops, and only an owner resumes it.
    const killed = (await sessionFor(staff).killAgentKind("review_request", { note: "Too chatty" }, randomUUID())).result;
    expect(killed).toMatchObject({ canRun: false, blockedBy: "tenant_killed", killed: { by: staff, note: "Too chatty" } });
    expect(await owners.getFollowUpStatus()).toMatchObject({ canDraft: true, killed: null });
    await expect(sessionFor(staff).resumeAgentKind("review_request", {}, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    expect((await owners.resumeAgentKind("review_request", {}, randomUUID())).result).toMatchObject({ canRun: true, killed: null });

    // Killing the follow-up agent leaves the others alone.
    await owners.killFollowUp({ note: "Stop" }, randomUUID());
    expect((await owners.getAgentKindStatus("review_request")).canRun).toBe(true);
  });

  it("refuses a config its kind does not allow, a stale revision, and the follow-up kind on the generic routes", async () => {
    const owners = sessionFor(owner);
    const status = await owners.getAgentKindStatus("document_intake");
    const update = (body: Record<string, unknown>, kind = "document_intake") =>
      owners.updateAgentKindSettings(kind, { ...status.settings, expectedRevision: status.revision, ...body }, randomUUID());
    await expect(update({ config: { maxPagesPerDocument: 500 } })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(update({ config: { sendLimit: 5 } })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(update({ config: { maxPagesPerDocument: 10 } }, "inquiry_followup")).rejects.toBeInstanceOf(ValidationFailed);
    expect((await rejection(update({}, "not_a_kind"))).code).toBe("ValidationFailed");
    await expect(owners.killAgentKind("inquiry_followup", {}, randomUUID())).rejects.toBeInstanceOf(ValidationFailed);
    await update({ enabled: true, config: { maxPagesPerDocument: 10 } });
    expect((await rejection(update({ config: {} }))).details).toMatchObject({ reason: "stale_revision", currentRevision: 1 });
  });

  it("one kind's principal is denied another kind's actions", async () => {
    const run = (kind: AgentKind, actionType: string, payload: Record<string, unknown>, type = "agent_settings", id = tenantId) =>
      directDispatch(deps(), tenantId, agentActorId(tenantId, kind), agentAuthorizeFor(kind))({
        actionType, idempotencyKey: `agent:denied:${randomUUID()}`, target: { tenantId, type, id },
        approvalReference: { tenantId, id: randomUUID() }, payload: payload as ActionCommand["payload"],
      });
    // The warning is each kind's own; the follow-up actions belong to the follow-up agent alone.
    await expect(run("review_request", "agent.cost.warn", { agentKind: "inquiry_followup", localDate: "2026-11-20" })).rejects.toBeInstanceOf(TenantDenied);
    await expect(run("review_request", "agent.run.start", { runId: randomUUID() }, "agent_run", randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(run("review_request", "agent.followup.draft", {}, "agent_followup", randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    // No agent runs a member action, and the follow-up agent's actor cannot pass as another kind.
    await expect(run("inquiry_followup", "agent.kind.kill", { agentKind: "review_request" })).rejects.toBeInstanceOf(TenantDenied);
    const impostor = directDispatch(deps(), tenantId, agentActorId(tenantId), agentAuthorizeFor("review_request"));
    await expect(impostor({
      actionType: "agent.cost.warn", idempotencyKey: `agent:denied:${randomUUID()}`, target: { tenantId, type: "agent_settings", id: tenantId },
      approvalReference: { tenantId, id: randomUUID() }, payload: { agentKind: "review_request", localDate: "2026-11-20" },
    })).rejects.toBeInstanceOf(TenantDenied);
    // Its own kind, its own warning: allowed.
    await expect(run("review_request", "agent.cost.warn", { agentKind: "review_request", localDate: "2026-11-20" })).resolves.toBeDefined();
  });
});

describe("new tables under the runtime role (G-14, G-15)", () => {
  it("keeps agent_decisions append-only and agent_model_calls settle-once", async () => {
    const runId = randomUUID();
    const contactId = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO agent_runs (tenant_id,id,agent,started_at,max_decisions) VALUES ($1,$2,'review_request',$3,5)", [tenantId, runId, new Date(now)]);
      await tx.query("INSERT INTO crm_contacts (tenant_id,id,display_name,created_at,updated_at) VALUES ($1,$2,'Kai',$3,$3)", [tenantId, contactId, new Date(now)]);
    });
    const decisionId = randomUUID();
    const write = (sql: string, params: unknown[]) => database.db.tenant(tenantId, (tx) => tx.query(sql, params));
    await write(
      `INSERT INTO agent_decisions (tenant_id,id,run_id,agent_kind,subject_type,subject_id,contact_id,outcome,reason,created_at)
       VALUES ($1,$2,$3,'review_request','booking',$4,$5,'skipped','suppressed',$6)`,
      [tenantId, decisionId, runId, randomUUID(), contactId, new Date(now)],
    );
    await expect(write("UPDATE agent_decisions SET reason='no_address' WHERE tenant_id=$1 AND id=$2", [tenantId, decisionId])).rejects.toThrow();
    await expect(write("DELETE FROM agent_decisions WHERE tenant_id=$1 AND id=$2", [tenantId, decisionId])).rejects.toThrow();
    // A decision cannot name another kind's run.
    await expect(write(
      `INSERT INTO agent_decisions (tenant_id,id,run_id,agent_kind,subject_type,subject_id,outcome,reason,created_at)
       VALUES ($1,$2,$3,'document_intake','document',$4,'skipped','too_long',$5)`,
      [tenantId, randomUUID(), runId, randomUUID(), new Date(now)],
    )).rejects.toThrow();

    const callId = randomUUID();
    const callKey = `agent:review_request:model:${runId}:${decisionId}:0`;
    await write(
      `INSERT INTO agent_model_calls (tenant_id,id,call_key,run_id,agent_kind,subject_id,lane,model,input_tokens,output_tokens,cost_micros,outcome,created_at)
       VALUES ($1,$2,$3,$4,'review_request',$5,'personal_data','fake-follow-up',10,10,100,'started',$6)`,
      [tenantId, callId, callKey, runId, decisionId, new Date(now)],
    );
    await expect(write(
      `INSERT INTO agent_model_calls (tenant_id,id,call_key,agent_kind,lane,model,input_tokens,output_tokens,cost_micros,outcome,created_at)
       VALUES ($1,$2,$3,'review_request','personal_data','fake-follow-up',1,1,1,'started',$4)`,
      [tenantId, randomUUID(), callKey, new Date(now)],
    )).rejects.toThrow();
    await write("UPDATE agent_model_calls SET outcome='ok', cost_micros=7 WHERE tenant_id=$1 AND id=$2", [tenantId, callId]);
    await expect(write("UPDATE agent_model_calls SET cost_micros=1 WHERE tenant_id=$1 AND id=$2", [tenantId, callId])).rejects.toThrow();
    await expect(write("UPDATE agent_model_calls SET lane='no_personal_data' WHERE tenant_id=$1 AND id=$2", [tenantId, callId])).rejects.toThrow();
    await expect(write("DELETE FROM agent_model_calls WHERE tenant_id=$1 AND id=$2", [tenantId, callId])).rejects.toThrow();
    // Tenant B sees none of it.
    const other = await database.db.tenant(fixture.b.tenantId, (tx) => tx.query("SELECT 1 FROM agent_model_calls UNION ALL SELECT 1 FROM agent_decisions"));
    expect(other.rows).toHaveLength(0);
  });
});
