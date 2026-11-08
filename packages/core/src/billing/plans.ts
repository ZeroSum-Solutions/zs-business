// Hub plans (docs/requirements/plans.md PL-1, PL-4..PL-8, PL-11). Original code. The checkout
// action stores a pending checkout with the terms the route passes as dispatch config; the
// Checkout Session is asked for after it commits, under a key derived from the checkout. The plan
// gate runs inside every dispatched action (PL-8).
import {
  ALL_PLAN_PRICE_KEYS,
  billingPlanSchema,
  Conflict,
  ENTITLED_PLAN_STATUSES,
  EXTRA_CONNECTION_PRICE,
  NotFound,
  PLAN_ADDON_LOOKUP_KEY,
  PLAN_CATALOG,
  PLAN_CHECKOUT_CREATE_ACTION,
  planCheckoutCommandSchema,
  planCheckoutSchema,
  planLookupKey,
  ValidationFailed,
  type ActionCommand,
  type ActionResult,
  type BillingPlan,
  type BillingProvider,
  type HubPlan,
  type PlanCatalogEntry,
  type PlanCheckout,
  type PlanInterval,
  type PlanLimits,
  type PlanStatus,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";
import { isReadOnly, lockTenantPlan, planLimits } from "./plan-gate.js";
import type { StripePlansClient } from "./plan-stripe.js";

/** PL-5: like top-ups, a session lives an hour and a first request may be retried for 25 minutes. */
export const PLAN_CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;
export const PLAN_CHECKOUT_RETRY_LIMIT_MS = 25 * 60 * 1000;
/** PL-11. */
export const FOUNDING_LIMIT = 25;

/** PL-4: the route's terms; they never travel in the stored payload. */
export interface PlanTerms {
  readonly prices: Readonly<Record<string, string>>;
  readonly returnUrl: string;
  readonly trialDays: number;
}
export type PlanDispatchConfig = { readonly plans?: PlanTerms };

interface CheckoutRow {
  id: string;
  plan: HubPlan;
  plan_interval: PlanInterval;
  extra_connections: number;
  founding: boolean;
  trial_days: number;
  status: PlanCheckout["status"];
  created_at: Date;
}
const CHECKOUT_COLUMNS = "id, plan, plan_interval, extra_connections, founding, trial_days, status, created_at";
const checkoutFromRow = (row: CheckoutRow): PlanCheckout => planCheckoutSchema.parse({
  id: row.id, plan: row.plan, interval: row.plan_interval, extraConnections: row.extra_connections, founding: row.founding,
  trialDays: row.trial_days, status: row.status, createdAt: row.created_at.toISOString(),
});

interface TenantPlanRow {
  billing_provider: BillingProvider;
  plan: HubPlan | null;
  plan_interval: PlanInterval | null;
  founding: boolean;
  status: PlanStatus;
  extra_connections: number;
  stripe_customer_id: string | null;
  trial_end: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  trial_used: boolean;
  founding_invite: boolean;
  payment_failed_at: Date | null;
  read_only_after: Date | null;
  shopify_shop_domain: string | null;
}
const PLAN_COLUMNS = `billing_provider, plan, plan_interval, founding, status, extra_connections, stripe_customer_id, trial_end, current_period_end,
  cancel_at_period_end, trial_used, founding_invite, payment_failed_at, read_only_after, shopify_shop_domain`;
const tenantPlan = async (tx: Transaction, tenantId: string): Promise<TenantPlanRow | null> =>
  (await tx.query<TenantPlanRow>(`SELECT ${PLAN_COLUMNS} FROM tenant_plans WHERE tenant_id=$1`, [tenantId])).rows[0] ?? null;

const entitled = (status: PlanStatus) => ENTITLED_PLAN_STATUSES.includes(status);

export const planCheckoutHandler: ActionHandler<PlanDispatchConfig> = {
  async resolveTarget(tx, target) {
    if (target.type !== "plan_checkout") throw new ValidationFailed("Plan checkouts require a plan_checkout target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    return { tenantId, type: "plan_checkout", id: target.id };
  },
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(planCheckoutCommandSchema, command);
    if (command.target.id !== payload.checkoutId) throw new ValidationFailed("Target must name the checkout");
    // Only the member session's checkout route passes the terms; nothing else may start one.
    const terms = config.plans;
    if (!terms) throw new NotFound();
    if (payload.extraConnections > 0 && payload.interval !== "month")
      throw new ValidationFailed("Extra connections are monthly; choose a monthly plan to add them");
    await lockTenantPlan(tx, binding.tenantId);
    const row = await tenantPlan(tx, binding.tenantId);
    if (row && row.billing_provider !== "stripe") throw notStripe();
    // PL-2: a subscription with an unknown price holds the tenant; no second checkout until it is reconciled.
    const held = await tx.query(
      `SELECT 1 FROM plan_subscriptions WHERE tenant_id=$1 AND provider='stripe' AND plan IS NULL
         AND status NOT IN ('canceled','unpaid','incomplete_expired','paused') LIMIT 1`, [binding.tenantId]);
    if (held.rowCount === 1)
      throw new Conflict("A subscription with an unknown price is being reconciled; no new checkout until it is", { reason: "plan_price_hold" });
    if (row && entitled(row.status)) throw new Conflict("The business already has a plan; change it in billing", { reason: "plan_exists" });
    const open = (await tx.query<{ id: string; checkout_url: string | null }>(
      `SELECT id, checkout_url FROM plan_checkouts WHERE tenant_id=$1 AND status='pending' AND created_at > $2
        ORDER BY created_at DESC LIMIT 1`,
      [binding.tenantId, new Date(now.getTime() - PLAN_CHECKOUT_LIFETIME_MS)])).rows[0];
    if (open) throw new Conflict("Another checkout is still open", { reason: "checkout_open", ...(open.checkout_url ? { checkoutUrl: open.checkout_url } : {}) });
    const founding = Boolean(row?.founding_invite) && PLAN_CATALOG[payload.plan].foundingPrices !== null;
    const planPrice = terms.prices[planLookupKey(payload.plan, payload.interval, founding)];
    const addonPrice = payload.extraConnections > 0 ? terms.prices[PLAN_ADDON_LOOKUP_KEY] : null;
    if (!planPrice || addonPrice === undefined) throw new NotFound();
    const trialDays = row?.trial_used ? 0 : terms.trialDays;
    const returnUrl = terms.returnUrl;
    const join = returnUrl.includes("?") ? "&" : "?";
    const inserted = (await tx.query<CheckoutRow>(
      `INSERT INTO plan_checkouts (tenant_id, id, plan, plan_interval, extra_connections, founding, plan_price_id, addon_price_id,
         trial_days, stripe_customer_id, success_url, cancel_url, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING ${CHECKOUT_COLUMNS}`,
      [binding.tenantId, payload.checkoutId, payload.plan, payload.interval, payload.extraConnections, founding, planPrice, addonPrice,
        trialDays, row?.stripe_customer_id ?? null, `${returnUrl}${join}checkout=success`, `${returnUrl}${join}checkout=cancelled`,
        binding.actorId, now])).rows[0]!;
    return { result: { ...checkoutFromRow(inserted) } };
  },
};

export const planHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [PLAN_CHECKOUT_CREATE_ACTION]: planCheckoutHandler as ActionHandler,
});

