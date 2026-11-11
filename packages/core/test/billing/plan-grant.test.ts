// Operator-granted plan (docs/requirements/plans.md PL-21..PL-24) against the local Postgres with a manual clock
// and the in-process fake Stripe: a grant wins over a provider subscription, ends on the injected clock, keeps
// the tenant out of read-only, is closed to the runtime role and is left alone by the billing sync. Synthetic data.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HubPlan, PlanInterval } from "@zs/contracts";
import {
  clearPlanGrant, createAutomationAdmin, createBillingWorker, createSession, createStripeSubscriptionReader, planGate, planLimits,
  readPlanGrant, setPlanGrant, type Session,
} from "../../src/index.js";
import { startFakeStripePlans, type FakeStripePlans } from "./fake-stripe-plans.js";
import { createBillingHarness, stripeId, type BillingHarness } from "./helpers.js";
import { PLAN_SECRET_KEY, plansClient, READ_KEY, subscription } from "./plan-helpers.js";

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

const planSession = async (tenantId: string): Promise<Session> =>
  createSession({
    db: b.h.database.db, clock: b.h.clock, generateId: randomUUID,
    billing: { stripe: b.stripe.client, plans: plansClient(fake.url, { trialDays: 14 }) },
  }, { tenantId, actorId: await b.owner(tenantId) });
const worker = () => createBillingWorker({
  service: b.h.service, clock: b.h.clock, generateId: randomUUID, config: { planGraceDays: 7, backoffBaseMs: 1 },
  subscriptions: createStripeSubscriptionReader({ config: { secretKey: READ_KEY, baseUrl: fake.url } }),
});
const planRow = async (tenantId: string) =>
  (await b.h.rows<Record<string, any>>("SELECT * FROM tenant_plans WHERE tenant_id=$1", [tenantId]))[0];

/** A Stripe subscription on `plan` in `status`, stored by the worker. */
async function subscribe(tenantId: string, input: { plan?: HubPlan; interval?: PlanInterval; status?: string } = {}) {
  const started = await (await planSession(tenantId)).startPlanCheckout(
    { plan: input.plan ?? "solo", interval: input.interval ?? "month", extraConnections: 0 }, `plan-${randomUUID()}`);
  const customer = stripeId("cus");
  const sub = subscription({ id: stripeId("sub"), customer, tenantId, checkoutId: started.checkout.id, status: input.status ?? "trialing",
    at: b.h.clock.now(), plan: input.plan ?? "solo", interval: input.interval ?? "month" });
  fake.subscriptions.set(sub.id, sub);
  await b.deliver(b.event("checkout.session.completed", {
    id: stripeId("cs"), object: "checkout.session", mode: "subscription", status: "complete", customer, subscription: sub.id,
    metadata: { zs_tenant: tenantId, zs_checkout: started.checkout.id },
  }));
  await worker().runOnce();
  return { sub, customer };
}
const grant = (tenantId: string, input: { plan?: HubPlan; until?: Date | null; note?: string; by?: string } = {}) =>
  b.h.service((tx) => setPlanGrant(tx, {
    tenantId, plan: input.plan ?? "pro", until: input.until === undefined ? null : input.until,
    note: input.note ?? "agency retainer", by: input.by ?? "Operator", now: b.h.clock.now(),
  }));
const stored = (tenantId: string) => b.h.service((tx) => readPlanGrant(tx, tenantId));
const clear = (tenantId: string) => b.h.service((tx) => clearPlanGrant(tx, { tenantId, now: b.h.clock.now() }));
const createToken = async (tenantId: string) =>
  createAutomationAdmin(b.deps(), { keySecrets: { current: ["test", "grant", "k".repeat(32)].join("-") } }, { tenantId, actorId: await b.owner(tenantId) })
    .createToken({ name: "flow", scopes: ["contacts:propose"] }, `token-${randomUUID()}`);
const gate = (tenantId: string, action: string) => b.h.database.db.tenant(tenantId, (tx) => planGate(tx, tenantId, action, b.h.clock.now()));
const tokenLimit = { code: "Conflict", details: { reason: "plan_limit", resource: "automationTokens", limit: 0 } };

