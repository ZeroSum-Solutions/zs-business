// Builds the connections worker from a parsed environment: the service pool, the Composio client and
// the worker (docs/requirements/connections.md C-3, C-7). Shared by the Vercel function and tests, which
// own process.env, the clock and `fetch`.
import { createComposioClient, createConnectionsWorker, type ConnectionsWorker, type ConnectionsWorkerReport } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import type { ConnectionsWorkerRuntimeEnv } from "./config.js";

/** Events worth an operator's attention; routine runs and health reads are left out. Never arguments, output or provider text. */
const NOTEWORTHY = new Set<ConnectionsWorkerReport["kind"]>(["reauthorize", "disconnect_retry", "sweep_failed", "health_failed", "pass_stopped", "cooldown"]);

export function startConnectionsWorker(env: ConnectionsWorkerRuntimeEnv, deps: {
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
}): { worker: ConnectionsWorker; pool: Pool } {
  // A pass holds one connection through a row's Composio calls and the budget call uses another.
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 4,
    applicationName: "zs-connections",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Connections pool error", summary),
  });
  const worker = createConnectionsWorker({
    service: (work) => asService(pool, work),
    composio: createComposioClient({ apiKey: env.composioApiKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    clock: deps.clock,
    config: { env: env.env, callbackUrl: env.callbackUrl, authConfigIds: { ...env.authConfigIds } },
    report: (event) => {
      if (NOTEWORTHY.has(event.kind)) console.warn("Connections worker", event);
    },
  });
  return { worker, pool };
}
