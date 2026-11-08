import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";

// Hub plan subscriptions (docs/requirements/plans.md). Root re-exports this module, so shared
// root schemas are reached lazily, as in billing.ts.
const idSchema = z.lazy(() => uuidSchema);

export const PLAN_CHECKOUT_CREATE_ACTION = "plan.checkout.create";

export const hubPlanSchema = z.enum(["solo", "studio", "pro"]);
export type HubPlan = z.infer<typeof hubPlanSchema>;
export const planIntervalSchema = z.enum(["month", "year"]);
export type PlanInterval = z.infer<typeof planIntervalSchema>;

/** PL-1: what each plan unlocks. `null` booleans never occur; every limit is a whole number. */
export interface PlanLimits {
  readonly seats: number;
  readonly bookableResources: number;
  readonly managedConnections: number;
  readonly automationTokens: number;
  readonly modelAgents: boolean;
  readonly voice: boolean;
  readonly agentDailyCapCents: number;
  readonly emailsPerMonth: number;
}

export interface PlanCatalogEntry {
  readonly plan: HubPlan;
  readonly name: string;
  /** USD cents. */
  readonly prices: Readonly<Record<PlanInterval, number>>;
  readonly foundingPrices: Readonly<Record<PlanInterval, number>> | null;
  readonly limits: PlanLimits;
}

/** PL-1 (PRICING.md section 1B, 2026-11-07). */
export const PLAN_CATALOG: Readonly<Record<HubPlan, PlanCatalogEntry>> = Object.freeze({
  solo: {
    plan: "solo", name: "Solo", prices: { month: 4_900, year: 49_000 }, foundingPrices: null,
    limits: { seats: 2, bookableResources: 1, managedConnections: 1, automationTokens: 0, modelAgents: false, voice: false, agentDailyCapCents: 100, emailsPerMonth: 1_000 },
  },
  studio: {
    plan: "studio", name: "Studio", prices: { month: 9_900, year: 99_000 }, foundingPrices: { month: 6_900, year: 69_000 },
    limits: { seats: 6, bookableResources: 3, managedConnections: 3, automationTokens: 2, modelAgents: true, voice: false, agentDailyCapCents: 100, emailsPerMonth: 4_000 },
  },
  pro: {
    plan: "pro", name: "Pro", prices: { month: 19_900, year: 199_000 }, foundingPrices: { month: 13_900, year: 139_000 },
    limits: { seats: 15, bookableResources: 10, managedConnections: 10, automationTokens: 10, modelAgents: true, voice: true, agentDailyCapCents: 300, emailsPerMonth: 15_000 },
  },
});

/** PL-1: the extra managed connection add-on, USD cents a month per unit. */
export const EXTRA_CONNECTION_PRICE = 1_000;
export const MAX_EXTRA_CONNECTIONS = 20;

/** PL-2: Stripe lookup keys (PRICING.md section 5). */
export const PLAN_ADDON_LOOKUP_KEY = "hub_connection_month";
export const planLookupKey = (plan: HubPlan, interval: PlanInterval, founding: boolean) =>
  `hub_${plan}${founding ? "_founding" : ""}_${interval}`;

export interface PlanPrice { readonly plan: HubPlan; readonly interval: PlanInterval; readonly founding: boolean }
/** Every catalog lookup key and what it names. */
export const PLAN_LOOKUP_KEYS: Readonly<Record<string, PlanPrice>> = Object.freeze(Object.fromEntries(
  (Object.values(PLAN_CATALOG) as PlanCatalogEntry[]).flatMap((entry) => (["month", "year"] as const).flatMap((interval) => [
    [planLookupKey(entry.plan, interval, false), { plan: entry.plan, interval, founding: false }] as const,
    ...(entry.foundingPrices ? [[planLookupKey(entry.plan, interval, true), { plan: entry.plan, interval, founding: true }] as const] : []),
  ]))));
/** PL-13: every key STRIPE_PLAN_PRICES must map. */
export const ALL_PLAN_PRICE_KEYS: readonly string[] = Object.freeze([...Object.keys(PLAN_LOOKUP_KEYS), PLAN_ADDON_LOOKUP_KEY].sort());

/** PL-14: who bills a tenant's plan. Only Stripe is built; Shopify Billing is a follow-up. */
export const billingProviderSchema = z.enum(["stripe", "shopify"]);
export type BillingProvider = z.infer<typeof billingProviderSchema>;