describe("a grant wins over the provider subscription (PL-21)", () => {
  it("lets a tenant on a trialing solo subscription create a token under a pro grant, and refuses again after the grant is cleared", async () => {
    const tenantId = await b.tenant();
    await subscribe(tenantId, { plan: "solo", status: "trialing" });
    expect(await planRow(tenantId)).toMatchObject({ plan: "solo", status: "trialing" });
    await expect(createToken(tenantId)).rejects.toMatchObject(tokenLimit);
    const change = await grant(tenantId, { plan: "pro" });
    expect(change.before).toBeNull();
    expect(change.after).toMatchObject({ plan: "pro", until: null, note: "agency retainer", grantedBy: "Operator" });
    await expect(createToken(tenantId)).resolves.toBeDefined();
    // The token limit is pro's: ten, not solo's none.
    expect(await (await planSession(tenantId)).getBillingPlan()).toMatchObject({ limits: { automationTokens: 10, seats: 15 }, status: "trialing", plan: "solo" });
    expect((await clear(tenantId)).after).toBeNull();
    await expect(createToken(tenantId)).rejects.toMatchObject({ details: { reason: "plan_limit", resource: "automationTokens", limit: 0, used: 1 } });
  });

  it("ends on the injected clock: a grant until a date refuses again once the clock passes it, to the instant", async () => {
    const tenantId = await b.tenant();
    await subscribe(tenantId, { plan: "solo", status: "trialing" });
    const until = new Date(b.h.clock.now().getTime() + 2 * DAY);
    await grant(tenantId, { until });
    await expect(createToken(tenantId)).resolves.toBeDefined();
    b.h.clock.advance(2 * DAY - 1);
    await expect(createToken(tenantId)).resolves.toBeDefined();
    b.h.clock.advance(1); // the clock is now exactly `until`: the grant has ended
    await expect(createToken(tenantId)).rejects.toMatchObject(tokenLimit);
    const view = await (await planSession(tenantId)).getBillingPlan();
    expect(view.grant).toBeUndefined();
    expect(view.limits).toMatchObject({ automationTokens: 0 });
    // The stored grant is untouched by the read; clearing it later is still possible.
    expect((await stored(tenantId))?.plan).toBe("pro");
  });

  it("a grant gives a tenant with no subscription the plan's limits, and its end makes the tenant comped again", async () => {
    const tenantId = await b.tenant();
    expect(await planRow(tenantId)).toBeUndefined();
    await grant(tenantId, { plan: "solo", until: new Date(b.h.clock.now().getTime() + DAY) });
    const row = await planRow(tenantId);
    expect(row).toMatchObject({ status: "none", plan: null, granted_plan: "solo", billing_provider: "stripe" });
    const session = await planSession(tenantId);
    // Solo: two seats and no tokens, although the tenant has no subscription at all.
    await expect(createToken(tenantId)).rejects.toMatchObject(tokenLimit);
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID()))
      .rejects.toMatchObject({ details: { reason: "plan_limit", resource: "seats", limit: 2, used: 2 } });
    b.h.clock.advance(DAY);
    // Ended grant, no subscription: comped, as before the grant.
    await expect(session.inviteMember({ email: `${randomUUID()}@haldenrowe.example`, role: "staff" }, randomUUID())).resolves.toBeDefined();
    expect(await session.getBillingPlan()).toMatchObject({ status: "none", limits: null, readOnly: false });
  });

  it("the extra-connection add-on does not add to a grant's limits", () => {
    const now = new Date();
    const base = { plan: "studio" as const, extra_connections: 5, granted_plan: "pro" as const, granted_until: null };
    expect(planLimits(base, now)).toMatchObject({ managedConnections: 10, automationTokens: 10 });
    expect(planLimits({ ...base, granted_plan: null }, now)).toMatchObject({ managedConnections: 8, automationTokens: 2 });
    expect(planLimits({ ...base, granted_until: now }, now)).toMatchObject({ managedConnections: 8 });
  });
});

