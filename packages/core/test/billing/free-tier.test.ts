// Self-sign-up allowances (docs/requirements/plans.md PL-27) against the local Postgres with a manual clock and the
// in-process fake Stripe. Walks a tenant from sign-up through permitted agent use, each limit, an upgrade, a failed
// payment and a cancellation; operator-created and granted tenants keep what they had. Synthetic data.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CANCEL_BOOKING_ACTION, FREE_PLAN_LIMITS, MESSAGE_SEND_REQUESTED, PLAN_CATALOG, planModelCapMicros,
  type ActionCommand, type AgentKind, type HubPlan, type PlanInterval,
} from "@zs/contracts";
import {
  createAutomationAdmin, createBillingWorker, createDispatcher, createSession, createStripeSubscriptionReader,
  dueFollowUpTenants, lockTenantPlan, markSelfSignup, planGate, setPlanGrant, type ActionHandler, type Session,
} from "../../src/index.js";
import { reserveModelCall } from "../../src/agents/cost.js";
import { startFakeStripePlans, type FakeStripePlans } from "./fake-stripe-plans.js";
import { createBillingHarness, stripeId, type BillingHarness } from "./helpers.js";
import { PLAN_SECRET_KEY, plansClient, READ_KEY, subscription } from "./plan-helpers.js";

const DAY = 86_400_000;
let b: BillingHarness;
let fake: FakeStripePlans;
beforeAll(async () => {
  b = await createBillingHarness();
  fake = await startFakeStripePlans({ secretKeys: [PLAN_SECRET_KEY, READ_KEY], clock: () => b.h.clock.now() });
});
afterEach(async () => {
  await b.settle();
  fake.subscriptions.clear();
});
afterAll(async () => {
  await fake?.close();
  await b?.close();
});

const planSession = async (tenantId: string): Promise<Session> =>
  createSession({
    db: b.h.database.db, clock: b.h.clock, generateId: randomUUID,
    billing: { stripe: b.stripe.client, plans: plansClient(fake.url, { trialDays: 14 }) },
  }, { tenantId, actorId: await b.owner(tenantId) });
const worker = () => createBillingWorker({
  service: b.h.service, clock: b.h.clock, generateId: randomUUID, config: { planGraceDays: 7, backoffBaseMs: 1 },
  subscriptions: createStripeSubscriptionReader({ config: { secretKey: READ_KEY, baseUrl: fake.url } }),
});

/** Public sign-up (B09) as far as the plan goes: a new tenant with its owner, marked free. */
async function signUp(): Promise<string> {
  const tenantId = await b.tenant();
  await b.h.service((tx) => markSelfSignup(tx, { tenantId, now: b.h.clock.now() }));
  return tenantId;
}

async function subscribe(tenantId: string, input: { plan?: HubPlan; interval?: PlanInterval; status?: string } = {}) {
  const started = await (await planSession(tenantId)).startPlanCheckout(
    { plan: input.plan ?? "studio", interval: input.interval ?? "month", extraConnections: 0 }, `plan-${randomUUID()}`);
  const customer = stripeId("cus");
  const sub = subscription({ id: stripeId("sub"), customer, tenantId, checkoutId: started.checkout.id, status: input.status ?? "active",
    at: b.h.clock.now(), plan: input.plan ?? "studio", interval: input.interval ?? "month" });
  fake.subscriptions.set(sub.id, sub);
  await b.deliver(b.event("checkout.session.completed", {
    id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: "complete", customer, subscription: sub.id,
    metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id },
  }));
  await worker().runOnce();
  return sub;
}

const gate = (tenantId: string, action: string, payload?: unknown) =>
  b.h.database.db.tenant(tenantId, (tx) => planGate(tx, tenantId, action, b.h.clock.now(), payload));
