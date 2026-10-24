// Builds the image worker from a parsed environment: a runtime pool for its stage and fail actions,
// a service pool for the claim, the wallet and the sweeps, the R2 store and the configured adapter.
// Used by the Node worker script, which owns process.env and the clock.
import { setTimeout as sleep } from "node:timers/promises";
import { createImageWorker, createImageWorkflowPort, type ImageWorker, type ImageWorkflowPort } from "@zs/core";
import type { SiteObjectStore } from "@zs/contracts";
import { asService, assertRuntimeLogin, createRuntimePool, createScopedDatabase, type Transaction } from "@zs/db";
import { createR2SiteStore } from "../sites/r2-s3.js";
import type { ImageRunnerEnv } from "./config.js";

export async function startImageWorker(env: ImageRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Test seams: the vendor port and the store; unset, the configured adapter and R2. */
  readonly port?: ImageWorkflowPort;
  readonly store?: SiteObjectStore;
}): Promise<{ worker: ImageWorker; close(): Promise<void> }> {
  const ssl = env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } };
  const runtimePool = createRuntimePool({
    connectionString: env.runtimeDatabaseUrl, max: 2, applicationName: "zs-images", ...ssl,
    onError: (summary) => console.error("Image pool error", summary),
  });
  const servicePool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl, max: 2, applicationName: "zs-images-service", ...ssl,
    onError: (summary) => console.error("Image service pool error", summary),
  });
  const close = async () => { await Promise.all([runtimePool.end(), servicePool.end()]); };
  try {
    // The worker's actions must run under RLS: refuse a privileged runtime login before any work.
    await assertRuntimeLogin(runtimePool);
    // IM-21: a vendor without its key or costs, or an adapter not built, throws here, before any job.
    const port = deps.port ?? createImageWorkflowPort(env.images.config, {
      fetch: (url, init) => fetch(url, init), clock: deps.clock, sleep: (ms) => sleep(ms),
      ...(env.images.apiKey === undefined ? {} : { apiKey: env.images.apiKey }),
      ...(env.images.vendorCostMicros === undefined ? {} : { vendorCostMicros: env.images.vendorCostMicros }),
    });
    const worker = createImageWorker({
      service: <T>(work: (tx: Transaction) => Promise<T>) => asService(servicePool, work),
      db: createScopedDatabase(runtimePool, {
        cancel: "none",
        onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
      }),
      store: deps.store ?? createR2SiteStore(env.r2, { fetch: globalThis.fetch, clock: deps.clock }),
      port,
      config: env.images.config,
      clock: deps.clock,
      generateId: deps.generateId,
      // Operator-only: tenant IDs and reasons, never bytes or keys.
      report: (event) => { if (event.kind === "failed" || event.kind === "error") console.warn("Image worker", event); },
    });
    return { worker, close };
  } catch (error) {
    await close();
    throw error;
  }
}
