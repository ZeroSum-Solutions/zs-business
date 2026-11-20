import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";
import type { FollowUpStopReason } from "./agents.js";

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

/**
 * PL-26: the features a plan page may name. The first three are agent kinds, so the page reads the same
 * `agent_settings` switch the runners read (agents.md G-3, G-14); `missed_call_textback` is read from the
 * `voice_numbers.textback_enabled` switch the voice webhook reads. The list is the copy; nothing else
 * in the hub names a feature as included.
 */
export const PLAN_FEATURE_KINDS = ["appointment_reminder", "review_request", "inquiry_followup", "missed_call_textback"] as const;
export const planFeatureKindSchema = z.enum(PLAN_FEATURE_KINDS);
export type PlanFeatureKind = z.infer<typeof planFeatureKindSchema>;

/**
 * PL-26: why a plan's feature is not live for a tenant, in the order the page decides it (the first that holds wins):
 * `read_only` the plan is read-only (PL-8); `not_running` no live runner for the feature (see `PLAN_RUNNERS`);
 * `paused` support's global switch; `disabled` the tenant's own off setting (the default); `stopped` the tenant's kill
 * switch; `quiet_hours` the tenant's quiet window is open now (G-5); `no_budget` the kind's daily model budget is spent
 * or zero (G-15); `not_approved` a message kind has no usable standing template approval (G-19); `missing_setup` an
 * approved message kind has nothing to send with (no sending number for a text, no booking page or review link for a
 * link its wording uses), so every run would skip or fail. A daily draft cap
 * (G-4) is a rate limit, not an off switch, and is left out.
 */
export const PLAN_FEATURE_OFF_REASONS = [
  "read_only", "not_running", "paused", "disabled", "stopped", "quiet_hours", "no_budget", "not_approved", "missing_setup",
] as const;
export type PlanFeatureOffReason = (typeof PLAN_FEATURE_OFF_REASONS)[number];
export type PlanFeatureSwitch = "on" | PlanFeatureOffReason;

/** The agent-control stop reasons (agents.md G-3, G-5, G-15) that turn a plan feature off, by the names the gate returns. */
export const PLAN_FEATURE_BLOCKS = ["global_killed", "disabled", "tenant_killed", "quiet_hours", "cost_cap"] as const;
export type PlanFeatureBlock = (typeof PLAN_FEATURE_BLOCKS)[number];
/** The gate's first stop reason for a kind, as far as the plan page reads it: `daily_cap` and `stalled` are not off switches. */
export const planFeatureBlock = (reason: FollowUpStopReason | null): PlanFeatureBlock | null =>
  reason !== null && (PLAN_FEATURE_BLOCKS as readonly string[]).includes(reason) ? (reason as PlanFeatureBlock) : null;

const BLOCK_REASONS: Readonly<Record<PlanFeatureBlock, PlanFeatureOffReason>> = Object.freeze({
  global_killed: "paused", disabled: "disabled", tenant_killed: "stopped", quiet_hours: "quiet_hours", cost_cap: "no_budget",
});

/**
 * PL-26: one feature's state from the facts the runtime decides it by. The core read builds them from the
 * database (the plan row, the runners' heartbeats, `agent_settings`, the template approval); the demo builds
 * them from its demo agents. This function holds the order, so no caller keeps a second copy of it.
 */
export interface PlanFeatureInputs {
  /** The plan is read-only (PL-8). */
  readonly readOnly: boolean;
  /** Every runner the feature needs has reported inside its window (`planFeatureRunners`). */
  readonly running: boolean;
  /** The first reason the agent may not act now (`planFeatureBlock` of the gate), or null. */
  readonly blockedBy: PlanFeatureBlock | null;
  /** A message kind has a current template with a usable standing approval; true for a kind with no template. */
  readonly approved: boolean;
  /** A message kind has what its current wording sends with: a sending number for a text, the links it names. */
  readonly equipped: boolean;
}
export const planFeatureSwitch = (input: PlanFeatureInputs): PlanFeatureSwitch =>
  input.readOnly ? "read_only"
    : !input.running ? "not_running"
      : input.blockedBy !== null ? BLOCK_REASONS[input.blockedBy]
        : !input.approved ? "not_approved"
          : !input.equipped ? "missing_setup"
            : "on";

/**
 * PL-26: the runners whose heartbeat (`runner_heartbeats`) says a feature can run. A deploy whose flag is off
 * writes none, so the feature is `not_running`: `followup` is the follow-up agent (`FOLLOWUP_AGENT`);
 * `templated` the reminder and review runs (`AGENT_TEMPLATED`); `delivery_email` and `delivery_sms` the delivery
 * worker (`DELIVERY_WORKER`) with its email provider or its SMS provider (`SMS_PROVIDER`).
 */