const limitOf = (resource: string, limit: number) => ({ code: "Conflict", details: { reason: "plan_limit", resource, limit } });
const invite = (session: Session) => session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID());
const createToken = async (tenantId: string) =>
  createAutomationAdmin(b.deps(), { keySecrets: { current: ["test", "free", "k".repeat(32)].join("-") } }, { tenantId, actorId: await b.owner(tenantId) })
    .createToken({ name: "flow", scopes: ["contacts:propose"] }, `token-${randomUUID()}`);
const enableKind = (agentKind: string) => ({
  agentKind, enabled: true, quietStartMinute: 0, quietEndMinute: 0, timeZone: "UTC", expectedRevision: 0, config: {},
});
const addConnection = (tenantId: string) => b.h.service(async (tx) => {
  const member = (await tx.query<{ id: string }>("SELECT id FROM tenant_members WHERE tenant_id=$1 AND role='owner' LIMIT 1", [tenantId])).rows[0]!;
  await tx.query(
    `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
     VALUES ($1,$2,'composio','gmail',$3,'1','haldenrowe.example','Mail','active',$4,$5,$5,$5)`,
    [tenantId, randomUUID(), `ca_${randomUUID().slice(0, 8)}`, member.id, b.h.clock.now()]);
});
const addResource = (tenantId: string) => b.h.service((tx) => tx.query(
  `INSERT INTO booking_resources (tenant_id, id, name, time_zone, weekly, overrides, slot_length_minutes, slot_step_minutes,
     buffer_before_minutes, buffer_after_minutes, minimum_notice_minutes, booking_horizon_minutes)
   VALUES ($1,$2,'Chair','UTC','[]'::jsonb,'[]'::jsonb,30,30,0,0,0,43200)`, [tenantId, randomUUID()]));

// A handler that queues one email, named as a real sending action, so the dispatcher's email gate sees it end to end.
const queueEmail: ActionHandler = {
  resolveTarget: async (_tx, target) => target,
  handle: async ({ command }) => ({
    result: { queued: true },
    event: { type: MESSAGE_SEND_REQUESTED, payload: {
      messageId: randomUUID(), contactId: command.target.id, channel: (command.payload as { channel: string }).channel,
      purpose: "transactional", subject: "Your visit", body: "See you soon.",
    } },
  }),
};
const dispatchEmail = createDispatcher({ "inbox.reply.send": queueEmail, [CANCEL_BOOKING_ACTION]: queueEmail });
async function sendEmail(tenantId: string, actionType = "inbox.reply.send", channel = "email") {
  const actorId = await b.owner(tenantId);
  const command: ActionCommand = {
    actionType, target: { tenantId, id: randomUUID(), type: "test_message" }, payload: { channel },
    approvalReference: { tenantId, id: randomUUID() }, idempotencyKey: randomUUID(),
  };
  const binding = { tenantId, actorId, actionType, target: command.target, payload: command.payload, approvalReference: command.approvalReference };
  return dispatchEmail({
    tenantId, actor: { id: actorId, tenantId }, db: b.h.database.db, clock: b.h.clock, generateId: randomUUID, config: {},
    resolveApproval: async () => binding,
  }, command);
}
const emailsUsed = async (tenantId: string) => (await b.h.rows<{ n: number }>(
  "SELECT count(*)::int AS n FROM outbox WHERE tenant_id=$1 AND event_type=$2 AND payload->>'channel'='email'", [tenantId, MESSAGE_SEND_REQUESTED]))[0]!.n;

