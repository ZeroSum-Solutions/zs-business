// Hub plans (docs/requirements/plans.md PL-4..PL-12) against the local Postgres with a manual
// clock and an in-process fake Stripe: checkout, events in any order, dunning and read-only, the
// limits, founding, the Portal and tenancy under the runtime role. All data is synthetic.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLAN_CHECKOUT_CREATE_ACTION, type HubPlan, type PlanInterval } from "@zs/contracts";
import {
  createBillingWorker, createSession, createStripeSubscriptionReader, PLAN_CHECKOUT_LIFETIME_MS, planGate, setFoundingInvite,
  type Session,
} from "../../src/index.js";
import { startFakeStripePlans, type FakeStripePlans } from "./fake-stripe-plans.js";
import { createBillingHarness, stripeId, type BillingHarness } from "./helpers.js";
import { PLAN_RETURN_URL, PLAN_SECRET_KEY, plansClient, READ_KEY, subscription } from "./plan-helpers.js";

const DAY = 86_400_000;
let b: BillingHarness;
let fake: FakeStripePlans;
beforeAll(async () => {
  b = await createBillingHarness();
  fake = await startFakeStripePlans({ secretKeys: [PLAN_SECRET_KEY, READ_KEY] });
});
afterEach(async () => {
  await b.settle();
  fake.subscriptions.clear();
});
afterAll(async () => {
  await fake?.close();
  await b?.close();
});

async function planSession(tenantId: string, options: { plans?: boolean; trialDays?: number; actorId?: string } = {}): Promise<Session> {
  const actorId = options.actorId ?? await b.owner(tenantId);
  return createSession({
    db: b.h.database.db, clock: b.h.clock, generateId: randomUUID,
    billing: { stripe: b.stripe.client, ...(options.plans === false ? {} : { plans: plansClient(fake.url, { trialDays: options.trialDays ?? 14 }) }) },
  }, { tenantId, actorId });
}
const worker = (reader = true) => createBillingWorker({
  service: b.h.service, clock: b.h.clock, generateId: randomUUID, config: { planGraceDays: 7, backoffBaseMs: 1 },
  ...(reader ? { subscriptions: createStripeSubscriptionReader({ config: { secretKey: READ_KEY, baseUrl: fake.url } }) } : {}),
});
const plan = async (tenantId: string) =>
  (await b.h.rows<Record<string, any>>("SELECT * FROM tenant_plans WHERE tenant_id=$1", [tenantId]))[0];
const checkoutRow = async (tenantId: string, id: string) =>
  (await b.h.rows<Record<string, any>>("SELECT * FROM plan_checkouts WHERE tenant_id=$1 AND id=$2", [tenantId, id]))[0]!;
const lastForm = () => fake.received.filter((r) => r.path === "/v1/checkout/sessions").at(-1)!;

/** A checkout, its completion and its subscription: the tenant ends on `status`. */
async function subscribe(tenantId: string, input: { plan?: HubPlan; interval?: PlanInterval; status?: string; extraConnections?: number } = {}) {
  const started = await (await planSession(tenantId)).startPlanCheckout(
    { plan: input.plan ?? "studio", interval: input.interval ?? "month", extraConnections: input.extraConnections ?? 0 }, `plan-${randomUUID()}`);
  const customer = (await plan(tenantId))?.stripe_customer_id ?? stripeId("cus");
  const sub = subscription({
    id: stripeId("sub"), customer, tenantId, checkoutId: started.checkout.id, status: input.status ?? "active", at: b.h.clock.now(),
    plan: input.plan ?? "studio", interval: input.interval ?? "month", founding: started.checkout.founding,
    ...(input.extraConnections ? { extraConnections: input.extraConnections } : {}),
  });
  fake.subscriptions.set(sub.id, sub);
  await b.deliver(b.event("checkout.session.completed", {
    id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: "complete", customer, subscription: sub.id,
    metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id },
  }));
  await worker().runOnce();
  return { started, sub, customer };
}
const subEvent = (type: string, sub: ReturnType<typeof subscription>) => b.event(type, { ...sub });
const invoiceEvent = (type: string, sub: ReturnType<typeof subscription>, invoiceId: string) => b.event(type, {
  id: invoiceId, object: "invoice", customer: sub.customer, amount_due: 9_900, currency: "usd",
  parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
  status_transitions: { paid_at: type === "invoice.paid" ? Math.floor(b.h.clock.now().getTime() / 1000) : null },
});

