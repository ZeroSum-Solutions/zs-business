// Builds the delivery runner from a parsed environment: the service pool and the worker. Shared by
// the Vercel cron function and the Node worker script, which own process.env and the clock.
import { createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import { createRunnerHeartbeats, DELIVERY_HEARTBEAT_SECONDS, serviceOnPool, withHeartbeats } from "../runner-heartbeat.js";
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
  // A throw after the pool exists must not leave it behind: the guarded cron entry retries the build.
  try {
    const worker = createDeliveryWorkerFromEnv({
      env, pool, clock: deps.clock, generateId: deps.generateId,
      report: (event) => console.warn("Delivery worker", event),
    });
    // PL-26: each finished run tells the plan page the delivery worker is live, and SMS only when its provider is configured.
    const window = Math.max(DELIVERY_HEARTBEAT_SECONDS, Math.ceil(env.intervalMs / 1000) * 4);
    const runner = withHeartbeats(createDeliveryRunner({ worker, clock: deps.clock, budgetMs: env.budgetMs, claimLimit: env.claimLimit }), {
      job: "delivery",
      heartbeats: createRunnerHeartbeats({ service: serviceOnPool(pool), clock: deps.clock }),
      beats: [{ runner: "delivery_email", freshForSeconds: window }, ...(env.twilio !== null ? [{ runner: "delivery_sms" as const, freshForSeconds: window }] : [])],
    });
    return { runner, pool };
  } catch (error) {
    void pool.end().catch(() => undefined);
    throw error;
  }
}