const reserve = (tenantId: string, costMicros: number, kind: AgentKind = "appointment_reminder") => b.h.database.db.tenant(tenantId, (tx) => reserveModelCall(tx, tenantId, {
  callKeyBase: `test:${randomUUID()}`, runId: null, kind, subjectId: randomUUID(), lane: "no_personal_data", model: "fake-model",
}, { inputTokens: 1, outputTokens: 1, costMicros }, b.h.clock.now()));
/** `count` emails the tenant already queued, written straight to `actions` and `outbox` (a paid plan's allowance is large). */
const seedEmails = (tenantId: string, count: number) => b.h.service(async (tx) => {
  const actorId = (await tx.query<{ id: string }>("SELECT id FROM tenant_members WHERE tenant_id=$1 AND role='owner' LIMIT 1", [tenantId])).rows[0]!.id;
  await tx.query(
    `WITH a AS (
       INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
       SELECT $1::uuid, gen_random_uuid(), $2, 'inbox.reply.send', jsonb_build_object('tenantId',$1::text,'type','test_message','id',gen_random_uuid()),
              '{}'::jsonb, 'seed-' || gen_random_uuid(), '{}'::jsonb, $3 FROM generate_series(1, $4) RETURNING id)
     INSERT INTO outbox (tenant_id,id,action_id,event_type,payload,created_at)
     SELECT $1::uuid, gen_random_uuid(), id, $5, '{"channel":"email"}'::jsonb, $3 FROM a`,
    [tenantId, actorId, b.h.clock.now(), count, MESSAGE_SEND_REQUESTED]);
});
const setKindCap = (tenantId: string, kind: AgentKind, micros: number, enabled = false) => b.h.service((tx) => tx.query(
  `INSERT INTO agent_settings (tenant_id, agent_kind, enabled, updated_at, max_cost_micros_per_day, quiet_start_minute, quiet_end_minute, time_zone)
   VALUES ($1,$2,$3,$4,$5,0,0,'UTC')
   ON CONFLICT (tenant_id, agent_kind) DO UPDATE SET max_cost_micros_per_day=EXCLUDED.max_cost_micros_per_day, enabled=EXCLUDED.enabled`,
  [tenantId, kind, enabled, b.h.clock.now(), micros]));

