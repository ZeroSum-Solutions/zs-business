// Builds the connections worker from a parsed environment: the service pool, the Composio client and
// the worker (docs/requirements/connections.md C-3, C-7). Shared by the Vercel function and tests, which
// own process.env, the clock and `fetch`.
import { createComposioClient, createConnectionsWorker, type ConnectionsWorker, type ConnectionsWorkerReport } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import type { ConnectionsWorkerRuntimeEnv } from "./config.js";

/** Events worth an operator's attention. Never arguments, output, labels or provider text (C-14). */
const NOTEWORTHY = new Set<ConnectionsWorkerReport["kind"]>([
  "reauthorize", "disconnect_retry", "sweep_failed", "health_failed", "pass_stopped", "cooldown", "account_mismatch", "link_orphan", "key_refused", "database_error",
]);

/**
 * C-7, C-14: every run is logged with the tenant, connection, our tool name, our code and the time it took;
 * the noteworthy events are warnings; routine sweeps, restores and disconnects are left out.
 */
export function connectionsWorkerReporter(log: { info(message: string, event: unknown): void; warn(message: string, event: unknown): void }) {
  return (event: ConnectionsWorkerReport): void => {
    if (event.kind === "run") {
      log.info("Connections run", { tenantId: event.tenantId, connectionId: event.connectionId, tool: event.tool, code: event.code, ms: event.ms });
      return;
    }
    if (NOTEWORTHY.has(event.kind)) log.warn("Connections worker", event);
  };
}

export function startConnectionsWorker(env: ConnectionsWorkerRuntimeEnv, deps: {
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
}): { worker: ConnectionsWorker; pool: Pool } {
  // Every worker statement is its own short transaction and none is held across a Composio call (B-5), so one
  // client is enough for a pass; four let the internal operations of one instance overlap.
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
    report: connectionsWorkerReporter(console),
  });
  return { worker, pool };
}
