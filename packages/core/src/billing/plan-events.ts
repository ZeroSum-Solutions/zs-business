// Hub plan events in the billing worker (docs/requirements/plans.md PL-10). Original code. An
// event only names a subscription; the worker reads it again from Stripe, stores that answer and
// derives the tenant's plan record from its own rows, so order and repeats do not matter. The
// tenant always comes from our rows, never from the event alone.
import { ENTITLED_PLAN_STATUSES, PLAN_ADDON_LOOKUP_KEY, PLAN_LOOKUP_KEYS, type HubPlan, type PlanInterval, type PlanStatus } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { lockTenantPlan } from "./plan-gate.js";
import type { StripeSubscriptionReader } from "./plan-stripe.js";

export type PlanOutcome = "plan_synced" | "plan_duplicate" | "checkout_completed" | "expired" | "mismatch" | "ignored" | "not_ours" | "wait";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRIPE_ID = /^[A-Za-z0-9_]{1,250}$/;
const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"] as const;
type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
const ENDED: ReadonlySet<string> = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);
const entitled = (status: string) => (ENTITLED_PLAN_STATUSES as readonly string[]).includes(status);

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const id = (value: unknown, prefix: string): string | null => {
  const raw = typeof value === "string" ? value : typeof record(value)?.id === "string" ? record(value)!.id as string : null;
  return raw !== null && raw.startsWith(prefix) && STRIPE_ID.test(raw) ? raw : null;
};
const seconds = (value: unknown): Date | null =>
  Number.isSafeInteger(value) && (value as number) > 0 ? new Date((value as number) * 1000) : null;
const meta = (object: Json | null): Json => record(object?.metadata) ?? {};
const uuid = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);

interface SubscriptionRow {
  id: string;
  stripe_customer_id: string | null;
  status: SubscriptionStatus;
  plan: HubPlan | null;
  plan_interval: PlanInterval | null;
  founding: boolean;
  extra_connections: number;
  trial_end: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  started_at: Date;
  status_since: Date;
}
const SUBSCRIPTION_COLUMNS = `id, stripe_customer_id, status, plan, plan_interval, founding, extra_connections, trial_end,
  current_period_end, cancel_at_period_end, started_at, status_since`;

export interface PlanEventDeps {
  readonly subscriptions?: StripeSubscriptionReader;
  readonly graceDays: number;
}