describe("a self-signed-up tenant holds the free allowances (PL-27)", () => {
  it("sign-up gives the free limits, never read-only, and the plan read names them", async () => {
    const tenantId = await signUp();
    const view = await (await planSession(tenantId)).getBillingPlan();
    expect(view).toMatchObject({ status: "none", plan: null, readOnly: false, limits: FREE_PLAN_LIMITS });
    // Idempotent: a second mark changes nothing.
    await b.h.service((tx) => markSelfSignup(tx, { tenantId, now: b.h.clock.now() }));
    expect((await b.h.rows("SELECT free_tier FROM tenant_plans WHERE tenant_id=$1", [tenantId]))[0]).toMatchObject({ free_tier: true });
  });

  it("permits agent use within the allowances: a templated agent switches on and a small model call is reserved", async () => {
    const tenantId = await signUp();
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("appointment_reminder"))).resolves.toBeUndefined();
    await expect(gate(tenantId, "agent.kind.settings.update", { ...enableKind("inquiry_followup"), enabled: false })).resolves.toBeUndefined();
    expect(await reserve(tenantId, 10_000)).toMatchObject({ status: "reserved", capMicros: planModelCapMicros(FREE_PLAN_LIMITS) });
    await expect(sendEmail(tenantId)).resolves.toBeDefined();
  });

  it("refuses at each limit: seats, resources, connections, tokens, model agents, the model budget and emails", async () => {
    const tenantId = await signUp();
    const session = await planSession(tenantId);
    // Seats: the owner holds the one seat.
    await expect(invite(session)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "seats", limit: 1, used: 1 } });
    // Resources: one; a template apply would add a second.
    await expect(gate(tenantId, "tenant.template.apply")).resolves.toBeUndefined();
    await addResource(tenantId);
    await expect(gate(tenantId, "tenant.template.apply")).rejects.toMatchObject(limitOf("bookableResources", 1));
    // Connections: one.
    await expect(gate(tenantId, "connection.connect")).resolves.toBeUndefined();
    await addConnection(tenantId);
    await expect(gate(tenantId, "connection.connect")).rejects.toMatchObject(limitOf("managedConnections", 1));
    // Tokens: one, the creator's site token (PL-25).
    await expect(createToken(tenantId)).resolves.toBeDefined();
    await expect(createToken(tenantId)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "automationTokens", limit: 1, used: 1 } });
    // Model agents: the follow-up agent cannot be switched on or started, by either settings route.
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.settings.update", { enabled: true })).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.run.start", { runId: randomUUID() })).rejects.toMatchObject(limitOf("modelAgents", 0));
    // A resume restarts the agent's runs, so it is refused too; a templated kind's resume is not.
    await expect(gate(tenantId, "agent.resume", {})).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.kind.resume", { agentKind: "inquiry_followup" })).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.kind.resume", { agentKind: "appointment_reminder" })).resolves.toBeUndefined();
    // Model budget: 5 cents a day per kind; a call that would pass it is not made.
    const cap = planModelCapMicros(FREE_PLAN_LIMITS);
    expect(await reserve(tenantId, cap - 1)).toMatchObject({ status: "reserved" });
    expect(await reserve(tenantId, 2)).toMatchObject({ status: "cost_cap", capMicros: cap });
    // Emails: 100 in 30 days; the 101st is refused and nothing is recorded for it.
    for (let i = 0; i < FREE_PLAN_LIMITS.emailsPerMonth; i += 1) await sendEmail(tenantId);
    await expect(sendEmail(tenantId)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "emailsPerMonth", limit: 100, used: 100 } });
    expect(await emailsUsed(tenantId)).toBe(100);
    // A text is not an email, and a booking notice is counted but never refused.
    await expect(sendEmail(tenantId, "inbox.reply.send", "sms")).resolves.toBeDefined();
    await expect(sendEmail(tenantId, CANCEL_BOOKING_ACTION)).resolves.toBeDefined();
    expect(await emailsUsed(tenantId)).toBe(101);
    // The window rolls: 30 days later the allowance is free again.
    b.h.clock.advance(30 * DAY);
    await expect(sendEmail(tenantId)).resolves.toBeDefined();
  });

  it("two concurrent sends at the last email slot: exactly one wins", async () => {
    const tenantId = await signUp();
    for (let i = 0; i < FREE_PLAN_LIMITS.emailsPerMonth - 1; i += 1) await sendEmail(tenantId);
    const results = await Promise.allSettled([sendEmail(tenantId), sendEmail(tenantId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { details: { reason: "plan_limit", resource: "emailsPerMonth" } } });
    expect(await emailsUsed(tenantId)).toBe(100);
  });

  it("an upgrade lifts the limits to the paid plan's, and the plan's own model and email rows are enforced", async () => {
    const tenantId = await signUp();
    const session = await planSession(tenantId);
    await expect(invite(session)).rejects.toMatchObject(limitOf("seats", 1));
    await subscribe(tenantId, { plan: "studio", status: "active" });
    expect(await session.getBillingPlan()).toMatchObject({ plan: "studio", status: "active", readOnly: false, limits: PLAN_CATALOG.studio.limits });
    await expect(invite(session)).resolves.toBeDefined();
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).resolves.toBeUndefined();
    expect(await reserve(tenantId, planModelCapMicros(FREE_PLAN_LIMITS) + 1)).toMatchObject({ status: "reserved" });
  });

  it("a solo plan holds no model agents: the follow-up agent is refused there too", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "solo", status: "active" });
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).rejects.toMatchObject(limitOf("modelAgents", 0));
  });

  it("a failed payment keeps the paid plan through the grace, then drops to the free allowances, never read-only", async () => {
    const tenantId = await signUp();
    const sub = await subscribe(tenantId, { plan: "studio", status: "active" });
    fake.subscriptions.set(sub.id, { ...sub, status: "past_due" });
    await b.deliver(b.event("invoice.payment_failed", {
      id: stripeId("in"), object: "invoice", customer: sub.customer, amount_due: 9_900, currency: "usd",
      parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
      status_transitions: { paid_at: null },
    }));
    await worker().runOnce();
    const session = await planSession(tenantId);
    expect(await session.getBillingPlan()).toMatchObject({ status: "past_due", readOnly: false, limits: PLAN_CATALOG.studio.limits });
    b.h.clock.advance(8 * DAY);
    expect(await session.getBillingPlan()).toMatchObject({ status: "past_due", readOnly: false, limits: FREE_PLAN_LIMITS });
    await expect(gate(tenantId, "booking.create")).resolves.toBeUndefined();
    await expect(invite(session)).rejects.toMatchObject(limitOf("seats", 1));
  });

  it("a cancellation returns the tenant to the free allowances, where a tenant that never self-signed-up is read-only", async () => {
    const tenantId = await signUp();
    const sub = await subscribe(tenantId, { plan: "studio", status: "active" });
    const ended = { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) };
    fake.subscriptions.set(sub.id, ended);
    await b.deliver(b.event("customer.subscription.deleted", { ...ended }));
    await worker().runOnce();
    const view = await (await planSession(tenantId)).getBillingPlan();
    expect(view).toMatchObject({ status: "canceled", readOnly: false, limits: FREE_PLAN_LIMITS });
    await expect(gate(tenantId, "booking.create")).resolves.toBeUndefined();
    await expect(gate(tenantId, "agent.run.start", {})).rejects.toMatchObject(limitOf("modelAgents", 0));

    // The same cancellation on an operator-created tenant (no mark) stays read-only, as before (PL-8).
    const operatorMade = await b.tenant();
    const other = await subscribe(operatorMade, { plan: "studio", status: "active" });
    const otherEnded = { ...other, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) };
    fake.subscriptions.set(other.id, otherEnded);
    await b.deliver(b.event("customer.subscription.deleted", { ...otherEnded }));
    await worker().runOnce();
    expect(await (await planSession(operatorMade)).getBillingPlan()).toMatchObject({ status: "canceled", readOnly: true });
    // PL-8: a read-only tenant makes no model call either, not even a template suggestion's.
    expect(await reserve(operatorMade, 1)).toMatchObject({ status: "cost_cap", capMicros: 0 });
  });
});

