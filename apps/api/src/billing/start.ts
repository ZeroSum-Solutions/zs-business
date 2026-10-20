// Builds the billing runner from a parsed environment: the service pool and the worker. Shared by
// the Vercel cron function and the Node worker script, which own process.env and the clock.
import { createRuntimePool } from "@zs/db";
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
  const worker = createBillingWorkerFromPool({
    pool, clock: deps.clock, generateId: deps.generateId,
    report: (event) => {
      // Events that need an operator; the rest are routine.
      if (["mismatch", "orphaned", "error", "not_ours"].includes(event.outcome)) console.warn("Billing worker", event);
    },
  });
  return { runner: createBillingRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs, claimLimit: env.claimLimit }), pool };
}
