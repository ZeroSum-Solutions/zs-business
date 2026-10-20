// Builds the delivery runner from a parsed environment: the service pool and the worker. Shared by
// the Vercel cron function and the Node worker script, which own process.env and the clock.
import { createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import type { DeliveryRunnerEnv } from "./config.js";
import { createDeliveryRunner, createDeliveryWorkerFromEnv, type DeliveryRunner } from "./runner.js";

export function startDeliveryRunner(env: DeliveryRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): { runner: DeliveryRunner; pool: Pool } {
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 2,
    applicationName: `zs-delivery:${env.workerId}`,
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Delivery pool error", summary),
  });
  const worker = createDeliveryWorkerFromEnv({
    env, pool, clock: deps.clock, generateId: deps.generateId,
    report: (event) => console.warn("Delivery worker", event),
  });
  return { runner: createDeliveryRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs, claimLimit: env.claimLimit }), pool };
}