describe("a grant keeps the tenant out of read-only (PL-21)", () => {
  it("a past-due tenant past its grace is read-only, not while a grant is active, and again after the grant ends or is cleared", async () => {
    const tenantId = await b.tenant();
    const { sub } = await subscribe(tenantId, { plan: "studio", status: "active" });
    fake.subscriptions.set(sub.id, { ...sub, status: "past_due" });
    await b.deliver(b.event("invoice.payment_failed", {
      id: stripeId("in"), object: "invoice", customer: sub.customer, amount_due: 9_900, currency: "usd",
      parent: { type: "subscription_details", subscription_details: { subscription: sub.id, metadata: sub.metadata } },
      status_transitions: { paid_at: null },
    }));
    await worker().runOnce();
    b.h.clock.advance(8 * DAY);
    const session = await planSession(tenantId);
    expect(await session.getBillingPlan()).toMatchObject({ status: "past_due", readOnly: true });
    await expect(gate(tenantId, "booking.create")).rejects.toMatchObject({ details: { reason: "plan_read_only" } });

    await grant(tenantId, { plan: "solo", until: new Date(b.h.clock.now().getTime() + 10 * DAY) });
    expect(await session.getBillingPlan()).toMatchObject({
      status: "past_due", readOnly: false, limits: { seats: 2 },
      grant: { source: "grant", plan: "solo", grantedUntil: new Date(b.h.clock.now().getTime() + 10 * DAY).toISOString() },
    });
    // A write that read-only refuses now runs (the contact upsert is not on the read-only allowlist).
    await expect(session.upsertContact({ displayName: "Ada Halden", email: "ada@haldenrowe.example" }, `c-${randomUUID()}`)).resolves.toBeDefined();
    await expect(gate(tenantId, "booking.create")).resolves.toBeUndefined();

    b.h.clock.advance(10 * DAY);
    expect(await session.getBillingPlan()).toMatchObject({ readOnly: true });
    await expect(gate(tenantId, "booking.create")).rejects.toMatchObject({ details: { reason: "plan_read_only" } });
    await grant(tenantId, { plan: "pro" });
    await expect(gate(tenantId, "booking.create")).resolves.toBeUndefined();
    await clear(tenantId);
    await expect(gate(tenantId, "booking.create")).rejects.toMatchObject({ details: { reason: "plan_read_only" } });
  });

  it("an ended subscription (read_only_after set) with a grant is not read-only", async () => {
    const tenantId = await b.tenant();
    await b.h.service((tx) => tx.query(
      `INSERT INTO tenant_plans (tenant_id, plan, plan_interval, status, read_only_after, created_at, updated_at)
       VALUES ($1,'studio','month','canceled',$2,$2,$2)`, [tenantId, b.h.clock.now()]));
    await expect(gate(tenantId, "booking.create")).rejects.toMatchObject({ details: { reason: "plan_read_only" } });
    await grant(tenantId, { plan: "studio" });
    await expect(gate(tenantId, "booking.create")).resolves.toBeUndefined();
    expect(await (await planSession(tenantId)).getBillingPlan()).toMatchObject({ status: "canceled", readOnly: false, readOnlyAfter: expect.any(String) });
  });
});

describe("reading the grant (PL-22)", () => {
  it("reports the grant with source, plan and end, leaves the key out without one, and never sends the note or the operator", async () => {
    const tenantId = await b.tenant();
    const session = await planSession(tenantId);
    const without = await session.getBillingPlan();
    expect("grant" in without).toBe(false);
    await grant(tenantId, { plan: "studio", note: "secret retainer terms", by: "Dana Operator" });
    const forever = await session.getBillingPlan();
    expect(forever.grant).toEqual({ source: "grant", plan: "studio", grantedUntil: null });
    expect(JSON.stringify(forever)).not.toMatch(/secret retainer|Dana Operator/);
    await clear(tenantId);
    expect("grant" in await session.getBillingPlan()).toBe(false);
  });
});