describe("starting a plan checkout (PL-4, PL-5)", () => {
  it("stores the terms and asks Stripe for a subscription session derived from them", async () => {
    const tenantId = await b.tenant();
    const createdAt = b.h.clock.now();
    const result = await (await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month", extraConnections: 2 }, "plan-key-1");
    expect(result.checkout).toMatchObject({ plan: "pro", interval: "month", extraConnections: 2, founding: false, trialDays: 14, status: "pending" });
    expect(result.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const sent = lastForm();
    expect(sent.headers["idempotency-key"]).toBe(`zsp-${result.checkout.id}`);
    expect(sent.form).toMatchObject({
      mode: "subscription", "line_items[0][price]": "price_hub_pro_month", "line_items[0][quantity]": "1",
      "line_items[1][price]": "price_hub_connection_month", "line_items[1][quantity]": "2",
      "metadata[zs_tenant]": tenantId, "metadata[zs_checkout]": result.checkout.id,
      "subscription_data[metadata][zs_tenant]": tenantId, "subscription_data[trial_period_days]": "14",
      success_url: `${PLAN_RETURN_URL}?checkout=success`, cancel_url: `${PLAN_RETURN_URL}?checkout=cancelled`,
      payment_method_collection: "always", expires_at: String(Math.floor((createdAt.getTime() + PLAN_CHECKOUT_LIFETIME_MS) / 1000)),
    });
    expect(sent.form.customer).toBeUndefined();
    // A repeat with the same key answers the stored URL and calls Stripe no more.
    const calls = fake.received.length;
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month", extraConnections: 2 }, "plan-key-1"))
      .resolves.toEqual(result);
    expect(fake.received.length).toBe(calls);
  });

  it("refuses a second open checkout, an annual add-on, a staff member and a hub without plans", async () => {
    const tenantId = await b.tenant();
    const first = await (await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`);
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "year" }, `plan-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "checkout_open", checkoutUrl: first.checkoutUrl } });
    b.h.clock.advance(PLAN_CHECKOUT_LIFETIME_MS + 1);
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "year", extraConnections: 1 }, `plan-${randomUUID()}`))
      .rejects.toMatchObject({ code: "ValidationFailed" });
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "year" }, `plan-${randomUUID()}`)).resolves.toBeDefined();
    await b.session(tenantId, { role: "staff" });
    const staffPlans = await planSession(tenantId, { actorId: (await b.h.rows<{ user_id: string }>(
      "SELECT user_id FROM tenant_members WHERE tenant_id=$1 AND role='staff' LIMIT 1", [tenantId]))[0]!.user_id });
    await expect(staffPlans.startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`)).rejects.toMatchObject({ code: "TenantDenied" });
    await expect((await planSession(tenantId, { plans: false })).startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`))
      .rejects.toMatchObject({ code: "NotFound" });
  });

  it("refuses a tenant that already holds a plan, offers no second trial and reuses the customer", async () => {
    const tenantId = await b.tenant();
    const { sub, customer } = await subscribe(tenantId);
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month" }, `plan-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "plan_exists" } });
    fake.subscriptions.set(sub.id, { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) });
    await b.deliver(subEvent("customer.subscription.deleted", fake.subscriptions.get(sub.id)!));
    await worker().runOnce();
    const again = await (await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month" }, `plan-${randomUUID()}`);
    expect(again.checkout.trialDays).toBe(0);
    expect(lastForm().form.customer).toBe(customer);
    expect(lastForm().form["subscription_data[trial_period_days]"]).toBeUndefined();
  });
});

