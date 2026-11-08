// The process that runs the M5 billing worker (docs/requirements/stripe.md S-8). One run applies
// stored Stripe events in passes until a pass claims fewer than the limit or the budget is spent.
// Time, ids and the database come in as dependencies.
import { createBillingWorker, type BillingWorker, type ShopifySyncSummary, type StripeSubscriptionReader } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";

export interface BillingRunSummary {
  readonly passes: number;
  readonly claimed: number;
  readonly outcomes: Record<string, number>;
  /** True when the budget ran out while events were still due. */
  readonly budgetSpent: boolean;
  /**
   * plans.md PL-18: the Shopify pass, present only when it is configured; null when the Stripe
   * passes left no time for it.
   */
  readonly shopify?: ShopifySyncSummary | null;
}

/** The part of the Shopify pass the runner calls (core's createShopifyPlanSync). */
export interface ShopifyPass {
  runOnce(options: { readonly deadline?: Date }): Promise<ShopifySyncSummary>;
}

export function createBillingWorkerFromPool(deps: {
  /** A pool whose login may SET ROLE service_role. */
  readonly pool: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly report?: (event: { readonly eventId: string; readonly type: string; readonly outcome: string }) => void;
  readonly subscriptions?: StripeSubscriptionReader;
  readonly planGraceDays?: number;
}): BillingWorker {
  return createBillingWorker({
    service: <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.pool, work),
    clock: deps.clock,
    generateId: deps.generateId,
    ...(deps.report ? { report: deps.report } : {}),
    ...(deps.subscriptions ? { subscriptions: deps.subscriptions } : {}),
    ...(deps.planGraceDays === undefined ? {} : { config: { planGraceDays: deps.planGraceDays } }),
  });
}

export function createBillingRunner(input: {
  readonly worker: BillingWorker;
  readonly clock: { now(): Date };
  readonly budgetMs: number;
  readonly claimLimit: number;
  /** PL-18: runs after the Stripe passes, inside the same budget. */
  readonly shopify?: ShopifyPass;
}) {
  const { worker, clock, budgetMs, claimLimit } = input;
  return {
    async run(): Promise<BillingRunSummary> {
      const started = clock.now().getTime();
      const outcomes: Record<string, number> = {};
      let passes = 0;
      let claimed = 0;
      let budgetSpent = false;
      for (;;) {
        if (passes > 0 && clock.now().getTime() - started >= budgetMs) {
          budgetSpent = true;
          break;
        }
        const pass = await worker.runOnce(claimLimit, { deadline: new Date(started + budgetMs) });
        passes += 1;
        claimed += pass.claimed;
        for (const [outcome, count] of Object.entries(pass.outcomes)) outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
        if (pass.claimed < claimLimit) break;
      }
      if (!input.shopify) return { passes, claimed, outcomes, budgetSpent };
      const deadline = new Date(started + budgetMs);
      const shopify = budgetSpent || clock.now().getTime() >= deadline.getTime() ? null : await input.shopify.runOnce({ deadline });
      return { passes, claimed, outcomes, budgetSpent, shopify };
    },
  };
}
export type BillingRunner = ReturnType<typeof createBillingRunner>;