interface StoredCheckout {
  readonly checkout: PlanCheckout;
  readonly request: {
    readonly planPriceId: string; readonly addonPriceId: string | null; readonly customerId: string | null;
    readonly successUrl: string; readonly cancelUrl: string;
  };
  readonly checkoutUrl: string | null;
  /** PL-15: the tenant's billing provider now. */
  readonly billingProvider: string;
}

export async function getStoredCheckout(tx: Transaction, tenantId: string, checkoutId: string): Promise<StoredCheckout | null> {
  const row = (await tx.query<CheckoutRow & {
    plan_price_id: string; addon_price_id: string | null; stripe_customer_id: string | null;
    success_url: string; cancel_url: string; checkout_url: string | null; billing_provider: string | null;
  }>(`SELECT ${CHECKOUT_COLUMNS.split(",").map((column) => `c.${column.trim()}`).join(", ")}, c.plan_price_id, c.addon_price_id,
        c.stripe_customer_id, c.success_url, c.cancel_url, c.checkout_url, p.billing_provider
        FROM plan_checkouts c LEFT JOIN tenant_plans p ON p.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, checkoutId])).rows[0];
  if (!row) return null;
  return {
    checkout: checkoutFromRow(row),
    request: {
      planPriceId: row.plan_price_id, addonPriceId: row.addon_price_id, customerId: row.stripe_customer_id,
      successUrl: row.success_url, cancelUrl: row.cancel_url,
    },
    checkoutUrl: row.checkout_url,
    billingProvider: row.billing_provider ?? "stripe",
  };
}

export async function rememberPlanCheckoutUrl(tx: Transaction, tenantId: string, checkoutId: string, url: string): Promise<void> {
  await tx.query("UPDATE plan_checkouts SET checkout_url=$3 WHERE tenant_id=$1 AND id=$2 AND checkout_url IS NULL", [tenantId, checkoutId, url]);
}

/** PL-4, PL-5: runs the action, then asks Stripe for the session with the stored parameters. */
export async function startPlanCheckout(input: {
  readonly command: ActionCommand;
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
  readonly read: (checkoutId: string) => Promise<StoredCheckout | null>;
  readonly remember: (checkoutId: string, url: string) => Promise<void>;
  readonly stripe: StripePlansClient;
  readonly tenantId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
}): Promise<{ checkout: PlanCheckout; checkoutUrl: string }> {
  const parsed = parseOrFail(planCheckoutCommandSchema, input.command);
  await input.dispatch(parsed);
  const found = await input.read(parsed.payload.checkoutId);
  if (!found) throw new Conflict("The checkout is not available", { reason: "checkout_closed" });
  // PL-15: checked again before every Stripe answer, a replay included; the tenant may have been linked to Shopify since.
  if (found.billingProvider !== "stripe") throw notStripe();
  const { checkout } = found;
  const createdAt = Date.parse(checkout.createdAt);
  // PL-5: the 25-minute retry window applies to a replay of the stored URL too (as for top-ups, S-2).
  if (checkout.status !== "pending" || input.now.getTime() - createdAt > PLAN_CHECKOUT_RETRY_LIMIT_MS)
    throw new Conflict("This checkout can no longer be used; start a new one", { reason: "checkout_closed" });
  if (found.checkoutUrl !== null) return { checkout, checkoutUrl: found.checkoutUrl };
  const session = await input.stripe.createSubscriptionCheckout({
    tenantId: input.tenantId,
    checkoutId: checkout.id,
    planPriceId: found.request.planPriceId,
    addonPriceId: found.request.addonPriceId,
    extraConnections: checkout.extraConnections,
    customerId: found.request.customerId,
    trialDays: checkout.trialDays,
    successUrl: found.request.successUrl,
    cancelUrl: found.request.cancelUrl,
    expiresAt: Math.floor((createdAt + PLAN_CHECKOUT_LIFETIME_MS) / 1000),
  }, input.signal ? { signal: input.signal } : {});
  await input.remember(checkout.id, session.url);
  return { checkout, checkoutUrl: session.url };
}

/** PL-14: a tenant another provider bills never gets a Stripe Checkout or Portal. */
const notStripe = () => new Conflict("This business is billed through another provider", { reason: "billing_provider" });

/** PL-6: the stored customer, or 409 no_customer. */
export async function portalCustomer(tx: Transaction, tenantId: string): Promise<string> {
  const row = await tenantPlan(tx, tenantId);
  if (row && row.billing_provider !== "stripe") throw notStripe();
  if (!row?.stripe_customer_id) throw new Conflict("There is no billing account yet; choose a plan first", { reason: "no_customer" });
  return row.stripe_customer_id;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const offer = (entry: PlanCatalogEntry, founding: boolean) => ({
  plan: entry.plan, name: entry.name, prices: { ...entry.prices },
  foundingPrices: founding && entry.foundingPrices ? { ...entry.foundingPrices } : null,
  limits: { ...entry.limits },
});

/** PL-15, PL-19, connections.md C-29:Shopify's plan selection page for a store; null without a store or an app handle. `store` is the myshopify.com name or the full domain. */
export function shopifyPricingUrl(store: string | null | undefined, appHandle: string | null | undefined): string | null {
  // Both handles are checked here, not trusted from the caller: "." and ".." would pass encodeURIComponent.
  const storeHandle = store?.replace(/\.myshopify\.com$/, "");
  if (!storeHandle || !appHandle) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(storeHandle) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(appHandle)) return null;
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

/** PL-7. */
export async function getBillingPlan(tx: Transaction, tenantId: string, input: {
  readonly now: Date;
  readonly trialDays: number;
  readonly checkoutEnabled: boolean;
  /** PL-19: the app handle in Shopify's plan selection URL, when configured. */
  readonly shopifyAppHandle?: string | null;
}): Promise<BillingPlan> {
  const row = await tenantPlan(tx, tenantId);
  // PL-11: a new founding offer follows the invite alone; a past founding subscription is no offer.
  const invited = Boolean(row?.founding_invite);
  const stripe = (row?.billing_provider ?? "stripe") === "stripe";
  const shopify = row?.billing_provider === "shopify";
  // PL-15, PL-19: the store handle is the myshopify.com name.
  const shopifyManageUrl = shopify ? shopifyPricingUrl(row?.shopify_shop_domain, input.shopifyAppHandle) : null;
  return billingPlanSchema.parse({
    billingProvider: row?.billing_provider ?? "stripe",
    status: row?.status ?? "none",
    plan: row?.plan ?? null,
    interval: row?.plan_interval ?? null,
    founding: row?.founding ?? false,
    foundingInvite: row?.founding_invite ?? false,
    extraConnections: row?.extra_connections ?? 0,
    trialEnd: iso(row?.trial_end ?? null),
    currentPeriodEnd: iso(row?.current_period_end ?? null),
    cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
    // PL-19: Shopify owns a Shopify tenant's trial.
    trialAvailable: stripe && !(row?.trial_used ?? false) && input.trialDays > 0,
    trialDays: stripe && !(row?.trial_used ?? false) ? input.trialDays : 0,
    paymentFailedAt: iso(row?.payment_failed_at ?? null),
    readOnlyAfter: iso(row?.read_only_after ?? null),
    readOnly: isReadOnly(row, input.now),
    limits: planLimits(row),
    catalog: (Object.values(PLAN_CATALOG) as PlanCatalogEntry[]).map((entry) => offer(entry, invited)),
    extraConnectionPrice: EXTRA_CONNECTION_PRICE,
    currency: "usd",
    checkoutEnabled: input.checkoutEnabled && stripe,
    portalEnabled: input.checkoutEnabled && stripe && Boolean(row?.stripe_customer_id),
    shopifyManageUrl,
  });
}

/** PL-11: an operator invites a tenant to the founding rate (service role). */
export async function setFoundingInvite(tx: Transaction, input: { readonly tenantId: string; readonly invited: boolean; readonly now: Date }): Promise<{ invited: boolean; counted: number }> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('plan:founding-cap',0))");
  await lockTenantPlan(tx, input.tenantId);
  const counted = (await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM tenant_plans WHERE (founding_invite OR founding_started_at IS NOT NULL) AND tenant_id <> $1",
    [input.tenantId])).rows[0]!.n;
  const started = (await tx.query("SELECT 1 FROM tenant_plans WHERE tenant_id=$1 AND founding_started_at IS NOT NULL", [input.tenantId])).rowCount === 1;
  if (input.invited && counted >= FOUNDING_LIMIT) throw new Conflict("All founding places are taken", { reason: "founding_full" });
  await tx.query(
    `INSERT INTO tenant_plans (tenant_id, founding_invite, created_at, updated_at) VALUES ($1,$2,$3,$3)
     ON CONFLICT (tenant_id) DO UPDATE SET founding_invite=EXCLUDED.founding_invite, updated_at=EXCLUDED.updated_at`,
    [input.tenantId, input.invited, input.now]);
  return { invited: input.invited, counted: counted + (input.invited || started ? 1 : 0) };
}

/** Every price key the API config must map (PL-13); re-exported for the entry points. */
export const PLAN_PRICE_KEYS = ALL_PLAN_PRICE_KEYS;