describe("tenancy of the grant columns (PL-23)", () => {
  it("the runtime role cannot write them, and another tenant cannot read or change them", async () => {
    const { a, b: other } = b.h.fixture;
    await grant(a.tenantId, { plan: "pro", note: "tenant a only" });
    const asRuntime = (tenantId: string, sql: string, params: unknown[] = []) =>
      b.h.database.db.tenant(tenantId, (tx) => tx.query(sql, params));
    // Own tenant: readable, not writable (update, insert of a row, or a clear).
    expect((await asRuntime(a.tenantId, "SELECT granted_plan, grant_note FROM tenant_plans")).rows).toEqual([{ granted_plan: "pro", grant_note: "tenant a only" }]);
    for (const [sql, params] of [
      ["UPDATE tenant_plans SET granted_plan='pro', grant_note='x', granted_at=now(), granted_by='me'", []],
      ["UPDATE tenant_plans SET granted_until=NULL", []],
      ["UPDATE tenant_plans SET granted_plan=NULL, grant_note=NULL, granted_at=NULL, granted_by=NULL, granted_until=NULL", []],
      ["INSERT INTO tenant_plans (tenant_id, granted_plan, grant_note, granted_at, granted_by, created_at, updated_at) VALUES ($1,'pro','x',now(),'me',now(),now())", [other.tenantId]],
    ] as const) {
      await expect(asRuntime(a.tenantId, sql, [...params]), sql).rejects.toMatchObject({ code: "42501" });
      await expect(asRuntime(other.tenantId, sql, [...params]), sql).rejects.toMatchObject({ code: "42501" });
    }
    // The other tenant sees no row of A's, and its own plan read has no grant.
    expect((await asRuntime(other.tenantId, "SELECT granted_plan FROM tenant_plans")).rows).toEqual([]);
    expect((await asRuntime(other.tenantId, "SELECT granted_plan FROM tenant_plans WHERE tenant_id=$1", [a.tenantId])).rows).toEqual([]);
    expect("grant" in await (await planSession(other.tenantId)).getBillingPlan()).toBe(false);
    // The privilege itself: no write on any grant column for the runtime login or `authenticated`.
    const privilege = async (role: string, column: string, kind: string) => (await b.h.rows<{ ok: boolean }>(
      "SELECT has_column_privilege($1, 'public.tenant_plans', $2, $3) AS ok", [role, column, kind]))[0]!.ok;
    for (const column of ["granted_plan", "granted_until", "grant_note", "granted_at", "granted_by"])
      for (const role of ["authenticated", "zs_runtime"]) {
        expect(await privilege(role, column, "UPDATE"), `${role} UPDATE ${column}`).toBe(false);
        expect(await privilege(role, column, "INSERT"), `${role} INSERT ${column}`).toBe(false);
      }
    expect(await planRow(a.tenantId)).toMatchObject({ granted_plan: "pro", grant_note: "tenant a only" });
  });

  it("the service role cannot store half a grant, an end without a plan, an empty note or an unknown plan", async () => {
    const tenantId = await b.tenant();
    await b.h.service((tx) => tx.query("INSERT INTO tenant_plans (tenant_id, created_at, updated_at) VALUES ($1,now(),now())", [tenantId]));
    const update = (set: string) => b.h.service((tx) => tx.query(`UPDATE tenant_plans SET ${set} WHERE tenant_id=$1`, [tenantId]));
    const all = (plan: string, note: string) => `granted_plan='${plan}', grant_note='${note}', granted_at=now(), granted_by='me'`;
    await expect(update("granted_plan='pro'")).rejects.toMatchObject({ code: "23514", constraint: "tenant_plans_grant_all_or_none" });
    await expect(update("grant_note='x', granted_at=now(), granted_by='me'")).rejects.toMatchObject({ constraint: "tenant_plans_grant_all_or_none" });
    await expect(update("granted_until=now()")).rejects.toMatchObject({ constraint: "tenant_plans_grant_all_or_none" });
    await expect(update(all("pro", ""))).rejects.toMatchObject({ code: "23514", constraint: "tenant_plans_grant_note" });
    await expect(update(all("pro", " padded "))).rejects.toMatchObject({ constraint: "tenant_plans_grant_note" });
    await expect(update(all("enterprise", "x"))).rejects.toMatchObject({ code: "22P02" });
    await expect(update(all("pro", "ok"))).resolves.toBeDefined();
  });
});

