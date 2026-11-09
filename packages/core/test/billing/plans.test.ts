// Hub plans (docs/requirements/plans.md PL-4..PL-12) against the local Postgres with a manual
// clock and an in-process fake Stripe: checkout, events in any order, dunning and read-only, the
// limits, founding, the Portal and tenancy under the runtime role. All data is synthetic.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONNECTION_CONNECT_ACTION, PLAN_CATALOG, PLAN_CHECKOUT_CREATE_ACTION, type HubPlan, type PlanInterval } from "@zs/contracts";
import { cannotBeApproved } from "../../src/approvals/index.js";
import { derivedId, mapError, memberDispatch } from "../../src/edge/index.js";
import {
  connectIdempotencyKey, createAutomationAdmin, createBillingWorker, createSession, createStripeSubscriptionReader, PLAN_CHECKOUT_LIFETIME_MS,
  lockTenantPlan, planGate, READ_ONLY_ALLOWED_ACTIONS, setFoundingInvite,
  setShopifyBilling, SHOPIFY_LINK_CHECKOUT_GATE_MS, type Session,
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

  // PL-5: a first request Stripe could not answer stores no URL, so a retry asks again for 25 minutes.
  it("a retry up to the retry limit still asks Stripe; one later is checkout_closed and Stripe is not called", async () => {
    const sessionCalls = () => fake.received.filter((r) => r.path === "/v1/checkout/sessions").length;
    const tenantId = await b.tenant();
    fake.fail(503);
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-retry"))
      .rejects.toMatchObject({ name: "StripeRequestFailed" });
    b.h.clock.advance(25 * 60_000); // PL-5: 25 minutes, written out so a changed constant fails here
    const calls = sessionCalls();
    const retried = await (await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-retry");
    expect(sessionCalls()).toBe(calls + 1);
    expect((await checkoutRow(tenantId, retried.checkout.id)).checkout_url).toBe(retried.checkoutUrl);

    const late = await b.tenant();
    fake.fail(503);
    await expect((await planSession(late)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-late")).rejects.toBeDefined();
    b.h.clock.advance(25 * 60_000 + 1);
    const before = sessionCalls();
    await expect((await planSession(late)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-late"))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "checkout_closed" } });
    expect(sessionCalls()).toBe(before);
  });

  // PL-5: "The same 25-minute retry window and topup_closed-style answer apply" - a replay of a stored URL included.
  it("a replay with the stored URL works up to 25 minutes and is checkout_closed after, with Stripe not called", async () => {
    const sessionCalls = () => fake.received.filter((r) => r.path === "/v1/checkout/sessions").length;
    const tenantId = await b.tenant();
    const first = await (await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-replay");
    b.h.clock.advance(25 * 60_000);
    const calls = sessionCalls();
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-replay")).resolves.toEqual(first);
    b.h.clock.advance(1);
    await expect((await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, "plan-replay"))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "checkout_closed" } });
    expect(sessionCalls()).toBe(calls);
  });

  // PL-5: Stripe unreachable, 409, 429 or 5xx is 503; any other refusal is 500.
  it.each([[409, 503], [429, 503], [500, 503], [503, 503], [400, 500], [402, 500]])(
    "maps a Stripe %i on the Checkout Session to HTTP %i", async (stripeStatus, httpStatus) => {
      const tenantId = await b.tenant();
      fake.fail(stripeStatus);
      const error = await (await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`)
        .then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ name: "StripeRequestFailed" });
      expect(mapError(error).status).toBe(httpStatus);
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
    const invoiceId = stripeId("in");
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, invoiceId));
    expect((await worker().runOnce()).outcomes).toEqual({ not_ours: 1 });
    // A dropped event writes nothing: no invoice row is left behind.
    expect((await b.h.fixture.service((tx) => tx.query("SELECT 1 FROM plan_invoices WHERE tenant_id=$1 AND id=$2", [tenantId, invoiceId]))).rowCount).toBe(0);
  });

  it("a failed invoice on a subscription Stripe keeps active never starts the grace (PL-10)", async () => {
    const tenantId = await b.tenant();
    const { sub } = await subscribe(tenantId);
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, stripeId("in")));
    await worker().runOnce();
    expect(await plan(tenantId)).toMatchObject({ status: "active", read_only_after: null, payment_failed_at: null });
    expect(cannotBeApproved(PLAN_CHECKOUT_CREATE_ACTION)).toBe(true);
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
    const refused = await session.upsertContact({ displayName: "Ada Halden", email: "ada@haldenrowe.example" }, `c-${randomUUID()}`)
      .then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: "Conflict", details: { reason: "plan_read_only" } });
    // The reason leaves the API as is, so the dashboard can say what to do.
    expect(mapError(refused)).toMatchObject({ status: 409, body: { error: { details: { reason: "plan_read_only" } } } });
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

  it("a failure Stripe forgave never dates a later grace (PL-10)", async () => {
    const tenantId = await b.tenant();
    const { sub } = await subscribe(tenantId);
    fake.subscriptions.set(sub.id, { ...sub, status: "past_due" });
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, stripeId("in")));
    await worker().runOnce();
    expect(await plan(tenantId)).toMatchObject({ status: "past_due" });
    // Stripe voids the invoice: the subscription pays again with no invoice.paid.
    fake.subscriptions.set(sub.id, { ...sub, status: "active" });
    await b.deliver(subEvent("customer.subscription.updated", fake.subscriptions.get(sub.id)!));
    await worker().runOnce();
    expect(await plan(tenantId)).toMatchObject({ status: "active", read_only_after: null });
    b.h.clock.advance(30 * DAY);
    const laterFailure = b.h.clock.now();
    fake.subscriptions.set(sub.id, { ...sub, status: "past_due" });
    await b.deliver(invoiceEvent("invoice.payment_failed", sub, stripeId("in")));
    await worker().runOnce();
    const row = await plan(tenantId);
    expect(row!.read_only_after.getTime()).toBe(Math.floor(laterFailure.getTime() / 1000) * 1000 + 7 * DAY);
    expect((await (await planSession(tenantId)).getBillingPlan()).readOnly).toBe(false);
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

  describe("a first-seen subscription with an unknown price lookup key (PL-2)", () => {
    const ALERT = "SELECT * FROM cron_alerts WHERE job='billing-plan-price'";
    /** The hold: stored without a plan, the tenant on the lowest paid plan's limits, one open alert. */
    async function holdTenant() {
      await b.h.database.pool.query("DELETE FROM cron_alerts WHERE job='billing-plan-price'");
      // The alert is platform-wide: it closes only when no tenant is held, so earlier tests' holds end first.
      await b.h.database.pool.query("UPDATE plan_subscriptions SET status='canceled' WHERE provider='stripe' AND plan IS NULL");
      const tenantId = await b.tenant();
      const started = await (await planSession(tenantId)).startPlanCheckout({ plan: "studio", interval: "month" }, `plan-${randomUUID()}`);
      const sub = subscription({ id: stripeId("sub"), customer: stripeId("cus"), tenantId, checkoutId: started.checkout.id, status: "active",
        at: b.h.clock.now(), lookupKey: "hub_unknown_month" });
      fake.subscriptions.set(sub.id, sub);
      await b.deliver(subEvent("customer.subscription.created", sub));
      return { tenantId, sub };
    }

    it("holds the tenant on the lowest paid plan's limits, keeps the status and stores no plan on the subscription", async () => {
      const { tenantId, sub } = await holdTenant();
      expect((await worker().runOnce()).outcomes).toEqual({ plan_held: 1 });
      expect(await plan(tenantId)).toMatchObject({ plan: "solo", plan_interval: "month", status: "active", read_only_after: null });
      expect((await b.h.rows<Record<string, any>>("SELECT plan, status FROM plan_subscriptions WHERE tenant_id=$1 AND id=$2", [tenantId, sub.id]))[0])
        .toEqual({ plan: null, status: "active" });
      expect(await (await planSession(tenantId)).getBillingPlan()).toMatchObject({ status: "active", plan: "solo", limits: PLAN_CATALOG.solo.limits });
    });

    it("refuses a second checkout while the hold is on", async () => {
      const { tenantId } = await holdTenant();
      await worker().runOnce();
      await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "year" }, `plan-${randomUUID()}`))
        .rejects.toMatchObject({ code: "Conflict", details: { reason: "plan_price_hold" } });
    });

    it("opens one cron alert at the injected time, and a repeat raises its count", async () => {
      const { tenantId, sub } = await holdTenant();
      const first = b.h.clock.now();
      await worker().runOnce();
      expect(await b.h.rows<Record<string, any>>(ALERT)).toMatchObject([{ failure_count: 1, resolved_at: null, notified_at: null, opened_at: first }]);
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.last_error).toContain(sub.id);
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.last_error).toContain(tenantId);
      b.h.clock.advance(1_000);
      await b.deliver(subEvent("customer.subscription.updated", sub));
      await worker().runOnce();
      expect(await b.h.rows<Record<string, any>>(ALERT)).toMatchObject([{ failure_count: 2, resolved_at: null, opened_at: first }]);
    });

    it("lifts when a later answer names a known price, and closes the alert", async () => {
      const { tenantId, sub } = await holdTenant();
      await worker().runOnce();
      b.h.clock.advance(1_000);
      const fixed = subscription({ id: sub.id, customer: sub.customer, tenantId, status: "active", at: b.h.clock.now(), plan: "pro" });
      fake.subscriptions.set(sub.id, fixed);
      await b.deliver(subEvent("customer.subscription.updated", fixed));
      expect((await worker().runOnce()).outcomes).toEqual({ plan_synced: 1 });
      expect(await plan(tenantId)).toMatchObject({ plan: "pro", status: "active" });
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.resolved_at).toEqual(b.h.clock.now());
      // The hold is off: the refusal is now the ordinary one for a tenant that has a plan.
      await expect((await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "year" }, `plan-${randomUUID()}`))
        .rejects.toMatchObject({ details: { reason: "plan_exists" } });
    });

    it("lifts when the subscription ends: the tenant is read-only and may check out again", async () => {
      const { tenantId, sub } = await holdTenant();
      await worker().runOnce();
      b.h.clock.advance(1_000);
      const ended = { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) };
      fake.subscriptions.set(sub.id, ended);
      await b.deliver(subEvent("customer.subscription.deleted", ended));
      expect((await worker().runOnce()).outcomes).toEqual({ mismatch: 1 });
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.resolved_at).toEqual(b.h.clock.now());
      expect((await (await planSession(tenantId)).getBillingPlan()).readOnly).toBe(true);
      b.h.clock.advance(PLAN_CHECKOUT_LIFETIME_MS); // the checkout that started it is no longer open
      expect(await (await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month" }, `plan-${randomUUID()}`)).toHaveProperty("checkoutUrl");
    });

    it("two held tenants reconciling at once leave the alert closed", async () => {
      const a = await holdTenant();
      await worker().runOnce();
      // A second tenant held too; holdTenant would end the first, so build it by hand.
      const tenantId = await b.tenant();
      const started = await (await planSession(tenantId)).startPlanCheckout({ plan: "studio", interval: "month" }, `plan-${randomUUID()}`);
      const other = subscription({ id: stripeId("sub"), customer: stripeId("cus"), tenantId, checkoutId: started.checkout.id, status: "active",
        at: b.h.clock.now(), lookupKey: "hub_unknown_month" });
      fake.subscriptions.set(other.id, other);
      await b.deliver(subEvent("customer.subscription.created", other));
      await worker().runOnce();
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.resolved_at).toBeNull();
      b.h.clock.advance(1_000);
      for (const held of [{ ...a, plan: "pro" as const }, { sub: other, tenantId, plan: "solo" as const }]) {
        const fixed = subscription({ id: held.sub.id, customer: held.sub.customer, tenantId: held.tenantId, status: "active", at: b.h.clock.now(), plan: held.plan });
        fake.subscriptions.set(held.sub.id, fixed);
        await b.deliver(subEvent("customer.subscription.updated", fixed));
      }
      await Promise.all([worker().runOnce(), worker().runOnce()]);
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.resolved_at).not.toBeNull();
    });

    it("a reconcile waits for the alert lock, so a hold committed meanwhile keeps the alert open", async () => {
      const { tenantId, sub } = await holdTenant();
      await worker().runOnce();
      const other = await b.tenant();
      const otherSub = stripeId("sub");
      b.h.clock.advance(1_000);
      const fixed = subscription({ id: sub.id, customer: sub.customer, tenantId, status: "active", at: b.h.clock.now(), plan: "pro" });
      fake.subscriptions.set(sub.id, fixed);
      await b.deliver(subEvent("customer.subscription.updated", fixed));
      // Client one holds the alert lock, as a concurrent open does, and commits a new hold only after the reconcile is waiting.
      let locked!: () => void;
      let release!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const mayCommit = new Promise<void>((resolve) => { release = resolve; });
      const holder = b.h.service(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('billing-plan-price', 0))");
        locked();
        await mayCommit;
        const now = b.h.clock.now();
        await tx.query(
          `INSERT INTO plan_subscriptions (tenant_id, id, status, plan, plan_interval, started_at, status_since, created_at, updated_at)
           VALUES ($1,$2,'active',NULL,NULL,$3,$3,$3,$3)`, [other, otherSub, now]);
      });
      await lockTaken;
      const reconcile = worker().runOnce();
      // The reconcile is blocked on the advisory lock: it cannot finish while client one holds it.
      for (let i = 0; i < 100; i += 1) {
        const waiting = await b.h.database.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted");
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await b.h.database.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rowCount).toBe(1);
      release();
      await holder;
      expect((await reconcile).outcomes).toEqual({ plan_synced: 1 });
      expect(await plan(tenantId)).toMatchObject({ plan: "pro" });
      // A tenant is on hold, so the alert must still be open.
      expect((await b.h.rows<Record<string, any>>(ALERT))[0]!.resolved_at).toBeNull();
    });

    it("a known key never opens an alert or a hold", async () => {
      await b.h.database.pool.query("DELETE FROM cron_alerts WHERE job='billing-plan-price'");
      const tenantId = await b.tenant();
      await subscribe(tenantId, { plan: "studio" });
      expect(await plan(tenantId)).toMatchObject({ plan: "studio", status: "active" });
      expect(await b.h.rows(ALERT)).toEqual([]);
    });
  });

  it("checkout.session.expired marks a pending plan checkout expired, and a repeat changes nothing (PL-10)", async () => {
    const tenantId = await b.tenant();
    const started = await (await planSession(tenantId)).startPlanCheckout({ plan: "pro", interval: "month" }, `plan-${randomUUID()}`);
    expect((await checkoutRow(tenantId, started.checkout.id)).status).toBe("pending");
    const expired = () => b.event("checkout.session.expired", { id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: "expired",
      customer: null, subscription: null, metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id } });
    await b.deliver(expired());
    expect((await worker().runOnce()).outcomes).toEqual({ expired: 1 });
    expect((await checkoutRow(tenantId, started.checkout.id)).status).toBe("expired");
    // An expired checkout no longer blocks a new one, and a repeated event finds nothing pending.
    await b.deliver(expired());
    expect((await worker().runOnce()).outcomes).toEqual({ ignored: 1 });
    expect((await checkoutRow(tenantId, started.checkout.id)).status).toBe("expired");
  });
});

describe("plan limits (PL-8)", () => {
  it("refuses a seat over the plan and leaves a comped tenant alone", async () => {
    const tenantId = await b.tenant();
    await subscribe(tenantId, { plan: "solo" });
    const session = await planSession(tenantId);
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
    const over = await session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())
      .then(() => null, (error: unknown) => error);
    expect(over).toMatchObject({ code: "Conflict", details: { reason: "plan_limit", resource: "seats", limit: 2, used: 2 } });
    expect(mapError(over).body.error.details).toEqual({ reason: "plan_limit", resource: "seats", limit: 2, used: 2 });
    const comped = await b.tenant();
    const owner = await planSession(comped);
    for (let i = 0; i < 3; i += 1)
      await expect(owner.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
  });

  describe("connections and tokens", () => {
    const memberOf = async (tenantId: string) =>
      (await b.h.rows<{ id: string }>("SELECT id FROM tenant_members WHERE tenant_id=$1 AND role='owner' LIMIT 1", [tenantId]))[0]!.id;
    const SHOP = "testshop.myshopify.com";
    /** A connection row as the worker leaves it; the catalog toolkit is not needed for a counted row. */
    async function seedConnection(tenantId: string, toolkit: string, status = "active") {
      await b.h.service(async (tx) => tx.query(
        `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
         VALUES ($1,$2,'composio',$3,$4,'1',$5,$6,$7,$8,$9,$9,$9)`,
        [tenantId, randomUUID(), toolkit, `ca_${randomUUID().slice(0, 8)}`, SHOP, status === "disconnected" ? null : "Shop", status,
          await memberOf(tenantId), b.h.clock.now()]));
    }
    /** C-5: the connect action under its reserved key, after the worker verified an attempt. */
    async function connect(tenantId: string) {
      const connectionId = randomUUID();
      await b.h.service(async (tx) => tx.query(
        `INSERT INTO connection_attempts (tenant_id,id,connection_id,toolkit,composio_account_id,auth_config_id,account_domain,created_by,browser_hash,status,external_account_id,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,'shopify',$4,'ac_shopify',$5,$6,$7,'verified','1',$8,$9,$9)`,
        [tenantId, randomUUID(), connectionId, `ca_${randomUUID().slice(0, 8)}`, SHOP, await memberOf(tenantId), "x".repeat(43),
          new Date(b.h.clock.now().getTime() + 600_000), b.h.clock.now()]));
      const key = connectIdempotencyKey(connectionId);
      return memberDispatch(b.deps(), { tenantId, actorId: await b.owner(tenantId) })({
        actionType: CONNECTION_CONNECT_ACTION, target: { tenantId, type: "connection", id: connectionId },
        approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") }, idempotencyKey: key,
        payload: { connectionId, toolkit: "shopify", externalAccountId: "1", accountDomain: SHOP, accountLabel: "Shop" },
      });
    }
    async function seedToken(tenantId: string, input: { revoked?: boolean; expiresInMs?: number | null } = {}) {
      const actor = await b.owner(tenantId);
      const now = b.h.clock.now();
      await b.h.service(async (tx) => tx.query(
        `INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at,revoked_at,revoked_by)
         VALUES ($1,$2,'seed','{contacts:propose}',$3,$4,$5,$6,$7)`,
        [tenantId, randomUUID(), actor, new Date(now.getTime() - 2 * DAY),
          input.expiresInMs === undefined || input.expiresInMs === null ? null : new Date(now.getTime() + input.expiresInMs),
          input.revoked ? now : null, input.revoked ? actor : null]));
    }
    /** W-9: the owner's token create, through the integrations dispatcher. */
    const createToken = async (tenantId: string) =>
      createAutomationAdmin(b.deps(), { keySecrets: { current: ["test", "plans", "k".repeat(32)].join("-") } }, { tenantId, actorId: await b.owner(tenantId) })
        .createToken({ name: "flow", scopes: ["contacts:propose"] }, `token-${randomUUID()}`);
    const limitError = (reason: unknown) => ({ code: "Conflict", details: { reason } });

    it("counts live connections only: a disconnected one is free, and the add-on raises the limit by one", async () => {
      const solo = await b.tenant();
      await subscribe(solo, { plan: "solo" });
      await seedConnection(solo, "gmail", "disconnected");
      await seedConnection(solo, "slack");
      await expect(connect(solo)).rejects.toMatchObject({ ...limitError("plan_limit"), details: { resource: "managedConnections", limit: 1, used: 1 } });

      const withAddon = await b.tenant();
      await subscribe(withAddon, { plan: "solo", extraConnections: 1 });
      await seedConnection(withAddon, "gmail", "disconnected");
      await seedConnection(withAddon, "slack");
      await expect(connect(withAddon)).resolves.toBeDefined();
      await expect(connect(withAddon)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "managedConnections", limit: 2, used: 2 } });
    });

    it("two concurrent connects cannot both take the last slot", async () => {
      const tenantId = await b.tenant();
      await subscribe(tenantId, { plan: "solo" });
      const results = await Promise.allSettled([connect(tenantId), connect(tenantId)]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(lost.reason).toMatchObject(limitError("plan_limit"));
      expect((await b.h.rows("SELECT 1 FROM connections WHERE tenant_id=$1", [tenantId]))).toHaveLength(1);
    });

    // The catalog holds one toolkit (shopify), so two connects always share a toolkit and connections_one_live_per_toolkit
    // could also reject the second. This test therefore pins the plan lock itself: a connect waits while another transaction holds it.
    it("a connect waits for the tenant's plan lock before it counts (PL-8)", async () => {
      const tenantId = await b.tenant();
      await subscribe(tenantId, { plan: "solo" });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
      const holder = b.h.service(async (tx) => { await lockTenantPlan(tx, tenantId); locked(); await held; });
      await lockTaken;
      let settled = false;
      const pending = connect(tenantId).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, "the connect ran past the gate while the plan lock was held").toBe(false);
      release();
      await holder;
      await expect(pending).resolves.toBeDefined();
    });

    it("counts unrevoked, unexpired tokens only, and refuses at the limit", async () => {
      const tenantId = await b.tenant();
      await subscribe(tenantId, { plan: "studio" });
      await seedToken(tenantId, { revoked: true });
      await seedToken(tenantId, { expiresInMs: -DAY });
      await seedToken(tenantId, { expiresInMs: 30 * DAY });
      await expect(createToken(tenantId)).resolves.toBeDefined();
      await expect(createToken(tenantId)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "automationTokens", limit: 2, used: 2 } });
      // Solo has no tokens at all.
      const solo = await b.tenant();
      await subscribe(solo, { plan: "solo" });
      await expect(createToken(solo)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "automationTokens", limit: 0, used: 0 } });
    });

    it("two concurrent token creates cannot both take the last slot", async () => {
      const tenantId = await b.tenant();
      await subscribe(tenantId, { plan: "studio" });
      await seedToken(tenantId);
      const results = await Promise.allSettled([createToken(tenantId), createToken(tenantId)]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((results.find((r): r is PromiseRejectedResult => r.status === "rejected")!).reason).toMatchObject(limitError("plan_limit"));
      expect((await b.h.rows("SELECT 1 FROM automation_tokens WHERE tenant_id=$1 AND revoked_at IS NULL", [tenantId]))).toHaveLength(2);
    });
  });

  // PL-8 lists these. Spec drift: it names `voice.textback.optin` in its list and then says "not voice.textback.optin"; the code
  // leaves it out (it starts an outbound text), and so does this list. Any addition or removal must change this test.
  it("pins the full read-only allowlist to PL-8", () => {
    expect([...READ_ONLY_ALLOWED_ACTIONS].sort()).toEqual([
      "plan.checkout.create", "wallet.topup.create", "suppression.record",
      "sms.status.record", "sms.reply.record", "voice.call.record", "voice.voicemail.record",
      "transcription.job.complete", "transcription.job.fail", "catalog.intake.result", "catalog.intake.fail",
      "media.variant.stage", "media.variant.fail",
      "agent.kill", "agent.kind.kill", "browser.kill", "agent.run.finish", "agent.run.stall", "agent.kind.run.finish", "agent.cost.warn",
      "member.remove", "connection.disconnect", "calendar.google.disconnect", "automation.token.revoke",
      "approval.reject", "approval.revoke", "inbox.reply.discard",
      "outreach.campaign.pause", "outreach.prospect.stop", "outreach.mailbox.disconnect",
    ].sort());
    expect(PLAN_CHECKOUT_CREATE_ACTION).toBe("plan.checkout.create");
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
    // The invite ended with the subscription: no founding price is offered again.
    expect((await (await planSession(tenantId)).getBillingPlan()).catalog.find((offer) => offer.plan === "studio")!.foundingPrices).toBeNull();
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
    // Resolved by its customer, then ended under the plan lock: no retries, no Stripe read.
    expect((await worker().runOnce()).outcomes).toEqual({ not_ours: 1 });
    expect(await plan(tenantId)).toMatchObject({ billing_provider: "shopify", status: "none" });
  });

  it("ends every Stripe event for a tenant linked to Shopify not_ours, with no retry, write or Stripe call", async () => {
    const tenantId = await b.tenant();
    const { sub, started } = await subscribe(tenantId);
    const ended = { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) };
    fake.subscriptions.set(sub.id, ended);
    await b.deliver(subEvent("customer.subscription.deleted", ended));
    await worker().runOnce();
    await b.settle();
    expect(await plan(tenantId)).toMatchObject({ status: "canceled" });
    b.h.clock.advance(SHOPIFY_LINK_CHECKOUT_GATE_MS + 1);
    const shopNumber = 9_000_000 + Math.floor(Math.random() * 1_000_000);
    await b.h.service((tx) => setShopifyBilling(tx, {
      tenantId, shop: { id: `gid://shopify/Shop/${shopNumber}`, domain: `halden-${shopNumber}.myshopify.com` }, now: b.h.clock.now(), graceDays: 7,
    }));
    const before = await plan(tenantId);
    const reads = () => fake.received.filter((r) => r.path.startsWith("/v1/subscriptions/")).length;
    const readsBefore = reads();
    // Stored subscription ID and customer only: resolved, then dropped under the lock (no `wait` and retries).
    await b.deliver(subEvent("customer.subscription.updated", { ...ended, status: "active", metadata: {} }));
    await b.deliver(invoiceEvent("invoice.payment_failed", { ...ended, metadata: {} }, stripeId("in")));
    // Metadata naming the tenant's own checkout: resolved, then dropped under the lock before any write.
    await b.deliver(b.event("checkout.session.completed", {
      id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: "complete", customer: sub.customer, subscription: sub.id,
      metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id },
    }));
    await b.deliver(subEvent("customer.subscription.updated", { ...ended, status: "active" }));
    expect((await worker().runOnce()).outcomes).toEqual({ not_ours: 4 });
    expect(reads()).toBe(readsBefore);
    expect(await plan(tenantId)).toEqual(before);
  });
});

