// Builds the Activepieces webhook runner from a parsed environment: the service pool and the
// worker. Shared by the Vercel cron function and the Node worker script, which own process.env
// and the clock.
import { createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import type { ActivepiecesRunnerEnv } from "./config.js";
import { createActivepiecesRunner, createWebhookWorkerFromEnv, type ActivepiecesRunner } from "./runner.js";

export function startActivepiecesRunner(env: ActivepiecesRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}): { runner: ActivepiecesRunner; pool: Pool } {
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 2,
    applicationName: `zs-activepieces:${env.workerId}`,
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Activepieces pool error", summary),
  });
  const worker = createWebhookWorkerFromEnv({
    env, pool, clock: deps.clock, generateId: deps.generateId,
    report: (event) => console.warn("Activepieces webhook worker", event),
  });
  return { runner: createActivepiecesRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs, claimLimit: env.claimLimit }), pool };
}
