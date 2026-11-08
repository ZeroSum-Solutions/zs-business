// Builds the billing runner from a parsed environment: the service pool and the worker. Shared by
// the Vercel cron function and the Node worker script, which own process.env and the clock.
import { createShopifyPlanSync, createShopifySubscriptionReader, createStripeSubscriptionReader } from "@zs/core";
import { asService, createRuntimePool, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import type { BillingRunnerEnv } from "./config.js";
import { createBillingRunner, createBillingWorkerFromPool, type BillingRunner } from "./runner.js";

export function startBillingRunner(env: BillingRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): { runner: BillingRunner; pool: Pool } {
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 2,
    applicationName: "zs-billing",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Billing pool error", summary),
  });
  // A throw after the pool exists must not leave it behind: the guarded cron entry retries the build.
  try {
    const worker = createBillingWorkerFromPool({
      pool, clock: deps.clock, generateId: deps.generateId,
      planGraceDays: env.planGraceDays,
      ...(env.stripeReader === null ? {} : { subscriptions: createStripeSubscriptionReader({ config: env.stripeReader }) }),
      report: (event) => {
        // Events that need an operator; the rest are routine.
        if (["mismatch", "orphaned", "error", "not_ours", "plan_duplicate"].includes(event.outcome)) console.warn("Billing worker", event);
      },
    });
    // plans.md PL-18: the Shopify pass, after the Stripe passes.
    const shopify = env.shopify === null ? undefined : createShopifyPlanSync({
      service: <T>(work: (tx: Transaction) => Promise<T>) => asService(pool, work),
      clock: deps.clock,
      reader: createShopifySubscriptionReader({ config: env.shopify.reader }),
      limit: env.shopify.syncLimit,
      graceDays: env.planGraceDays,
      report: (event) => console.warn("Billing Shopify pass", event),
    });
    return {
      runner: createBillingRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs, claimLimit: env.claimLimit, ...(shopify ? { shopify } : {}) }),
      pool,
    };
  } catch (error) {
    void pool.end().catch(() => undefined);
    throw error;
  }
}
