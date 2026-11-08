// Hub plan test helpers (plans.md): a price map for every lookup key, a stub plans client for
// tests that never reach Stripe, and Stripe-shaped plan objects. All data is synthetic.
import { ALL_PLAN_PRICE_KEYS, planLookupKey, type HubPlan, type PlanInterval } from "@zs/contracts";
import { createStripePlansClient, type StripePlansClient } from "../../src/billing/plan-stripe.js";
import type { FakeSubscription } from "./fake-stripe-plans.js";

/** Synthetic keys, assembled at runtime so no literal looks like a secret. */
export const PLAN_SECRET_KEY = ["sk", "test", "p".repeat(24)].join("_");
export const READ_KEY = ["rk", "test", "r".repeat(24)].join("_");
export const PLAN_RETURN_URL = "https://app.haldenrowe.example/settings/plan";

/** PL-13: every lookup key to a price ID that names it. */
export const PLAN_PRICES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(ALL_PLAN_PRICE_KEYS.map((key) => [key, `price_${key}`])));

export function plansClient(baseUrl: string, over: { trialDays?: number } = {}): StripePlansClient {
  return createStripePlansClient({
    stripe: { secretKey: PLAN_SECRET_KEY, baseUrl, successUrl: "https://app.haldenrowe.example/wallet/paid", cancelUrl: "https://app.haldenrowe.example/wallet" },
    plans: { prices: { ...PLAN_PRICES }, returnUrl: PLAN_RETURN_URL, trialDays: over.trialDays ?? 14 },
  });
}

/** A plans client that answers without a network, for permission tests. */
export function stubPlans(): StripePlansClient {
  const real = plansClient("https://api.stripe.com");
  return {
    config: real.config,
    createSubscriptionCheckout: async (request) =>
      ({ id: `cs_test_${request.checkoutId.replaceAll("-", "")}`, url: "https://checkout.stripe.test/plan" }),
    createPortalSession: async () => ({ url: "https://billing.stripe.test/p/session" }),
  };
}

const unix = (at: Date) => Math.floor(at.getTime() / 1000);

/** A subscription Stripe would answer, with its plan item and optional add-on item. */
export function subscription(input: {
  id: string; customer: string; tenantId: string; checkoutId?: string; status: string; at: Date;
  plan?: HubPlan; interval?: PlanInterval; founding?: boolean; lookupKey?: string | null; extraConnections?: number;
  trialEnd?: Date | null; endedAt?: Date | null;
}): FakeSubscription {
  const key = input.lookupKey !== undefined ? input.lookupKey : planLookupKey(input.plan ?? "studio", input.interval ?? "month", input.founding ?? false);
  const periodEnd = unix(input.at) + 30 * 86_400;
  return {
    id: input.id, object: "subscription", customer: input.customer, status: input.status,
    metadata: { zs_tenant: input.tenantId, ...(input.checkoutId ? { zs_checkout: input.checkoutId } : {}) },
    items: { object: "list", data: [
      { id: `si_${input.id.slice(4)}`, quantity: 1, price: { id: `price_${key ?? "unknown"}`, lookup_key: key }, current_period_end: periodEnd },
      ...(input.extraConnections ? [{ id: `si_add_${input.id.slice(4)}`, quantity: input.extraConnections,
        price: { id: "price_hub_connection_month", lookup_key: "hub_connection_month" }, current_period_end: periodEnd }] : []),
    ] },
    start_date: unix(input.at), created: unix(input.at),
    trial_end: input.trialEnd ? unix(input.trialEnd) : null,
    ended_at: input.endedAt ? unix(input.endedAt) : null,
    canceled_at: input.endedAt ? unix(input.endedAt) : null,
    cancel_at_period_end: false,
  };
}