describe("pending checkouts after a provider switch (PL-17)", () => {
  // PL-17: the worker "only marks a pending plan checkout expired or completed, so the row never looks open".
  it("marks a pending plan checkout expired or completed although the tenant is billed by Shopify, and ends the event not_ours", async () => {
    const linkToShopify = async (tenantId: string) => {
      const shopNumber = 8_000_000 + Math.floor(Math.random() * 1_000_000);
      await b.h.service((tx) => setShopifyBilling(tx, {
        tenantId, shop: { id: `gid://shopify/Shop/${shopNumber}`, domain: `kest-${shopNumber}.myshopify.com` }, now: b.h.clock.now(), graceDays: 7,
      }));
    };
    const tenants = [await b.tenant(), await b.tenant()];
    const started: Array<Awaited<ReturnType<Session["startPlanCheckout"]>>> = [];
    for (const tenantId of tenants)
      started.push(await (await planSession(tenantId)).startPlanCheckout({ plan: "solo", interval: "month" }, `plan-${randomUUID()}`));
    b.h.clock.advance(SHOPIFY_LINK_CHECKOUT_GATE_MS + 1);
    for (const tenantId of tenants) await linkToShopify(tenantId);
    for (const [i, tenantId] of tenants.entries()) expect((await checkoutRow(tenantId, started[i]!.checkout.id)).status, "pending before").toBe("pending");
    const session = (type: string, i: number) => b.event(type, {
      id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: type.endsWith("expired") ? "expired" : "complete",
      customer: null, subscription: null, metadata: { zs_tenant: tenants[i], zs_checkout: started[i]!.checkout.id },
    });
    await b.deliver(session("checkout.session.expired", 0));
    await b.deliver(session("checkout.session.completed", 1));
    expect((await worker().runOnce()).outcomes).toEqual({ not_ours: 2 });
    expect((await checkoutRow(tenants[0]!, started[0]!.checkout.id)).status).toBe("expired");
    expect((await checkoutRow(tenants[1]!, started[1]!.checkout.id)).status).toBe("completed");
    // Nothing else was written for either tenant.
    for (const tenantId of tenants) expect(await plan(tenantId)).toMatchObject({ billing_provider: "shopify", status: "none", stripe_customer_id: null });
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
      // PL-17: only the service role links a tenant to a shop or writes its sync state.
      ["UPDATE tenant_plans SET billing_provider='shopify', shopify_shop_id='gid://shopify/Shop/1', shopify_shop_domain='a.myshopify.com' WHERE tenant_id=$1", [a.tenantId]],
      ["UPDATE tenant_plans SET shopify_synced_at=now(), shopify_sync_failures=0, shopify_next_sync_at=NULL WHERE tenant_id=$1", [a.tenantId]],
      [`INSERT INTO plan_subscriptions (tenant_id, provider, id, status, plan, plan_interval, started_at, status_since, created_at, updated_at)
        VALUES ($1,'shopify','gid://shopify/Shop/1','active','pro','month',now(),now(),now(),now())`, [a.tenantId]],
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

  // PL-3, PL-12: the runtime role never writes plan_invoices, and a paid invoice always has a paid_at.
  it("denies a runtime-role insert into plan_invoices and enforces the paid-state check", async () => {
    // A fresh tenant: the shared fixture tenant already holds a plan from the test above.
    const a = { tenantId: await b.tenant() };
    const { sub } = await subscribe(a.tenantId);
    const insert = `INSERT INTO plan_invoices (tenant_id, id, stripe_subscription_id, status, paid_at, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,now(),now())`;
    await expect(b.h.database.db.tenant(a.tenantId, (tx) => tx.query(insert, [a.tenantId, stripeId("in"), sub.id, "failed", null])))
      .rejects.toMatchObject({ code: "42501" });
    // (status = 'paid') = (paid_at IS NOT NULL), checked as the service role so only the constraint can refuse.
    const asService = (status: string, paidAt: Date | null) =>
      b.h.service((tx) => tx.query(insert, [a.tenantId, stripeId("in"), sub.id, status, paidAt]));
    await expect(asService("paid", null)).rejects.toMatchObject({ code: "23514", constraint: "plan_invoices_paid_state" });
    await expect(asService("failed", b.h.clock.now())).rejects.toMatchObject({ code: "23514", constraint: "plan_invoices_paid_state" });
    await expect(asService("resolved", b.h.clock.now())).rejects.toMatchObject({ code: "23514", constraint: "plan_invoices_paid_state" });
    await expect(asService("paid", b.h.clock.now())).resolves.toBeDefined();
    await expect(asService("failed", null)).resolves.toBeDefined();
  });
});
