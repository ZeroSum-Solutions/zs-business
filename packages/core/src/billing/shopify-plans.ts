// Shopify-billed tenants (docs/requirements/plans.md PL-17, PL-18). Original code. The operator
// links a tenant to its shop; the billing runner reads each linked shop's contract from the
// Partner API and stores it as that shop's row in plan_subscriptions, then derives the record
// with the same PL-10 derivation as Stripe. An error is never read as "no contract".
import { Conflict, type HubPlan, type PlanInterval } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { derivePlanRecord } from "./plan-events.js";
import { lockTenantPlan } from "./plan-gate.js";
import { CHECKOUT_LIFETIME_MS } from "./topups.js";
import {
  SHOPIFY_INTERVALS, SHOPIFY_PLAN_KEY_PLANS, SHOPIFY_PLAN_KEYS, SHOPIFY_SHOP_DOMAIN, SHOPIFY_SHOP_GID, ShopifyPartnerError,
  type ShopifyContract, type ShopifyPlanKey, type ShopifySubscriptionReader,
} from "./plan-shopify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** PL-17: a plan checkout this young may still be paid. */
export const SHOPIFY_LINK_CHECKOUT_GATE_MS = DAY_MS;
/** PL-18: the pause between two Partner API calls of one pass. */
export const SHOPIFY_CALL_SPACING_MS = 500;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const ENDED_STRIPE = ["canceled", "unpaid", "incomplete_expired"];
const ENDED: ReadonlySet<string> = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);
const holds = (status: string | undefined) => status === "trialing" || status === "active";

/** PL-17: sets or clears a tenant's Shopify billing link (service role). */
export async function setShopifyBilling(tx: Transaction, input: {
  readonly tenantId: string;
  /** Null sets the provider back to Stripe and clears the shop. */
  readonly shop: { readonly id: string; readonly domain: string } | null;
  readonly now: Date;
  /** PL-8 grace, for a Stripe subscription that becomes effective again on unlink. */
  readonly graceDays: number;
}): Promise<{ billingProvider: "stripe" | "shopify"; shopId: string | null }> {
  await lockTenantPlan(tx, input.tenantId);
  const row = (await tx.query<{ billing_provider: string; shopify_shop_id: string | null }>(
    "SELECT billing_provider, shopify_shop_id FROM tenant_plans WHERE tenant_id=$1 FOR UPDATE", [input.tenantId])).rows[0];
  const currentShop = row?.shopify_shop_id ?? null;
  const shopStatus = currentShop === null ? undefined : (await tx.query<{ status: string }>(
    "SELECT status FROM plan_subscriptions WHERE tenant_id=$1 AND provider='shopify' AND id=$2", [input.tenantId, currentShop])).rows[0]?.status;

  if (input.shop === null) {
    if (holds(shopStatus)) throw new Conflict("The business still holds a Shopify plan", { reason: "shopify_plan_active" });
    if (row)
      await tx.query(
        `UPDATE tenant_plans SET billing_provider='stripe', shopify_shop_id=NULL, shopify_shop_domain=NULL, shopify_synced_at=NULL,
           shopify_sync_failures=0, shopify_next_sync_at=NULL, updated_at=$2 WHERE tenant_id=$1`, [input.tenantId, input.now]);
    if (row) await derivePlanRecord(tx, input.tenantId, input.now, input.graceDays * DAY_MS);
    return { billingProvider: "stripe", shopId: null };
  }

  const shop = input.shop;
  if (!SHOPIFY_SHOP_GID.test(shop.id)) throw new Conflict("Not a shop GID", { reason: "shop_invalid" });
  const domain = shop.domain.toLowerCase();
  if (!SHOPIFY_SHOP_DOMAIN.test(domain) || domain.length > 255) throw new Conflict("Not a myshopify.com domain", { reason: "shop_invalid" });
  if (currentShop !== null && currentShop !== shop.id && holds(shopStatus))
    throw new Conflict("The business still holds a plan on its current shop", { reason: "shopify_plan_active" });
  const stripeOpen = (await tx.query(
    `SELECT 1 FROM plan_subscriptions WHERE tenant_id=$1 AND provider='stripe' AND status <> ALL($2::text[]) LIMIT 1`,
    [input.tenantId, ENDED_STRIPE])).rowCount === 1;
  const checkoutOpen = (await tx.query(
    "SELECT 1 FROM plan_checkouts WHERE tenant_id=$1 AND status='pending' AND created_at > $2 LIMIT 1",
    [input.tenantId, new Date(input.now.getTime() - SHOPIFY_LINK_CHECKOUT_GATE_MS)])).rowCount === 1;
  // A top-up Checkout lives an hour (S-2); one still open could charge through Stripe after the link.
  const topUpOpen = (await tx.query(
    "SELECT 1 FROM wallet_topups WHERE tenant_id=$1 AND status='pending' AND created_at > $2 LIMIT 1",
    [input.tenantId, new Date(input.now.getTime() - CHECKOUT_LIFETIME_MS)])).rowCount === 1;
  if (stripeOpen || checkoutOpen || topUpOpen)
    throw new Conflict("The business has a Stripe plan or an open Stripe checkout", { reason: "stripe_plan_active" });
  // A shop's row ID is global (plan_subscriptions_id_once), so a shop that ever billed another
  // business cannot bill this one without an operator data change.
  const taken = (await tx.query(
    `SELECT 1 FROM tenant_plans WHERE shopify_shop_id=$1 AND tenant_id <> $2
     UNION ALL SELECT 1 FROM plan_subscriptions WHERE provider='shopify' AND id=$1 AND tenant_id <> $2 LIMIT 1`,
    [shop.id, input.tenantId])).rowCount === 1;
  if (taken) throw new Conflict("That shop bills another business", { reason: "shop_taken" });
  const relinked = currentShop !== shop.id;
  await tx.query(
    `INSERT INTO tenant_plans (tenant_id, billing_provider, shopify_shop_id, shopify_shop_domain, created_at, updated_at)
     VALUES ($1,'shopify',$2,$3,$4,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET billing_provider='shopify', shopify_shop_id=EXCLUDED.shopify_shop_id,
       shopify_shop_domain=EXCLUDED.shopify_shop_domain,
       shopify_synced_at=CASE WHEN $5 THEN NULL ELSE tenant_plans.shopify_synced_at END,
       shopify_sync_failures=CASE WHEN $5 THEN 0 ELSE tenant_plans.shopify_sync_failures END,
       shopify_next_sync_at=CASE WHEN $5 THEN NULL ELSE tenant_plans.shopify_next_sync_at END,
       updated_at=EXCLUDED.updated_at`,
    [input.tenantId, shop.id, domain, input.now, relinked]);
  await derivePlanRecord(tx, input.tenantId, input.now, input.graceDays * DAY_MS);
  return { billingProvider: "shopify", shopId: shop.id };
}

