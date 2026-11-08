// Shopify-billed tenants (docs/requirements/plans.md PL-17, PL-18). Original code. The operator
// links a tenant to its shop; the billing runner reads each linked shop's contract from the
// Partner API and stores it as that shop's row in plan_subscriptions, then derives the record
// with the same PL-10 derivation as Stripe. An error is never read as "no contract".
import { Conflict, type HubPlan, type PlanInterval } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { derivePlanRecord } from "./plan-events.js";
import { lockTenantPlan } from "./plan-gate.js";
import {
  SHOPIFY_INTERVALS, SHOPIFY_PLAN_KEY_PLANS, SHOPIFY_PLAN_KEYS, SHOPIFY_SHOP_DOMAIN, SHOPIFY_SHOP_GID, ShopifyPartnerError,
  type ShopifyContract, type ShopifyPlanKey, type ShopifySubscriptionReader,
} from "./plan-shopify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** PL-17: a plan checkout this young may still be paid. */
export const SHOPIFY_LINK_CHECKOUT_GATE_MS = DAY_MS;
/** PL-18: the pause between two Partner API calls of one pass. */
export const SHOPIFY_CALL_SPACING_MS = 500;
/** PL-18: time kept back from the deadline for the commit or rollback after a call. */
export const SHOPIFY_COMMIT_RESERVE_MS = 1_000;
/** PL-18: a call starts only with at least this much time before the deadline. */
export const SHOPIFY_MIN_CALL_BUDGET_MS = SHOPIFY_COMMIT_RESERVE_MS + 1_000;
const BACKOFF_BASE_MS = 60_000;
/** The service transaction's own waits (packages/db scoped.ts); bound() never raises them. */
const SERVICE_LOCK_TIMEOUT_MS = 5_000;
const SERVICE_STATEMENT_TIMEOUT_MS = 15_000;
/** lock_not_available and query_canceled: a wait that ran out. */
const WAITS: ReadonlySet<string> = new Set(["55P03", "57014"]);
const sqlState = (error: unknown): string => {
  for (let at: unknown = error, depth = 0; at && typeof at === "object" && depth < 4; at = (at as { cause?: unknown }).cause, depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return "";
};
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
  // Two businesses linking one shop at once: the shop lock (always taken after the plan lock)
  // makes the second wait and then see the first, so it gets shop_taken, not a unique violation.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shopify-shop:${shop.id}`]);
  if (currentShop !== null && currentShop !== shop.id && holds(shopStatus))
    throw new Conflict("The business still holds a plan on its current shop", { reason: "shopify_plan_active" });
  const stripeOpen = (await tx.query(
    `SELECT 1 FROM plan_subscriptions WHERE tenant_id=$1 AND provider='stripe' AND status <> ALL($2::text[]) LIMIT 1`,
    [input.tenantId, ENDED_STRIPE])).rowCount === 1;
  const checkoutOpen = (await tx.query(
    "SELECT 1 FROM plan_checkouts WHERE tenant_id=$1 AND status='pending' AND created_at > $2 LIMIT 1",
    [input.tenantId, new Date(input.now.getTime() - SHOPIFY_LINK_CHECKOUT_GATE_MS)])).rowCount === 1;
  // Any pending top-up blocks, whatever its age: a delayed payment method can settle a completed
  // Checkout days later. Only Stripe's expired or failed event (or an operator) closes one.
  const topUpOpen = (await tx.query(
    "SELECT 1 FROM wallet_topups WHERE tenant_id=$1 AND status='pending' LIMIT 1", [input.tenantId])).rowCount === 1;
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

interface Picked {
  tenant_id: string;
  shopify_shop_id: string;
  shopify_synced_at: Date | null;
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
      // A contract seen after the row ended is a new one; it never inherits the ended contract's plan.
      const fresh = !previous || ENDED.has(previous.status);
      const plan = recognised ?? (!fresh && previous.plan !== null && previous.plan_interval !== null
        ? { plan: previous.plan, interval: previous.plan_interval, founding: previous.founding } : null);
      // An unrecognised new contract never replaces the ended row: overwriting it would drop the
      // end that makes the tenant read-only and leave it comped, with no limits (PL-10, PL-18).
      if (plan === null && previous && fresh) {
        await tx.query(
          `UPDATE tenant_plans SET shopify_synced_at=$2, shopify_sync_failures=0, shopify_next_sync_at=NULL, updated_at=$2 WHERE tenant_id=$1`,
          [tenantId, at]);
        return "mismatch";
      }
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
      // A contract that names no known plan is a mismatch even when the row keeps its old plan.
      outcome = recognised === null ? "mismatch" : "plan_synced";
    }
    const duplicate = await derivePlanRecord(tx, tenantId, at, deps.graceDays * DAY_MS);
    await tx.query(
      `UPDATE tenant_plans SET shopify_synced_at=$2, shopify_sync_failures=0, shopify_next_sync_at=NULL, updated_at=$2 WHERE tenant_id=$1`,
      [tenantId, at]);
    return outcome === "plan_synced" && duplicate ? "plan_duplicate" : outcome;
  }

  /**
   * PL-18: one more failure and the next backoff, only while the row is still the one picked
   * (same shop, no sync stored since), so an older failure never undoes a newer sync.
   */
  async function recordFailure(tx: Transaction, picked: Picked, at: Date) {
    await tx.query(
      `UPDATE tenant_plans SET shopify_sync_failures=least(shopify_sync_failures + 1, 1000000),
         shopify_next_sync_at=$3::timestamptz + least($4::bigint * power(2, least(shopify_sync_failures, 20))::bigint, $5::bigint) * interval '1 millisecond',
         updated_at=$3
       WHERE tenant_id=$1 AND billing_provider='shopify' AND shopify_shop_id=$2 AND shopify_synced_at IS NOT DISTINCT FROM $6`,
      [picked.tenant_id, picked.shopify_shop_id, at, BACKOFF_BASE_MS, BACKOFF_MAX_MS, picked.shopify_synced_at]);
  }

  /**
   * Cuts this transaction's lock and statement waits to the time left, when there is a deadline.
   * It only ever shortens them: never past the service defaults (5 s lock, 15 s statement).
   */
  async function bound(tx: Transaction, left: number) {
    if (!Number.isFinite(left)) return;
    const ms = Math.max(1, Math.floor(left));
    await tx.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
      [`${Math.min(ms, SERVICE_LOCK_TIMEOUT_MS)}ms`, `${Math.min(ms, SERVICE_STATEMENT_TIMEOUT_MS)}ms`]);
  }

  return {
    /** PL-18: one pass over due linked tenants, until the limit or the deadline. */
    async runOnce(options: { readonly deadline?: Date } = {}): Promise<ShopifySyncSummary> {
      const outcomes: Record<string, number> = {};
      const count = (outcome: string) => { outcomes[outcome] = (outcomes[outcome] ?? 0) + 1; };
      const left = () => options.deadline ? options.deadline.getTime() - now().getTime() : Number.POSITIVE_INFINITY;
      // Too little time for even one call: the database is not touched either.
      if (left() < SHOPIFY_MIN_CALL_BUDGET_MS) return { checked: 0, outcomes, stopped: false };
      const due = await deps.service(async (tx) => {
        await bound(tx, left());
        return tx.query<Picked>(
          `SELECT tenant_id, shopify_shop_id, shopify_synced_at FROM tenant_plans
            WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL AND (shopify_next_sync_at IS NULL OR shopify_next_sync_at <= $1)
            ORDER BY shopify_synced_at ASC NULLS FIRST, tenant_id LIMIT $2`, [now(), deps.limit]);
      });
      let checked = 0;
      let stopped = false;
      /**
       * Records one failure in its own short transaction; a failure to record ends nothing more.
       * It takes no plan lock: the write is conditional on the row (recordFailure), so a plan
       * lock held elsewhere never keeps a stuck tenant first in line on every pass.
       */
      const fail = async (picked: Picked) => {
        try {
          await deps.service(async (tx) => {
            await bound(tx, Math.max(left(), 250));
            await recordFailure(tx, picked, now());
          });
        } catch {
          deps.report?.({ tenantId: picked.tenant_id, outcome: "error", detail: "failure not recorded" });
        }
      };
      for (const picked of due.rows) {
        if (left() < SHOPIFY_MIN_CALL_BUDGET_MS) break;
        // Another run may have synced this tenant, or stored a failure backoff, since it was
        // picked: then this call would be spent twice (PL-18). The read takes no lock.
        let stillDue: boolean;
        try {
          stillDue = await deps.service(async (tx) => {
            await bound(tx, left());
            const row = (await tx.query<{ ok: boolean }>(
              `SELECT (shopify_next_sync_at IS NULL OR shopify_next_sync_at <= $4) AS ok FROM tenant_plans
                WHERE tenant_id=$1 AND billing_provider='shopify' AND shopify_shop_id=$2 AND shopify_synced_at IS NOT DISTINCT FROM $3`,
              [picked.tenant_id, picked.shopify_shop_id, picked.shopify_synced_at, now()])).rows[0];
            return row?.ok === true;
          });
        } catch (error) {
          count("error");
          deps.report?.({ tenantId: picked.tenant_id, outcome: "error", detail: error instanceof Error ? error.name : "database failure" });
          stopped = true;
          break;
        }
        if (!stillDue) {
          count("skipped");
          continue;
        }
        // The pause follows only a call, never a skip (PL-18).
        if (checked > 0) await sleep(SHOPIFY_CALL_SPACING_MS);
        // Checked after the pause and the re-read, so no call starts without its budget.
        const budget = left() - SHOPIFY_COMMIT_RESERVE_MS;
        if (budget < SHOPIFY_MIN_CALL_BUDGET_MS - SHOPIFY_COMMIT_RESERVE_MS) break;
        checked += 1;
        // The Partner API call holds no transaction, connection or plan lock (PL-18).
        let contract: ShopifyContract | null;
        try {
          contract = await deps.reader.active(picked.shopify_shop_id, Number.isFinite(budget) ? { timeoutMs: budget } : {});
        } catch (error) {
          count("error");
          const partner = error instanceof ShopifyPartnerError;
          deps.report?.({ tenantId: picked.tenant_id, outcome: "error", detail: partner ? error.message : "reader failure" });
          await fail(picked);
          if (!partner || error.stopPass) {
            stopped = true;
            break;
          }
          continue;
        }
        try {
          const outcome = await deps.service(async (tx) => {
            await bound(tx, Math.max(left(), 250));
            await lockTenantPlan(tx, picked.tenant_id);
            const row = (await tx.query<{ billing_provider: string; shopify_shop_id: string | null; shopify_synced_at: Date | null }>(
              "SELECT billing_provider, shopify_shop_id, shopify_synced_at FROM tenant_plans WHERE tenant_id=$1 FOR UPDATE", [picked.tenant_id])).rows[0];
            // Relinked, unlinked or synced by another run since it was picked: this answer is stale.
            if (!row || row.billing_provider !== "shopify" || row.shopify_shop_id !== picked.shopify_shop_id
              || (row.shopify_synced_at?.getTime() ?? null) !== (picked.shopify_synced_at?.getTime() ?? null)) return "skipped" as const;
            return store(tx, picked.tenant_id, picked.shopify_shop_id, contract, now());
          });
          count(outcome);
          if (outcome === "mismatch" || outcome === "plan_duplicate") deps.report?.({ tenantId: picked.tenant_id, outcome });
        } catch (error) {
          count("error");
          deps.report?.({ tenantId: picked.tenant_id, outcome: "error", detail: error instanceof Error ? error.name : "unknown" });
          await fail(picked);
          // One tenant's lock or statement wait (its plan lock held elsewhere) skips that tenant
          // only, while time is left; any other database error ends the pass.
          if (WAITS.has(sqlState(error)) && left() >= SHOPIFY_MIN_CALL_BUDGET_MS) continue;
          stopped = true;
          break;
        }
      }
      return { checked, outcomes, stopped };
    },
  };
}