describe("the edges of the allowances (PL-27)", () => {
  it("a paid plan's email row is enforced at its own number", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "studio", status: "active" });
    const limit = PLAN_CATALOG.studio.limits.emailsPerMonth;
    await seedEmails(tenantId, limit - 1);
    await expect(sendEmail(tenantId)).resolves.toBeDefined();
    await expect(sendEmail(tenantId)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "emailsPerMonth", limit, used: limit } });
  });

  it("a kind's own budget above the plan's cap is clamped to the plan's", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "studio", status: "active" });
    await setKindCap(tenantId, "appointment_reminder", 2_000_000);
    const cap = planModelCapMicros(PLAN_CATALOG.studio.limits);
    expect(await reserve(tenantId, cap + 1)).toMatchObject({ status: "cost_cap", capMicros: cap });
    expect(await reserve(tenantId, cap)).toMatchObject({ status: "reserved", capMicros: cap });
  });

  it("a model-assisted kind gets no model call on a plan without model agents, and its drafts are refused", async () => {
    const tenantId = await signUp();
    expect(await reserve(tenantId, 1, "inquiry_followup")).toMatchObject({ status: "cost_cap", capMicros: 0 });
    await expect(gate(tenantId, "agent.followup.draft", {})).rejects.toMatchObject(limitOf("modelAgents", 0));
    // After an upgrade the same kind reserves under the plan's cap.
    await subscribe(tenantId, { plan: "studio", status: "active" });
    expect(await reserve(tenantId, 1, "inquiry_followup")).toMatchObject({ status: "reserved" });
  });

  it("a reservation waits for a plan change under way and reads the cap it leaves", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "studio", status: "active" });
    const free = planModelCapMicros(FREE_PLAN_LIMITS);
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    // A plan event: under the plan lock, the subscription lapses, so this free tenant drops to the free cap.
    const change = b.h.service(async (tx) => {
      await lockTenantPlan(tx, tenantId);
      await tx.query("UPDATE tenant_plans SET read_only_after=$2 WHERE tenant_id=$1", [tenantId, new Date(b.h.clock.now().getTime() - 1)]);
      locked();
      await done;
    });
    await lockTaken;
    let settled = false;
    const reservation = reserve(tenantId, free + 1).finally(() => { settled = true; });
    reservation.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
    } finally {
      // Released whatever happens, so a regression fails this test instead of hanging the pool's shutdown.
      release();
      await change;
    }
    expect(await reservation).toMatchObject({ status: "cost_cap", capMicros: free });
  });

  it("switching on a model agent waits for a plan change under way and is refused by the plan it leaves", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "studio", status: "active" });
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const done = new Promise<void>((resolve) => { release = resolve; });
    const change = b.h.service(async (tx) => {
      await lockTenantPlan(tx, tenantId);
      await tx.query("UPDATE tenant_plans SET read_only_after=$2 WHERE tenant_id=$1", [tenantId, new Date(b.h.clock.now().getTime() - 1)]);
      locked();
      await done;
    });
    await lockTaken;
    let settled = false;
    const enable = gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup")).finally(() => { settled = true; });
    enable.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
    } finally {
      release();
      await change;
    }
    await expect(enable).rejects.toMatchObject(limitOf("modelAgents", 0));
  });

  it("a free tenant whose first payment is still incomplete keeps the free allowances", async () => {
    const tenantId = await signUp();
    await subscribe(tenantId, { plan: "pro", status: "incomplete" });
    expect(await (await planSession(tenantId)).getBillingPlan()).toMatchObject({ status: "incomplete", limits: FREE_PLAN_LIMITS });
    await expect(invite(await planSession(tenantId))).rejects.toMatchObject(limitOf("seats", 1));
  });

  it("the native Shopify link is not a managed connection", async () => {
    const tenantId = await signUp();
    await b.h.service(async (tx) => {
      const member = (await tx.query<{ id: string }>("SELECT id FROM tenant_members WHERE tenant_id=$1 AND role='owner' LIMIT 1", [tenantId])).rows[0]!;
      await tx.query(
        `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
         VALUES ($1,$2,'native','shopify',$3,$4,'Store','active',$5,$6,$6,$6)`,
        [tenantId, randomUUID(), `gid://shopify/Shop/${Date.now()}${Math.floor(Math.random() * 1e6)}`, `s${randomUUID().slice(0, 8)}.myshopify.com`, member.id, b.h.clock.now()]);
    });
    await expect(gate(tenantId, "connection.connect")).resolves.toBeUndefined();
  });

  it("the plan read says a tenant is free, and the offers do not take the free cap's budget block", async () => {
    const tenantId = await signUp();
    // Switched on before a downgrade: the free cap (0 for this kind) blocks it, its own budget has room.
    await setKindCap(tenantId, "inquiry_followup", 1_000_000, true);
    // The follow-up runner is live, so the feature's first reason is its budget (PL-26).
    await b.h.service((tx) => tx.query(
      `INSERT INTO runner_heartbeats (runner, beat_at, fresh_for_seconds) VALUES ('followup',$1,3600)
       ON CONFLICT (runner) DO UPDATE SET beat_at=$1, fresh_for_seconds=3600`, [b.h.clock.now()]));
    const view = await (await planSession(tenantId)).getBillingPlan({ features: true, freeTier: true });
    expect(view.freeTier).toBe(true);
    const studio = view.catalog.find((offer) => offer.plan === "studio")!;
    expect(studio.features?.find((feature) => feature.kind === "inquiry_followup")?.offReason).not.toBe("no_budget");
    expect((await (await planSession(await b.tenant())).getBillingPlan({ features: true, freeTier: true })).freeTier).toBe(false);
    // Spend that Studio's own cap would refuse keeps Studio's budget block, while Pro's larger cap has room.
    await setKindCap(tenantId, "inquiry_followup", 2_000_000, true);
    await b.h.service((tx) => tx.query(
      `INSERT INTO agent_model_calls (tenant_id, id, call_key, run_id, agent_kind, subject_id, lane, model,
         input_tokens, output_tokens, cost_micros, outcome, created_at)
       VALUES ($1, gen_random_uuid(), 'test-spend', NULL, 'inquiry_followup', NULL, 'no_personal_data', 'fake-model', 1, 1, 1200000, 'ok', $2)`,
      [tenantId, b.h.clock.now()]));
    const spent = await (await planSession(tenantId)).getBillingPlan({ features: true });
    const offerReason = (plan: string) => spent.catalog.find((offer) => offer.plan === plan)!.features
      ?.find((feature) => feature.kind === "inquiry_followup")?.offReason;
    expect(offerReason("studio")).toBe("no_budget");
    expect(offerReason("pro")).not.toBe("no_budget");
    // Without its own opt-in the key is left out, so a dashboard built before it still parses the answer.
    expect(await (await planSession(tenantId)).getBillingPlan()).not.toHaveProperty("freeTier");
    expect(await (await planSession(tenantId)).getBillingPlan({ features: true })).not.toHaveProperty("freeTier");
  });
});