export type ShopifySyncOutcome = "plan_synced" | "plan_duplicate" | "mismatch" | "no_contract" | "skipped" | "error";

export interface ShopifySyncSummary {
  readonly checked: number;
  readonly outcomes: Record<string, number>;
  /** True when throttling or a Shopify failure ended the pass early. */
  readonly stopped: boolean;
}

interface ShopRow {
  status: string;
  plan: HubPlan | null;
  plan_interval: PlanInterval | null;
  founding: boolean;
  started_at: Date;
  status_since: Date;
}

export function createShopifyPlanSync(deps: {
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
  readonly reader: ShopifySubscriptionReader;
  readonly limit: number;
  /** PL-8 grace, passed to the shared derivation. */
  readonly graceDays: number;
  /** Waits between calls; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly report?: (event: { readonly tenantId: string; readonly outcome: ShopifySyncOutcome; readonly detail?: string }) => void;
}) {
  const now = () => new Date(deps.clock.now().getTime());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const handles = new Map<string, ShopifyPlanKey>(
    SHOPIFY_PLAN_KEYS.map((key) => [deps.reader.config.planHandles[key], key] as const));

  /** PL-18: the plan, interval and founding a contract names, or null when not both are known. */
  function named(contract: ShopifyContract): { plan: HubPlan; interval: PlanInterval; founding: boolean } | null {
    const interval = SHOPIFY_INTERVALS[contract.billingPeriod];
    const key = contract.handles.map((handle) => handles.get(handle)).find((found) => found !== undefined);
    if (!interval || !key) return null;
    return { ...SHOPIFY_PLAN_KEY_PLANS[key], interval };
  }

  /** Stores one answer for the tenant's shop; returns the outcome. Runs under the plan lock. */
  async function store(tx: Transaction, tenantId: string, shopId: string, contract: ShopifyContract | null, at: Date): Promise<ShopifySyncOutcome> {
    const previous = (await tx.query<ShopRow>(
      `SELECT status, plan, plan_interval, founding, started_at, status_since FROM plan_subscriptions
        WHERE tenant_id=$1 AND provider='shopify' AND id=$2 FOR UPDATE`, [tenantId, shopId])).rows[0];
    let outcome: ShopifySyncOutcome;
    if (contract === null) {
      outcome = "no_contract";
      if (previous && !ENDED.has(previous.status))
        await tx.query(
          `UPDATE plan_subscriptions SET status='canceled', ended_at=$3, status_since=$3, cancel_at_period_end=false, updated_at=$3
            WHERE tenant_id=$1 AND provider='shopify' AND id=$2`, [tenantId, shopId, at]);
    } else {
      const status = contract.trialEndsAt !== null && contract.trialEndsAt.getTime() > at.getTime() ? "trialing" : "active";
      const recognised = named(contract);
      const plan = recognised ?? (previous && previous.plan !== null && previous.plan_interval !== null
        ? { plan: previous.plan, interval: previous.plan_interval, founding: previous.founding } : null);
      // A contract seen after the row ended is a new one.
      const fresh = !previous || ENDED.has(previous.status);
      const startedAt = fresh ? at : previous.started_at;
      const statusSince = previous && previous.status === status ? previous.status_since : at;
      await tx.query(
        `INSERT INTO plan_subscriptions (tenant_id, provider, id, status, plan, plan_interval, founding, extra_connections,
           trial_end, current_period_end, cancel_at_period_end, started_at, ended_at, status_since, created_at, updated_at)
         VALUES ($1,'shopify',$2,$3,$4,$5,$6,0,$7,$8,$9,$10,NULL,$11,$12,$12)
         ON CONFLICT (tenant_id, id) DO UPDATE SET status=EXCLUDED.status, plan=EXCLUDED.plan, plan_interval=EXCLUDED.plan_interval,
           founding=EXCLUDED.founding, extra_connections=0, trial_end=EXCLUDED.trial_end, current_period_end=EXCLUDED.current_period_end,
           cancel_at_period_end=EXCLUDED.cancel_at_period_end, started_at=EXCLUDED.started_at, ended_at=NULL,
           status_since=EXCLUDED.status_since, updated_at=EXCLUDED.updated_at`,
        [tenantId, shopId, status, plan?.plan ?? null, plan?.interval ?? null, plan?.founding ?? false,
          contract.trialEndsAt, contract.cycleEnd, contract.cancelAtEndOfCycle, startedAt, statusSince, at]);
      outcome = plan === null ? "mismatch" : "plan_synced";
    }
    const duplicate = await derivePlanRecord(tx, tenantId, at, deps.graceDays * DAY_MS);
    await tx.query(
      `UPDATE tenant_plans SET shopify_synced_at=$2, shopify_sync_failures=0, shopify_next_sync_at=NULL, updated_at=$2 WHERE tenant_id=$1`,
      [tenantId, at]);
    return outcome === "plan_synced" && duplicate ? "plan_duplicate" : outcome;
  }

  async function failed(tenantId: string, shopId: string) {
    const at = now();
    await deps.service(async (tx) => {
      await lockTenantPlan(tx, tenantId);
      await tx.query(
        `UPDATE tenant_plans SET shopify_sync_failures=least(shopify_sync_failures + 1, 1000000),
           shopify_next_sync_at=$3::timestamptz + least($4::bigint * power(2, least(shopify_sync_failures, 20))::bigint, $5::bigint) * interval '1 millisecond',
           updated_at=$3
         WHERE tenant_id=$1 AND shopify_shop_id=$2`,
        [tenantId, shopId, at, BACKOFF_BASE_MS, BACKOFF_MAX_MS]);
    });
  }

  return {
    /** PL-18: one pass over due linked tenants, until the limit or the deadline. */
    async runOnce(options: { readonly deadline?: Date } = {}): Promise<ShopifySyncSummary> {
      const outcomes: Record<string, number> = {};
      const count = (outcome: string) => { outcomes[outcome] = (outcomes[outcome] ?? 0) + 1; };
      const due = await deps.service((tx) => tx.query<{ tenant_id: string; shopify_shop_id: string; shopify_synced_at: Date | null }>(
        `SELECT tenant_id, shopify_shop_id, shopify_synced_at FROM tenant_plans
          WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL AND (shopify_next_sync_at IS NULL OR shopify_next_sync_at <= $1)
          ORDER BY shopify_synced_at ASC NULLS FIRST, tenant_id LIMIT $2`, [now(), deps.limit]));
      let checked = 0;
      let stopped = false;
      for (const picked of due.rows) {
        if (options.deadline && now().getTime() >= options.deadline.getTime()) break;
        if (checked > 0) await sleep(SHOPIFY_CALL_SPACING_MS);
        checked += 1;
        try {
          const outcome = await deps.service(async (tx) => {
            await lockTenantPlan(tx, picked.tenant_id);
            const row = (await tx.query<{ billing_provider: string; shopify_shop_id: string | null; shopify_synced_at: Date | null }>(
              "SELECT billing_provider, shopify_shop_id, shopify_synced_at FROM tenant_plans WHERE tenant_id=$1", [picked.tenant_id])).rows[0];
            // Relinked, unlinked or synced by another run since it was picked.
            if (!row || row.billing_provider !== "shopify" || row.shopify_shop_id !== picked.shopify_shop_id
              || (row.shopify_synced_at?.getTime() ?? null) !== (picked.shopify_synced_at?.getTime() ?? null)) return "skipped" as const;
            const contract = await deps.reader.active(picked.shopify_shop_id);
            return store(tx, picked.tenant_id, picked.shopify_shop_id, contract, now());
          });
          count(outcome);
          if (outcome === "mismatch" || outcome === "plan_duplicate") deps.report?.({ tenantId: picked.tenant_id, outcome });
        } catch (error) {
          count("error");
          deps.report?.({ tenantId: picked.tenant_id, outcome: "error", detail: error instanceof Error ? error.message : "unknown" });
          await failed(picked.tenant_id, picked.shopify_shop_id);
          if (!(error instanceof ShopifyPartnerError) || error.stopPass) {
            stopped = true;
            break;
          }
        }
      }
      return { checked, outcomes, stopped };
    },
  };
}

