// Builds the connections worker from a parsed environment: the service pool, the Composio client and
// the worker (docs/requirements/connections.md C-3, C-7). Shared by the Vercel function and tests, which
// own process.env, the clock and `fetch`.
import {
  createComposioClient,
  createConnectionsWorker,
  createShopifyClient,
  createShopifyNativeWorker,
  type ConnectionsWorker,
  type ConnectionsWorkerReport,
  type ShopifyNativeReport,
  type ShopifyNativeWorker,
} from "@zs/core";
import { randomUUID } from "node:crypto";
import { asService, createRuntimePool } from "@zs/db";
import type { Pool } from "pg";
import { createSupabaseAuthAdmin } from "../supabase-auth-admin.js";
import type { ConnectionsWorkerRuntimeEnv } from "./config.js";
import { createShopifyHub } from "./shopify-hub.js";

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

/** C-24: which native events an operator should see. Never a token, a code, an email or a customer value. */
const NATIVE_NOTEWORTHY = new Set<ShopifyNativeReport["kind"]>(["needs_reauth", "non_expiring_refused", "hub_failed", "claim_locked"]);
export function shopifyNativeReporter(log: { info(message: string, event: unknown): void; warn(message: string, event: unknown): void }) {
  return (event: ShopifyNativeReport): void => {
    if (NATIVE_NOTEWORTHY.has(event.kind)) log.warn("Shopify native", event);
    else log.info("Shopify native", event);
  };
}

export function startConnectionsWorker(env: ConnectionsWorkerRuntimeEnv, deps: {
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
}): { worker: ConnectionsWorker; pool: Pool; native: ShopifyNativeWorker | null } {
  // Every worker statement is its own short transaction and none is held across a Composio call (B-5), so one
  // client is enough for a pass; four let the internal operations of one instance overlap.
  const pool = createRuntimePool({
    connectionString: env.serviceDatabaseUrl,
    max: 4,
    applicationName: "zs-connections",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    onError: (summary) => console.error("Connections pool error", summary),
  });
  const service = <T>(work: Parameters<typeof asService<T>>[1]) => asService(pool, work);
  const shopify = env.shopify;
  const native = shopify === null ? null : createShopifyNativeWorker({
    service,
    newId: randomUUID,
    client: createShopifyClient({
      clientId: shopify.clientId,
      clientSecret: shopify.secrets.current,
      apiVersion: shopify.apiVersion,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    clock: deps.clock,
    config: { clientId: shopify.clientId, secrets: shopify.secrets, sealKeys: shopify.sealKeys, graceDays: shopify.graceDays },
    hub: createShopifyHub({
      pool,
      auth: createSupabaseAuthAdmin({ projectRef: shopify.projectRef, serviceKey: shopify.serviceKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
      clock: deps.clock,
      signInUrl: shopify.signInUrl,
      report: (event) => console.warn("Shopify hub", event),
    }),
    report: shopifyNativeReporter(console),
  });
  const worker = createConnectionsWorker({
    service,
    composio: createComposioClient({ apiKey: env.composioApiKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    clock: deps.clock,
    config: { env: env.env, callbackUrl: env.callbackUrl, authConfigIds: { ...env.authConfigIds } },
    ...(native === null ? {} : { native: { run: native.run, finishDisconnect: native.finishDisconnect, pass: native.pass } }),
    report: connectionsWorkerReporter(console),
  });
  return { worker, pool, native };
}