/** PL-10: returns null for an event that is not a plan event, so the top-up rules apply. */
export function createPlanEvents(deps: PlanEventDeps) {
  const graceMs = deps.graceDays * 24 * 60 * 60 * 1000;

  /** Our checkout row named by the object's metadata, or null. */
  async function checkoutTenant(tx: Transaction, object: Json | null): Promise<string | null> {
    const tenantId = uuid(meta(object).zs_tenant);
    const checkoutId = uuid(meta(object).zs_checkout);
    if (!tenantId || !checkoutId) return null;
    const found = await tx.query("SELECT 1 FROM plan_checkouts WHERE tenant_id=$1 AND id=$2", [tenantId, checkoutId]);
    return found.rowCount === 1 ? tenantId : null;
  }
  async function storedTenant(tx: Transaction, subscriptionId: string | null, customerId: string | null): Promise<string | null> {
    if (subscriptionId) {
      const row = (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM plan_subscriptions WHERE provider='stripe' AND id=$1", [subscriptionId])).rows[0];
      if (row) return row.tenant_id;
    }
    if (customerId) {
      const row = (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_plans WHERE stripe_customer_id=$1 AND billing_provider='stripe'", [customerId])).rows[0];
      if (row) return row.tenant_id;
    }
    return null;
  }

  async function ensureRecord(tx: Transaction, tenantId: string, at: Date) {
    await tx.query(
      "INSERT INTO tenant_plans (tenant_id, created_at, updated_at) VALUES ($1,$2,$2) ON CONFLICT (tenant_id) DO NOTHING", [tenantId, at]);
  }

  /** Reads one subscription from Stripe and stores it; then derives the tenant's record. */
  async function sync(tx: Transaction, tenantId: string, subscriptionId: string, at: Date): Promise<PlanOutcome> {
    if (!deps.subscriptions) return "wait";
    const answer = await deps.subscriptions.retrieve(subscriptionId);
    if (!answer) return "not_ours";
    const customerId = id(answer.customer, "cus_");
    const claimed = uuid(meta(answer).zs_tenant);
    if (claimed !== null && claimed !== tenantId) return "not_ours";
    const stored = (await tx.query<{ stripe_customer_id: string | null; billing_provider: string }>(
      "SELECT stripe_customer_id, billing_provider FROM tenant_plans WHERE tenant_id=$1", [tenantId])).rows[0];
    // PL-14: Stripe events never change a tenant another provider bills.
    if (stored && stored.billing_provider !== "stripe") return "not_ours";
    if (stored?.stripe_customer_id && customerId && stored.stripe_customer_id !== customerId) return "not_ours";
    const status = SUBSCRIPTION_STATUSES.find((value) => value === answer.status);
    if (!status) return "ignored";

    const previous = (await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM plan_subscriptions WHERE tenant_id=$1 AND provider='stripe' AND id=$2 FOR UPDATE`, [tenantId, subscriptionId])).rows[0];
    const items = (Array.isArray(record(answer.items)?.data) ? record(answer.items)!.data as unknown[] : []).map(record).filter((item): item is Json => item !== null);
    let plan = previous ? { plan: previous.plan, interval: previous.plan_interval, founding: previous.founding } : { plan: null, interval: null, founding: false };
    let extra = previous?.extra_connections ?? 0;
    let addonSeen = false;
    let periodEnd = seconds(answer.current_period_end);
    for (const item of items) {
      const key = record(item.price)?.lookup_key;
      const quantity = Number.isSafeInteger(item.quantity) ? Math.min(Math.max(item.quantity as number, 0), 1000) : 1;
      if (key === PLAN_ADDON_LOOKUP_KEY) {
        extra = quantity;
        addonSeen = true;
        continue;
      }
      // Newer API versions keep the period on the item; an unknown price still has one.
      periodEnd ??= seconds(item.current_period_end);
      if (typeof key === "string" && PLAN_LOOKUP_KEYS[key]) {
        const named = PLAN_LOOKUP_KEYS[key]!;
        plan = { plan: named.plan, interval: named.interval, founding: named.founding };
      }
    }
    if (!addonSeen && items.length > 0) extra = 0;
    const startedAt = seconds(answer.start_date) ?? seconds(answer.created) ?? previous?.started_at ?? at;
    const endedAt = seconds(answer.ended_at);
    const statusSince = previous && previous.status === status
      ? previous.status_since
      : ENDED.has(status) ? (endedAt ?? seconds(answer.canceled_at) ?? at) : at;

    await ensureRecord(tx, tenantId, at);
    await tx.query(
      `INSERT INTO plan_subscriptions (tenant_id, provider, id, stripe_customer_id, status, plan, plan_interval, founding, extra_connections,
         trial_end, current_period_end, cancel_at_period_end, started_at, ended_at, status_since, created_at, updated_at)
       VALUES ($1,'stripe',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       ON CONFLICT (tenant_id, id) DO UPDATE SET stripe_customer_id=coalesce(EXCLUDED.stripe_customer_id, plan_subscriptions.stripe_customer_id),
         status=EXCLUDED.status, plan=EXCLUDED.plan, plan_interval=EXCLUDED.plan_interval, founding=EXCLUDED.founding,
         extra_connections=EXCLUDED.extra_connections, trial_end=EXCLUDED.trial_end, current_period_end=EXCLUDED.current_period_end,
         cancel_at_period_end=EXCLUDED.cancel_at_period_end, started_at=EXCLUDED.started_at, ended_at=EXCLUDED.ended_at,
         status_since=EXCLUDED.status_since, updated_at=EXCLUDED.updated_at`,
      [tenantId, subscriptionId, customerId, status, plan.plan, plan.interval, plan.founding, extra,
        seconds(answer.trial_end), periodEnd, answer.cancel_at_period_end === true, startedAt, endedAt, statusSince, at]);
    // PL-10: when a past-due subscription pays again, its failed invoices are settled (paid, voided
    // or forgiven), so a later failure starts a fresh grace. A failure seen while the subscription is
    // still active stays: Stripe may move it to past_due next.
    if ((status === "active" || status === "trialing") && (previous?.status === "past_due" || previous?.status === "unpaid"))
      await tx.query(
        "UPDATE plan_invoices SET status='resolved', updated_at=$3 WHERE tenant_id=$1 AND provider='stripe' AND stripe_subscription_id=$2 AND status='failed'",
        [tenantId, subscriptionId, at]);
    // PL-11: a founding subscription first seen ended gives up the invite; the slot stays used.
    if (plan.founding && ENDED.has(status) && !(previous && ENDED.has(previous.status)))
      await tx.query("UPDATE tenant_plans SET founding_invite=false, updated_at=$2 WHERE tenant_id=$1", [tenantId, at]);
    const duplicate = await derive(tx, tenantId, at);
    if (plan.plan === null) return "mismatch";
    return duplicate ? "plan_duplicate" : "plan_synced";
  }

  /** PL-10: the tenant's record from its rows alone. True when two subscriptions both pay. */
  async function derive(tx: Transaction, tenantId: string, at: Date): Promise<boolean> {
    const rows = (await tx.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM plan_subscriptions WHERE tenant_id=$1 ORDER BY started_at DESC, id DESC`, [tenantId])).rows;
    const recognised = rows.filter((row) => row.plan !== null);
    const paying = recognised.filter((row) => entitled(row.status));
    const effective = paying[0] ?? recognised[0] ?? null;
    // PL-8: a failed invoice counts only while Stripe says the subscription is past due, so one
    // that Stripe voided or forgave cannot make a paying tenant read-only.
    const failed = effective?.status === "past_due" ? (await tx.query<{ first: Date | null }>(
      `SELECT min(first_failed_at) AS first FROM plan_invoices WHERE tenant_id=$1 AND provider='stripe' AND stripe_subscription_id=$2 AND status='failed'`,
      [tenantId, effective.id])).rows[0]?.first ?? null : null;
    const ended = rows.filter((row) => ENDED.has(row.status)).sort((a, b) => b.status_since.getTime() - a.status_since.getTime())[0];
    const readOnlyAfter = effective && entitled(effective.status)
      ? (failed ? new Date(failed.getTime() + graceMs) : null)
      : (ended?.status_since ?? null);
    const foundingStart = rows.filter((row) => row.founding).map((row) => row.started_at.getTime()).sort((a, b) => a - b)[0];
    const status: PlanStatus = effective ? effective.status : "none";
    await tx.query(
      `UPDATE tenant_plans SET plan=$2, plan_interval=$3, founding=$4, status=$5, extra_connections=$6,
         stripe_customer_id=coalesce(stripe_customer_id, $7), stripe_subscription_id=$8, trial_end=$9, current_period_end=$10,
         cancel_at_period_end=$11, trial_used=trial_used OR $12, founding_started_at=coalesce(founding_started_at, $13),
         payment_failed_at=$14, read_only_after=$15, updated_at=$16
       WHERE tenant_id=$1`,
      [tenantId, effective?.plan ?? null, effective?.plan_interval ?? null, effective?.founding ?? false, status,
        effective?.extra_connections ?? 0, effective?.stripe_customer_id ?? null, effective?.id ?? null,
        effective?.trial_end ?? null, effective?.current_period_end ?? null, effective?.cancel_at_period_end ?? false,
        rows.length > 0, foundingStart === undefined ? null : new Date(foundingStart),
        effective && entitled(effective.status) ? failed : null, readOnlyAfter, at]);
    return paying.length > 1;
  }

  async function checkout(tx: Transaction, type: string, object: Json, at: Date): Promise<PlanOutcome> {
    const tenantId = await checkoutTenant(tx, object);
    if (!tenantId) return "not_ours";
    await lockTenantPlan(tx, tenantId);
    const checkoutId = uuid(meta(object).zs_checkout)!;
    const sessionId = id(object.id, "cs_");
    if (type === "checkout.session.expired") {
      const updated = await tx.query(
        `UPDATE plan_checkouts SET status='expired', stripe_checkout_session_id=coalesce(stripe_checkout_session_id,$3), updated_at=$4
          WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, checkoutId, sessionId, at]);
      return updated.rowCount === 1 ? "expired" : "ignored";
    }
    await tx.query(
      `UPDATE plan_checkouts SET status='completed', stripe_checkout_session_id=coalesce(stripe_checkout_session_id,$3), updated_at=$4
        WHERE tenant_id=$1 AND id=$2 AND status <> 'completed'`, [tenantId, checkoutId, sessionId, at]);
    await ensureRecord(tx, tenantId, at);
    const customerId = id(object.customer, "cus_");
    if (customerId)
      await tx.query("UPDATE tenant_plans SET stripe_customer_id=coalesce(stripe_customer_id,$2), updated_at=$3 WHERE tenant_id=$1",
        [tenantId, customerId, at]);
    const subscriptionId = id(object.subscription, "sub_");
    if (!subscriptionId) return "checkout_completed";
    return sync(tx, tenantId, subscriptionId, at);
  }

  async function subscription(tx: Transaction, object: Json, at: Date): Promise<PlanOutcome> {
    const subscriptionId = id(object.id, "sub_");
    if (!subscriptionId) return "ignored";
    const tenantId = (await checkoutTenant(tx, object)) ?? (await storedTenant(tx, subscriptionId, id(object.customer, "cus_")));
    if (!tenantId) return "wait";
    await lockTenantPlan(tx, tenantId);
    return sync(tx, tenantId, subscriptionId, at);
  }

  async function invoice(tx: Transaction, type: string, object: Json, created: Date | null, at: Date): Promise<PlanOutcome> {
    const invoiceId = id(object.id, "in_");
    const details = record(record(object.parent)?.subscription_details) ?? record(object.subscription_details);
    const subscriptionId = id(object.subscription, "sub_") ?? id(details?.subscription, "sub_");
    if (!invoiceId || !subscriptionId) return "ignored";
    const tenantId = (await checkoutTenant(tx, details)) ?? (await storedTenant(tx, subscriptionId, id(object.customer, "cus_")));
    if (!tenantId) return "wait";
    await lockTenantPlan(tx, tenantId);
    const amount = Number.isSafeInteger(object.amount_due) && (object.amount_due as number) >= 0 ? object.amount_due as number : 0;
    const currency = typeof object.currency === "string" && /^[a-z]{3}$/.test(object.currency) ? object.currency : "usd";
    const when = created ?? at;
    if (type === "invoice.paid") {
      const paidAt = seconds(record(object.status_transitions)?.paid_at) ?? when;
      await tx.query(
        `INSERT INTO plan_invoices (tenant_id, id, stripe_subscription_id, status, amount_due, currency, paid_at, created_at, updated_at)
         VALUES ($1,$2,$3,'paid',$4,$5,$6,$7,$7)
         ON CONFLICT (tenant_id, id) DO UPDATE SET status='paid', paid_at=coalesce(plan_invoices.paid_at, EXCLUDED.paid_at), updated_at=EXCLUDED.updated_at`,
        [tenantId, invoiceId, subscriptionId, amount, currency, paidAt, at]);
    } else {
      await tx.query(
        `INSERT INTO plan_invoices (tenant_id, id, stripe_subscription_id, status, amount_due, currency, first_failed_at, created_at, updated_at)
         VALUES ($1,$2,$3,'failed',$4,$5,$6,$7,$7)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           status=CASE WHEN plan_invoices.status='paid' THEN 'paid' ELSE 'failed' END,
           first_failed_at=CASE WHEN plan_invoices.status='resolved' OR plan_invoices.first_failed_at IS NULL THEN EXCLUDED.first_failed_at
             ELSE least(plan_invoices.first_failed_at, EXCLUDED.first_failed_at) END,
           updated_at=EXCLUDED.updated_at`,
        [tenantId, invoiceId, subscriptionId, amount, currency, when, at]);
    }
    return sync(tx, tenantId, subscriptionId, at);
  }

  /** A plan event's outcome, or null when the event is not about plans. */
  async function apply(tx: Transaction, type: string, object: Json, created: Date | null, at: Date): Promise<PlanOutcome | null> {
    switch (type) {
      case "checkout.session.completed":
      case "checkout.session.expired":
        return object.mode === "subscription" ? checkout(tx, type, object, at) : null;
      case "checkout.session.async_payment_succeeded":
      case "checkout.session.async_payment_failed":
        return object.mode === "subscription" ? "ignored" : null;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return subscription(tx, object, at);
      case "invoice.paid":
      case "invoice.payment_failed":
        return invoice(tx, type, object, created, at);
      default:
        return null;
    }
  }

  return { apply };
}
