/**
 * The demo Hub plan (plans.md PL-7): a Studio plan in its trial, with the real catalog, and a demo
 * wallet (delivery.md D-4). Demo mode never reaches Stripe, so Checkout and the Portal are off and say so.
 */
import { EXTRA_CONNECTION_PRICE, PLAN_CATALOG, type BillingPlan, type PlanCatalogEntry, type WalletSummary } from "@zs/contracts";
import { ApiError, demoError } from "../errors";
import type { BillingApi } from "../types";
import type { DemoClock } from "./adapter";
import type { DemoActor } from "./agents";

export const DEMO_PLAN_OFF = "Demo mode does not open Stripe. Plans and billing work in the live hub.";

export interface DemoBillingOptions {
  clock?: DemoClock;
  latencyMs?: number;
  /** The demo adapter's wait: its latency, and its offline and expired-session switches. Replaces `latencyMs`. */
  wait?: () => Promise<void>;
  /** Who the demo session is: the wallet needs `billing`, which only an owner has (D-4). */
  actor?: () => DemoActor;
}

export function createDemoBilling(options: DemoBillingOptions = {}): BillingApi {
  const clock = options.clock ?? { now: () => new Date() };
  const latency = options.latencyMs ?? 0;
  const wait = options.wait ?? (() => (latency > 0 ? new Promise<void>((resolve) => setTimeout(resolve, latency)) : Promise.resolve()));
  const actor = options.actor;
  const ahead = (days: number) => new Date(clock.now().getTime() + days * 86_400_000).toISOString();

  const plan = (): BillingPlan => ({
    billingProvider: "stripe",
    status: "trialing",
    plan: "studio",
    interval: "month",
    founding: false,
    foundingInvite: false,
    extraConnections: 0,
    trialEnd: ahead(9),
    currentPeriodEnd: ahead(9),
    cancelAtPeriodEnd: false,
    trialAvailable: false,
    trialDays: 0,
    paymentFailedAt: null,
    readOnlyAfter: null,
    readOnly: false,
    limits: { ...PLAN_CATALOG.studio.limits },
    catalog: (Object.values(PLAN_CATALOG) as PlanCatalogEntry[]).map((entry) => ({
      plan: entry.plan, name: entry.name, prices: { ...entry.prices }, foundingPrices: null, limits: { ...entry.limits },
    })),
    extraConnectionPrice: EXTRA_CONNECTION_PRICE,
    currency: "usd",
    checkoutEnabled: false,
    portalEnabled: false,
    shopifyManageUrl: null,
  });

  const wallet = (): WalletSummary => ({ currency: "usd", balance: 4118, reserved: 250, available: 3868 });

  return {
    async getBillingPlan() { await wait(); return plan(); },
    async getWallet() {
      await wait();
      if (actor && actor().role !== "owner") throw demoError("Forbidden");
      return wallet();
    },
    async startPlanCheckout() { await wait(); throw new ApiError("not_found", DEMO_PLAN_OFF, 404, "NotFound"); },
    async openBillingPortal() { await wait(); throw new ApiError("not_found", DEMO_PLAN_OFF, 404, "NotFound"); },
  };
}
