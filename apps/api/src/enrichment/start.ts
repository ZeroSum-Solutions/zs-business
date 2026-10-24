// Builds the enrichment worker from a parsed environment: the service pool, the Treg adapter and the
// worker. Used by the Node worker script, which owns process.env and the clock.
import {
  createEnrichmentWorker,
  createFakeEnrichment,
  createTregEnrichment,
  type EnrichmentPort,
  type EnrichmentWorker,
} from "@zs/core";
import { asService, createRuntimePool, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import type { EnrichmentRunnerEnv } from "./config.js";

export function startEnrichmentWorker(env: EnrichmentRunnerEnv, deps: {
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly port?: EnrichmentPort;
}): { worker: EnrichmentWorker; pool: Pool } {
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 2,
    applicationName: `zs-enrichment:${env.workerId}`,
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Enrichment pool error", summary),
  });
  const port = deps.port ?? (env.enrichment.provider === "treg" && env.tregToken !== undefined
    ? createTregEnrichment({
      token: env.tregToken,
      clock: deps.clock,
      timeoutMs: env.providerTimeoutMs,
      ...(env.tregBaseUrl === undefined ? {} : { baseUrl: env.tregBaseUrl }),
    })
    : createFakeEnrichment());
  const worker = createEnrichmentWorker({
    service: <T>(work: (tx: Transaction) => Promise<T>) => asService(pool, work),
    port,
    clock: deps.clock,
    generateId: deps.generateId,
    // Operator-only: never tenant-visible (E-16).
    report: (event) => console.warn("Enrichment worker", event),
    config: {
      workerId: env.workerId,
      providerTimeoutMs: env.providerTimeoutMs,
      leaseMs: Math.max(60_000, env.providerTimeoutMs * 4),
      enrichment: env.enrichment,
    },
  });
  return { worker, pool };
}