describe("the operator functions (PL-24)", () => {
  it("replace an earlier grant, refuse a past end, a bad note or operator and an unknown tenant, and clear is idempotent", async () => {
    const tenantId = await b.tenant();
    const first = await grant(tenantId, { plan: "solo", note: "first" });
    const second = await grant(tenantId, { plan: "pro", note: "  second  ", by: " Dana ", until: new Date(b.h.clock.now().getTime() + DAY) });
    expect(second.before).toMatchObject({ plan: "solo", note: "first" });
    expect(second.after).toMatchObject({ plan: "pro", note: "second", grantedBy: "Dana" });
    expect(second.after!.grantedAt.getTime()).toBe(first.after!.grantedAt.getTime());
    await expect(grant(tenantId, { until: b.h.clock.now() })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(tenantId, { until: new Date(b.h.clock.now().getTime() - 1) })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(tenantId, { note: "   " })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(tenantId, { note: "n".repeat(201) })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(tenantId, { by: "" })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(tenantId, { plan: "enterprise" as HubPlan })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(grant(randomUUID())).rejects.toMatchObject({ code: "NotFound" });
    expect((await stored(tenantId))?.plan).toBe("pro");
    expect((await clear(tenantId)).before?.plan).toBe("pro");
    expect(await clear(tenantId)).toEqual({ before: null, after: null });
    await expect(b.h.service((tx) => clearPlanGrant(tx, { tenantId: randomUUID(), now: b.h.clock.now() }))).rejects.toMatchObject({ code: "NotFound" });
  });
});

describe("the billing sync leaves a grant alone (PL-23)", () => {
  it("Stripe events for a granted tenant store the subscription and keep every grant column", async () => {
    const tenantId = await b.tenant();
    const { sub } = await subscribe(tenantId, { plan: "solo", status: "trialing" });
    await grant(tenantId, { plan: "pro", until: new Date(b.h.clock.now().getTime() + 30 * DAY), note: "keep me", by: "Dana" });
    const columns = (row: Record<string, any> | undefined) => ({
      plan: row?.granted_plan, until: row?.granted_until, note: row?.grant_note, at: row?.granted_at, by: row?.granted_by });
    const before = columns(await planRow(tenantId));
    expect(before.plan).toBe("pro");
    const providerRowsBefore = await b.h.rows("SELECT id, plan, status FROM plan_subscriptions WHERE tenant_id=$1", [tenantId]);
    // The subscription goes active, then is cancelled, and an invoice fails: every kind of write the worker makes.
    fake.subscriptions.set(sub.id, { ...sub, status: "active" });
    await b.deliver(b.event("customer.subscription.updated", { ...fake.subscriptions.get(sub.id)! }));
    await worker().runOnce();
    expect(await planRow(tenantId)).toMatchObject({ status: "active", plan: "solo" });
    expect(columns(await planRow(tenantId))).toEqual(before);
    fake.subscriptions.set(sub.id, { ...sub, status: "canceled", ended_at: Math.floor(b.h.clock.now().getTime() / 1000) });
    await b.deliver(b.event("customer.subscription.deleted", { ...fake.subscriptions.get(sub.id)! }));
    await worker().runOnce();
    const after = await planRow(tenantId);
    expect(after).toMatchObject({ status: "canceled" });
    expect(after!.read_only_after).not.toBeNull();
    expect(columns(after)).toEqual(before);
    // The provider rows kept syncing (the status moved) and the grant still wins.
    expect(await b.h.rows("SELECT id, plan, status FROM plan_subscriptions WHERE tenant_id=$1", [tenantId])).not.toEqual(providerRowsBefore);
    expect(await (await planSession(tenantId)).getBillingPlan()).toMatchObject({ status: "canceled", readOnly: false, grant: { plan: "pro" } });
    // setFoundingInvite names its own columns too.
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET founding_invite=true WHERE tenant_id=$1", [tenantId]));
    expect(columns(await planRow(tenantId))).toEqual(before);
  });

  it("no statement outside plan-grant.ts and the read path names a grant column", () => {
    const dir = new URL("../../src/billing/", import.meta.url);
    for (const file of ["plan-events.ts", "plan-shopify.ts", "shopify-plans.ts", "processor.ts", "plan-stripe.ts", "topups.ts", "stripe.ts"]) {
      expect(readFileSync(new URL(file, dir), "utf8"), file).not.toMatch(/granted_|grant_note/);
    }
  });
});