describe("tenants that did not self-sign-up keep their behaviour (PL-27)", () => {
  it("an operator-created tenant with no plan stays comped: no limit refuses it", async () => {
    const tenantId = await b.tenant();
    const session = await planSession(tenantId);
    expect(await session.getBillingPlan()).toMatchObject({ status: "none", limits: null, readOnly: false });
    await expect(invite(session)).resolves.toBeDefined();
    await expect(invite(session)).resolves.toBeDefined();
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).resolves.toBeUndefined();
    expect(await reserve(tenantId, 500_000)).toMatchObject({ status: "reserved", capMicros: 1_000_000 });
    for (let i = 0; i < 3; i += 1) await sendEmail(tenantId);
  });

  it("a granted tenant holds the granted plan, free marker or not, and returns to free when the grant ends", async () => {
    const tenantId = await signUp();
    const until = new Date(b.h.clock.now().getTime() + DAY);
    await b.h.service((tx) => setPlanGrant(tx, { tenantId, plan: "pro", until, note: "pilot", by: "Operator", now: b.h.clock.now() }));
    const session = await planSession(tenantId);
    expect(await session.getBillingPlan()).toMatchObject({ limits: PLAN_CATALOG.pro.limits, grant: { plan: "pro" } });
    await expect(invite(session)).resolves.toBeDefined();
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).resolves.toBeUndefined();
    b.h.clock.advance(DAY);
    expect(await session.getBillingPlan()).toMatchObject({ limits: FREE_PLAN_LIMITS });
    await expect(invite(session)).rejects.toMatchObject(limitOf("seats", 1));
  });

  it("the runtime role cannot set the free marker on its own tenant (PL-25)", async () => {
    const tenantId = await b.tenant();
    await expect(b.h.database.db.tenant(tenantId, (tx) => markSelfSignup(tx, { tenantId, now: b.h.clock.now() }))).rejects.toBeDefined();
  });
  it("the follow-up scheduler skips a tenant whose plan holds no model agents, and visits a comped one", async () => {
    const free = await signUp();
    const comped = await b.tenant();
    const on = (tenantId: string) => b.h.service((tx) => tx.query(
      `INSERT INTO agent_settings (tenant_id, agent_kind, enabled, updated_at, max_cost_micros_per_day, quiet_start_minute, quiet_end_minute, time_zone)
       VALUES ($1,'inquiry_followup',true,$2,1000000,0,0,'UTC')`, [tenantId, b.h.clock.now()]));
    await on(free);
    await on(comped);
    const due = await b.h.service((tx) => dueFollowUpTenants(tx, b.h.clock.now(), randomUUID()));
    expect(due.tenantIds).toContain(comped);
    expect(due.tenantIds).not.toContain(free);
  });
});
