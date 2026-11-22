// Self-sign-up allowances (docs/requirements/plans.md PL-27) against the local Postgres with a manual clock and the
// in-process fake Stripe. Walks a tenant from sign-up through permitted agent use, each limit, an upgrade, a failed
// payment and a cancellation; operator-created and granted tenants keep what they had. Synthetic data.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CANCEL_BOOKING_ACTION, FREE_PLAN_LIMITS, MESSAGE_SEND_REQUESTED, PLAN_CATALOG, planModelCapMicros,
  type ActionCommand, type HubPlan, type PlanInterval,
} from "@zs/contracts";
import {
  createAutomationAdmin, createBillingWorker, createDispatcher, createSession, createStripeSubscriptionReader,
  dueFollowUpTenants, markSelfSignup, planGate, setPlanGrant, type ActionHandler, type Session,
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

const reserve = (tenantId: string, costMicros: number) => b.h.database.db.tenant(tenantId, (tx) => reserveModelCall(tx, tenantId, {
  callKeyBase: `test:${randomUUID()}`, runId: null, kind: "appointment_reminder", subjectId: randomUUID(), lane: "no_personal_data", model: "fake-model",
}, { inputTokens: 1, outputTokens: 1, costMicros }, b.h.clock.now()));

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
    // Tokens: none.
    await expect(createToken(tenantId)).rejects.toMatchObject(limitOf("automationTokens", 0));
    // Model agents: the follow-up agent cannot be switched on or started, by either settings route.
    await expect(gate(tenantId, "agent.kind.settings.update", enableKind("inquiry_followup"))).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.settings.update", { enabled: true })).rejects.toMatchObject(limitOf("modelAgents", 0));
    await expect(gate(tenantId, "agent.run.start", { runId: randomUUID() })).rejects.toMatchObject(limitOf("modelAgents", 0));
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
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET free_tier=true WHERE tenant_id=$1", [tenantId]));
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