export const PLAN_RUNNERS = ["followup", "templated", "delivery_email", "delivery_sms"] as const;
export const planRunnerSchema = z.enum(PLAN_RUNNERS);
export type PlanRunner = z.infer<typeof planRunnerSchema>;
/** A template's channel decides which delivery runner sends it; null when the kind has no current template yet. */
export const planFeatureRunners = (kind: PlanFeatureKind, channel: "email" | "sms" | null): readonly PlanRunner[] => {
  switch (kind) {
    case "inquiry_followup": return ["followup"];
    case "missed_call_textback": return ["delivery_sms"];
    case "appointment_reminder":
    case "review_request": return channel === null ? ["templated"] : ["templated", channel === "sms" ? "delivery_sms" : "delivery_email"];
  }
};

/** The limits that are plain yes/no entitlements: the ones a feature may be tied to. */
type FlagLimit = { [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never }[keyof PlanLimits];
export interface PlanFeatureDefinition {
  readonly kind: PlanFeatureKind;
  /** The name the plan page shows. */
  readonly label: string;
  /**
   * The `PlanLimits` flag that decides whether a plan holds the feature, read from the same limits the plan response
   * and the dispatcher use; null where PL-1 sets no limit, so every plan holds it. A comped tenant (null limits) holds all.
   */
  readonly limit: FlagLimit | null;
}
export const PLAN_FEATURES: readonly PlanFeatureDefinition[] = Object.freeze([
  { kind: "appointment_reminder", label: "Appointment reminders", limit: null },
  { kind: "review_request", label: "Review requests", limit: null },
  { kind: "inquiry_followup", label: "Agents that draft with AI", limit: "modelAgents" },
  { kind: "missed_call_textback", label: "Missed-call text back", limit: "voice" },
]);
/** PL-26: whether a plan's limits hold the feature (null limits: a comped tenant, which holds all). */
export const planHoldsFeature = (limits: PlanLimits | null, feature: PlanFeatureDefinition): boolean =>
  limits === null || feature.limit === null || limits[feature.limit];

export const planFeatureSchema = z.strictObject({
  kind: planFeatureKindSchema,
  label: z.string(),
  /** `included`: in the plan and live for this business. `off`: in the plan, but not live, so the page must not call it live. */
  state: z.enum(["included", "off"]),
  /** Why it is off; null when included. */
  offReason: z.enum(PLAN_FEATURE_OFF_REASONS).nullable(),
});
export type PlanFeature = z.infer<typeof planFeatureSchema>;

/**
 * PL-26: the features a plan names, each `included` only while it is live for the tenant. A feature the plan does
 * not hold is left out. `switches` is built by `planFeatureSwitch` from what the runtime reads, never written by hand.
 */
export function planFeatures(limits: PlanLimits | null, switches: Readonly<Record<PlanFeatureKind, PlanFeatureSwitch>>): PlanFeature[] {
  return PLAN_FEATURES.filter((feature) => planHoldsFeature(limits, feature)).map((feature) => {
    const state = switches[feature.kind];
    return state === "on"
      ? { kind: feature.kind, label: feature.label, state: "included" as const, offReason: null }
      : { kind: feature.kind, label: feature.label, state: "off" as const, offReason: state };
  });
}

/**
 * PL-25: releases a tenant may record in any 24 hours (all its sites). A free tenant (`tenant_plans.free_tier`)
 * gets the hosting decision's 20; paid plans get more; a comped tenant has no limit. Not part of `PlanLimits`,
 * so the plan response is unchanged.
 */
export const FREE_SITE_PUBLISHES_PER_DAY = 20;
export const PLAN_SITE_PUBLISHES_PER_DAY: Readonly<Record<HubPlan, number>> = Object.freeze({ solo: 100, studio: 200, pro: 500 });

/** PL-2: the plan whose limits a subscription with an unknown price holds: the lowest paid plan. */
export const HELD_PLAN: HubPlan = "solo";
export const HELD_PLAN_INTERVAL: PlanInterval = "month";

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
  /** PL-26. Optional so a response without it parses and a dashboard deployed first accepts it; the page then names no feature. */
  features: z.array(planFeatureSchema).optional(),
});

/** PL-22: an operator-granted plan that is active now. The note and the operator's name never leave the server. */
export const planGrantSchema = z.strictObject({
  source: z.literal("grant"),
  plan: hubPlanSchema,
  /** Null: no end date. */
  grantedUntil: z.iso.datetime().nullable(),
});
export type PlanGrant = z.infer<typeof planGrantSchema>;

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
  /** PL-26: what `limits` names, each feature on or off for this business. Optional like `offerSchema.features`. */
  features: z.array(planFeatureSchema).optional(),
  catalog: z.array(offerSchema),
  extraConnectionPrice: z.number().int(),
  currency: z.literal("usd"),
  checkoutEnabled: z.boolean(),
  portalEnabled: z.boolean(),
  /** PL-19: Shopify's plan selection page for a Shopify-billed tenant; null otherwise. */
  shopifyManageUrl: z.url({ protocol: /^https$/ }).nullable(),
  /**
   * PL-21, PL-22: present only while an operator-granted plan is active. `limits` are then the granted plan's
   * and `readOnly` is false. Optional so a response without it parses and a dashboard deployed first accepts it.
   */
  grant: planGrantSchema.optional(),
});
export type BillingPlan = z.infer<typeof billingPlanSchema>;