export const planStatusSchema = z.enum(["none", "trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused"]);
export type PlanStatus = z.infer<typeof planStatusSchema>;
/** PL-4: statuses in which the tenant holds its plan. */
export const ENTITLED_PLAN_STATUSES: readonly PlanStatus[] = Object.freeze(["trialing", "active", "past_due"]);

/** PL-4: the body of POST /v1/billing/plan/checkout. */
export const startPlanCheckoutRequestSchema = z.strictObject({
  plan: hubPlanSchema,
  interval: planIntervalSchema,
  extraConnections: z.number().int().min(0).max(MAX_EXTRA_CONNECTIONS).default(0),
}).refine((request) => request.extraConnections === 0 || request.interval === "month",
  { message: "Extra connections are monthly; choose a monthly plan to add them", path: ["extraConnections"] });
export type StartPlanCheckoutRequest = z.input<typeof startPlanCheckoutRequestSchema>;

export const planCheckoutInputSchema = z.strictObject({
  checkoutId: idSchema,
  plan: hubPlanSchema,
  interval: planIntervalSchema,
  extraConnections: z.number().int().min(0).max(MAX_EXTRA_CONNECTIONS),
});
export const planCheckoutCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(PLAN_CHECKOUT_CREATE_ACTION),
  target: targetSchema.extend({ type: z.literal("plan_checkout") }),
  payload: planCheckoutInputSchema,
}));

export const planCheckoutSchema = z.strictObject({
  id: idSchema,
  plan: hubPlanSchema,
  interval: planIntervalSchema,
  extraConnections: z.number().int().nonnegative(),
  founding: z.boolean(),
  trialDays: z.number().int().nonnegative(),
  status: z.enum(["pending", "completed", "expired"]),
  createdAt: z.iso.datetime(),
});
export type PlanCheckout = z.infer<typeof planCheckoutSchema>;

/** PL-5: 201 body of POST /v1/billing/plan/checkout. */
export const startPlanCheckoutResponseSchema = z.strictObject({
  checkout: planCheckoutSchema,
  checkoutUrl: z.url({ protocol: /^https$/ }),
});
export type StartPlanCheckoutResponse = z.infer<typeof startPlanCheckoutResponseSchema>;

/** PL-6: 200 body of POST /v1/billing/portal. */
export const billingPortalResponseSchema = z.strictObject({ url: z.url({ protocol: /^https$/ }) });
export type BillingPortalResponse = z.infer<typeof billingPortalResponseSchema>;

const limitsSchema = z.strictObject({
  seats: z.number().int(), bookableResources: z.number().int(), managedConnections: z.number().int(),
  automationTokens: z.number().int(), modelAgents: z.boolean(), voice: z.boolean(),
  agentDailyCapCents: z.number().int(), emailsPerMonth: z.number().int(),
});
const offerSchema = z.strictObject({
  plan: hubPlanSchema,
  name: z.string(),
  prices: z.strictObject({ month: z.number().int(), year: z.number().int() }),
  /** Only for an invited tenant (PL-7, PL-11). */
  foundingPrices: z.strictObject({ month: z.number().int(), year: z.number().int() }).nullable(),
  limits: limitsSchema,
});

/** PL-7: 200 body of GET /v1/billing/plan. */
export const billingPlanSchema = z.strictObject({
  billingProvider: billingProviderSchema,
  status: planStatusSchema,
  plan: hubPlanSchema.nullable(),
  interval: planIntervalSchema.nullable(),
  founding: z.boolean(),
  foundingInvite: z.boolean(),
  extraConnections: z.number().int().nonnegative(),
  trialEnd: z.iso.datetime().nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialAvailable: z.boolean(),
  /** The trial a new Checkout would get, in days; 0 when none. */
  trialDays: z.number().int().min(0).max(30),
  paymentFailedAt: z.iso.datetime().nullable(),
  readOnlyAfter: z.iso.datetime().nullable(),
  readOnly: z.boolean(),
  /** Null for a comped tenant: no plan limits apply. */
  limits: limitsSchema.nullable(),
  catalog: z.array(offerSchema),
  extraConnectionPrice: z.number().int(),
  currency: z.literal("usd"),
  checkoutEnabled: z.boolean(),
  portalEnabled: z.boolean(),
});
export type BillingPlan = z.infer<typeof billingPlanSchema>;