describe("applying plan events (PL-10)", () => {
  it("derives the plan from Stripe's answer, whatever order the events arrive in", async () => {
    const tenantId = await b.tenant();
    const started = await (await planSession(tenantId)).startPlanCheckout({ plan: "studio", interval: "month", extraConnections: 1 }, `plan-${randomUUID()}`);
    const customer = stripeId("cus");
    const sub = subscription({ id: stripeId("sub"), customer, tenantId, checkoutId: started.checkout.id, status: "trialing",
      at: b.h.clock.now(), plan: "studio", extraConnections: 1, trialEnd: new Date(b.h.clock.now().getTime() + 14 * DAY) });
    fake.subscriptions.set(sub.id, sub);
    // The update first, before Stripe even says the checkout completed: the metadata names our checkout.
    await b.deliver(subEvent("customer.subscription.updated", sub));
    await b.deliver(b.event("checkout.session.completed", { id: stripeId("cs"), object: "checkout.session", mode: "subscription",
      customer, subscription: sub.id, metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id } }));
    await b.deliver(subEvent("customer.subscription.created", { ...sub, status: "incomplete" }));
    const run = await worker().runOnce();
    expect(run.outcomes).toEqual({ plan_synced: 3 });
    expect(await plan(tenantId)).toMatchObject({
      plan: "studio", plan_interval: "month", status: "trialing", extra_connections: 1, stripe_customer_id: customer,
      stripe_subscription_id: sub.id, trial_used: true, read_only_after: null,
    });
    expect((await checkoutRow(tenantId, started.checkout.id)).status).toBe("completed");
    const view = await (await planSession(tenantId)).getBillingPlan();
    expect(view).toMatchObject({ status: "trialing", plan: "studio", readOnly: false, trialAvailable: false, portalEnabled: true,
      limits: { managedConnections: 4, seats: 6 } });
  });

  it("waits for an unknown subscription, waits without a read key, and drops one Stripe does not know", async () => {
    const tenantId = await b.tenant();
    const stranger = subscription({ id: stripeId("sub"), customer: stripeId("cus"), tenantId: randomUUID(), status: "active", at: b.h.clock.now() });
    const waiting = b.event("customer.subscription.updated", { ...stranger, metadata: {} });
    await b.deliver(waiting);
    expect((await worker().runOnce()).outcomes).toEqual({ wait: 1 });
    await b.settle();
    const { sub } = await subscribe(tenantId);
    await b.deliver(subEvent("customer.subscription.updated", sub));
    expect((await worker(false).runOnce()).outcomes).toEqual({ wait: 1 });
    await b.settle();
    fake.subscriptions.delete(sub.id);
    await b.deliver(subEvent("customer.subscription.updated", sub));
    expect((await worker().runOnce()).outcomes).toEqual({ not_ours: 1 });
  });

  it("a failed payment starts the grace, a paid invoice ends it, and the tenant turns read-only after grace", async () => {
    const tenantId = await b.tenant();
    const { sub } = await subscribe(tenantId);
    const invoiceId = stripeId("in");
    const failedAt = b.h.clock.now();
    fake.subscriptions.set(sub.id, { ...sub, status: "past_due" });
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, invoiceId));
    await worker().runOnce();
    const row = await plan(tenantId);
    expect(row).toMatchObject({ status: "past_due" });
    expect(row!.read_only_after.getTime()).toBe(Math.floor(failedAt.getTime() / 1000) * 1000 + 7 * DAY);
    const session = await planSession(tenantId);
    expect((await session.getBillingPlan()).readOnly).toBe(false);
    b.h.clock.advance(8 * DAY);
    expect(await session.getBillingPlan()).toMatchObject({ readOnly: true, status: "past_due" });
    await expect(session.upsertContact({ displayName: "Ada Halden", email: "ada@haldenrowe.example" }, `c-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "plan_read_only" } });
    // Adding money and fixing billing still work.
    await expect(session.createTopUp({ amount: 1_000 }, `t-${randomUUID()}`)).resolves.toBeDefined();
    // The invoice is paid: read-only lifts, and a late repeat of the failure changes nothing.
    fake.subscriptions.set(sub.id, { ...sub, status: "active" });
    await b.deliver(invoiceEvent("invoice.paid", sub, invoiceId));
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, invoiceId));
    await worker().runOnce();
    expect(await plan(tenantId)).toMatchObject({ status: "active", read_only_after: null, payment_failed_at: null });
    await expect(session.upsertContact({ displayName: "Ada Halden", email: "ada@haldenrowe.example" }, `c-${randomUUID()}`)).resolves.toBeDefined();
  });

  it("an ended plan is read-only, and an incomplete replacement does not lift it until it pays", async () => {
    const tenantId = await b.tenant();
    const { sub, customer } = await subscribe(tenantId);
    const endedAt = b.h.clock.now();
    fake.subscriptions.set(sub.id, { ...sub, status: "canceled", ended_at: Math.floor(endedAt.getTime() / 1000) });
    await b.deliver(subEvent("customer.subscription.deleted", fake.subscriptions.get(sub.id)!));
    await worker().runOnce();
    expect((await plan(tenantId))!.read_only_after.getTime()).toBe(Math.floor(endedAt.getTime() / 1000) * 1000);
    b.h.clock.advance(1_000);
    const session = await planSession(tenantId);
    expect((await session.getBillingPlan()).readOnly).toBe(true);
    // A new checkout is allowed while read-only; its incomplete subscription keeps read-only.
    const next = await session.startPlanCheckout({ plan: "pro", interval: "month" }, `plan-${randomUUID()}`);
    const replacement = subscription({ id: stripeId("sub"), customer, tenantId, checkoutId: next.checkout.id, status: "incomplete",
      at: b.h.clock.now(), plan: "pro" });
    fake.subscriptions.set(replacement.id, replacement);
    await b.deliver(subEvent("customer.subscription.created", replacement));
    await worker().runOnce();
    expect((await session.getBillingPlan()).readOnly).toBe(true);
    fake.subscriptions.set(replacement.id, { ...replacement, status: "active" });
    await b.deliver(subEvent("customer.subscription.updated", replacement));
    await worker().runOnce();
    expect(await session.getBillingPlan()).toMatchObject({ readOnly: false, plan: "pro", status: "active" });
  });

  it("keeps the last plan when a lookup key is unknown, and reports a second paying subscription", async () => {
    const tenantId = await b.tenant();
    const { sub, customer } = await subscribe(tenantId, { plan: "solo" });
    fake.subscriptions.set(sub.id, { ...sub, items: { ...sub.items, data: sub.items.data.map((item) => ({ ...item, price: { id: "price_moved", lookup_key: "renamed" } })) } });
    await b.deliver(subEvent("customer.subscription.updated", sub));
    await worker().runOnce();
    expect(await plan(tenantId)).toMatchObject({ plan: "solo", status: "active" });
    b.h.clock.advance(1_000);
    const second = subscription({ id: stripeId("sub"), customer, tenantId, status: "active", at: b.h.clock.now(), plan: "pro" });
    fake.subscriptions.set(second.id, second);
    await b.deliver(subEvent("customer.subscription.created", second));
    expect((await worker().runOnce()).outcomes).toEqual({ plan_duplicate: 1 });
    expect(await plan(tenantId)).toMatchObject({ plan: "pro", stripe_subscription_id: second.id });
  });
});

describe("plan limits (PL-8)", () => {
  it("refuses a seat over the plan and leaves a comped tenant alone", async () => {
    const tenantId = await b.tenant();
    await subscribe(tenantId, { plan: "solo" });
    const session = await planSession(tenantId);
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "plan_limit", resource: "seats", limit: 2, used: 2 } });
    const comped = await b.tenant();
    const owner = await planSession(comped);
    for (let i = 0; i < 3; i += 1)
      await expect(owner.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
  });

  it("allows only the listed actions while read-only", async () => {
    const tenantId = await b.tenant();
    await b.h.service((tx) => tx.query(
      `INSERT INTO tenant_plans (tenant_id, plan, plan_interval, status, read_only_after, created_at, updated_at)
       VALUES ($1,'studio','month','canceled',$2,$2,$2)`, [tenantId, b.h.clock.now()]));
    await b.h.database.db.tenant(tenantId, async (tx) => {
      await expect(planGate(tx, tenantId, "wallet.topup.create", b.h.clock.now())).resolves.toBeUndefined();
      await expect(planGate(tx, tenantId, PLAN_CHECKOUT_CREATE_ACTION, b.h.clock.now())).resolves.toBeUndefined();
      await expect(planGate(tx, tenantId, "voice.textback.optin", b.h.clock.now())).rejects.toMatchObject({ details: { reason: "plan_read_only" } });
      await expect(planGate(tx, tenantId, "booking.create", b.h.clock.now())).rejects.toMatchObject({ details: { reason: "plan_read_only" } });
    });
  });
});

describe("founding (PL-11)", () => {
  it("an invited tenant gets the founding price; the invite ends with its subscription; the cap holds", async () => {
    const tenantId = await b.tenant();
    await b.h.service((tx) => setFoundingInvite(tx, { tenantId, invited: true, now: b.h.clock.now() }));
    const view = await (await planSession(tenantId)).getBillingPlan();
    expect(view.foundingInvite).toBe(true);
    expect(view.catalog.find((offer) => offer.plan === "studio")!.foundingPrices).toEqual({ month: 6_900, year: 69_000 });
    const { started, sub } = await subscribe(tenantId, { plan: "studio" });
    expect(started.checkout.founding).toBe(true);
    expect(lastForm().form["line_items[0][price]"]).toBe("price_hub_studio_founding_month");
    expect(await plan(tenantId)).toMatchObject({ founding: true, founding_invite: true });
    fake.subscriptions.set(sub.id, { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) });
    await b.deliver(subEvent("customer.subscription.deleted", fake.subscriptions.get(sub.id)!));
    await worker().runOnce();
    const ended = await plan(tenantId);
    expect(ended).toMatchObject({ founding_invite: false });
    expect(ended!.founding_started_at).not.toBeNull();
    // Solo has no founding price: an invited tenant pays list price for it.
    const solo = await b.tenant();
    await b.h.service((tx) => setFoundingInvite(tx, { tenantId: solo, invited: true, now: b.h.clock.now() }));
    expect((await (await planSession(solo)).startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`)).checkout.founding).toBe(false);
  });

  it("refuses a 26th founding tenant", async () => {
    const taken = (await b.h.rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM tenant_plans WHERE founding_invite OR founding_started_at IS NOT NULL"))[0]!.n;
    const tenants: string[] = [];
    for (let i = taken; i < 25; i += 1) tenants.push(await b.h.tenant());
    for (const tenantId of tenants) await b.h.service((tx) => setFoundingInvite(tx, { tenantId, invited: true, now: b.h.clock.now() }));
    const late = await b.h.tenant();
    await expect(b.h.service((tx) => setFoundingInvite(tx, { tenantId: late, invited: true, now: b.h.clock.now() })))
      .rejects.toMatchObject({ details: { reason: "founding_full" } });
    for (const tenantId of tenants) await b.h.service((tx) => setFoundingInvite(tx, { tenantId, invited: false, now: b.h.clock.now() }));
  });
});

describe("billing provider (PL-14)", () => {
  it("a tenant another provider bills gets no Stripe Checkout or Portal, and Stripe events leave it alone", async () => {
    const tenantId = await b.tenant();
    await b.h.service((tx) => tx.query(
      "INSERT INTO tenant_plans (tenant_id, billing_provider, created_at, updated_at) VALUES ($1,'shopify',$2,$2)", [tenantId, b.h.clock.now()]));
    const session = await planSession(tenantId);
    expect(await session.getBillingPlan()).toMatchObject({ billingProvider: "shopify", checkoutEnabled: false, portalEnabled: false });
    await expect(session.startPlanCheckout({ plan: "studio", interval: "month" }, `plan-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "billing_provider" } });
    await expect(session.openBillingPortal()).rejects.toMatchObject({ code: "Conflict", details: { reason: "billing_provider" } });
    const sub = subscription({ id: stripeId("sub"), customer: stripeId("cus"), tenantId, status: "active", at: b.h.clock.now() });
    fake.subscriptions.set(sub.id, sub);
    await b.h.service((tx) => tx.query(
      `INSERT INTO plan_checkouts (tenant_id, id, plan, plan_interval, plan_price_id, success_url, cancel_url, created_by, created_at, updated_at)
       VALUES ($1,$2,'studio','month','price_x','https://a.test/','https://a.test/',$2,$3,$3)`, [tenantId, randomUUID(), b.h.clock.now()]));
    await b.deliver(subEvent("customer.subscription.updated", { ...sub, metadata: { zs_tenant: tenantId } }));
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET stripe_customer_id=$2 WHERE tenant_id=$1", [tenantId, sub.customer]));
    expect((await worker().runOnce()).outcomes).toEqual({ wait: 1 });
    expect(await plan(tenantId)).toMatchObject({ billing_provider: "shopify", status: "none" });
  });
});

describe("the Billing Portal (PL-6)", () => {
  it("opens for the stored customer and refuses before there is one", async () => {
    const tenantId = await b.tenant();
    const session = await planSession(tenantId);
    await expect(session.openBillingPortal()).rejects.toMatchObject({ code: "Conflict", details: { reason: "no_customer" } });
    const { customer } = await subscribe(tenantId);
    await expect(session.openBillingPortal()).resolves.toEqual({ url: expect.stringMatching(/^https:\/\/billing\.stripe\.test\//) });
    const sent = fake.received.filter((r) => r.path === "/v1/billing_portal/sessions").at(-1)!;
    expect(sent.form).toEqual({ customer, return_url: PLAN_RETURN_URL });
  });
});

describe("tenancy of the plan tables (PL-12)", () => {
  it("tenant B sees none of tenant A's plan rows, and A cannot write the worker's columns", async () => {
    const { a, b: other } = b.h.fixture;
    await b.owner(a.tenantId);
    const { started, sub } = await subscribe(a.tenantId);
    const invoiceId = stripeId("in");
    await b.deliver(invoiceEvent("invoice.paid", sub, invoiceId));
    await worker().runOnce();
    const read = (tenantId: string, sql: string, params: unknown[] = []) =>
      b.h.database.db.tenant(tenantId, async (tx) => (await tx.query(sql, params)).rows);
    for (const table of ["tenant_plans", "plan_subscriptions", "plan_checkouts", "plan_invoices"]) {
      expect(await read(a.tenantId, `SELECT tenant_id FROM ${table}`), table).toHaveLength(1);
      expect(await read(other.tenantId, `SELECT tenant_id FROM ${table}`), table).toEqual([]);
      expect(await read(other.tenantId, `SELECT tenant_id FROM ${table} WHERE tenant_id=$1`, [a.tenantId]), table).toEqual([]);
    }
    expect(await (await planSession(other.tenantId)).getBillingPlan()).toMatchObject({ status: "none", plan: null });
    const asA = (sql: string, params: unknown[]) => b.h.database.db.tenant(a.tenantId, (tx) => tx.query(sql, params));
    for (const [sql, params] of [
      ["UPDATE tenant_plans SET read_only_after=NULL, status='active' WHERE tenant_id=$1", [a.tenantId]],
      ["UPDATE tenant_plans SET founding_invite=true WHERE tenant_id=$1", [a.tenantId]],
      ["INSERT INTO tenant_plans (tenant_id, created_at, updated_at) VALUES ($1, now(), now())", [other.tenantId]],
      ["UPDATE plan_subscriptions SET status='active' WHERE id=$1", [sub.id]],
      ["DELETE FROM plan_subscriptions WHERE id=$1", [sub.id]],
      ["UPDATE plan_invoices SET status='paid' WHERE id=$1", [invoiceId]],
      ["UPDATE plan_checkouts SET status='pending', founding=true WHERE id=$1", [started.checkout.id]],
      ["DELETE FROM plan_checkouts WHERE id=$1", [started.checkout.id]],
    ] as const) {
      await expect(asA(sql, [...params]), sql).rejects.toMatchObject({ code: "42501" });
    }
    // A runtime checkout insert naming another tenant is refused by the policy.
    await expect(asA(
      `INSERT INTO plan_checkouts (tenant_id, id, plan, plan_interval, plan_price_id, success_url, cancel_url, created_by, created_at, updated_at)
       VALUES ($1,$2,'solo','month','price_x','https://a.test/','https://a.test/',$2,now(),now())`,
      [other.tenantId, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    expect(await plan(a.tenantId)).toMatchObject({ status: "active" });
  });
});
