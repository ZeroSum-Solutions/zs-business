// POST /internal/connections/<operation> (docs/requirements/connections.md C-3): the worker's five signed
// operations. Order of refusals, none of which says why beyond a status: no worker config -> 404; a query
// string -> 400; an unknown operation or method -> 404; an unsigned, stale, wrong-environment, wrong-host,
// replayed or forged request -> 401 (the signature check runs on the raw body, and the nonce is taken only
// after the tag verified); a body that does not fit the operation's strict schema -> 400. Domain outcomes
// are 200 with an `outcome` (core's handleConnectorOperation). Logs carry the operation and a reason code,
// never a body, a signature or a header.
import { Hono } from "hono";
import {
  apiErrorBody,
  CONNECTOR_NONCE_TTL_MS,
  handleConnectorOperation,
  isConnectorOperation,
  verifyConnectorRequest,
  type ConnectionsWorker,
  type ConnectorEnv,
} from "@zs/core";

/** Request bodies are small (an order query); anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024;
/** The API gives up at 7 seconds (C-10); the function is stopped at 30. */
const OPERATION_BUDGET_MS = 25_000;

export function connectionsInternalRoutes(config: {
  /** Null when the worker is not configured: every route is 404. */
  readonly worker: Pick<ConnectionsWorker, "link" | "complete" | "cancel" | "run" | "disconnect" | "takeNonce"> | null;
  readonly env: ConnectorEnv;
  readonly secrets: { readonly current: string; readonly previous?: string };
  readonly clock: { now(): Date };
  readonly onRefused?: (operation: string, reason: string) => void;
  readonly onError?: (error: unknown) => void;
}) {
  const app = new Hono();
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json(apiErrorBody("NotFound", "Route not found"), 404);
  app.post("/internal/connections/:operation", async (c) => {
    const worker = config.worker;
    const operation = c.req.param("operation");
    if (!worker || !isConnectorOperation(operation)) return notFound(c);
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if (url.search !== "") return c.json(apiErrorBody("ValidationFailed", "No query string is accepted"), 400);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 400);
    let body: string;
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 400);
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return c.json(apiErrorBody("ValidationFailed", "Invalid request body"), 400);
    }
    const now = config.clock.now();
    const verified = await verifyConnectorRequest({
      secrets: config.secrets,
      env: config.env,
      host: c.req.header("host") ?? url.host,
      method: c.req.method,
      path: url.pathname,
      headers: c.req.raw.headers,
      body,
      now,
      takeNonce: (jti, expiresAt) => worker.takeNonce(jti, expiresAt),
    }).catch((error: unknown) => {
      config.onError?.(error);
      return null;
    });
    if (verified === null) return c.json(apiErrorBody("Unavailable", "Connections are unavailable"), 503);
    if (!verified.ok) {
      config.onRefused?.(operation, verified.reason);
      return c.json(apiErrorBody("Unauthorized", "Invalid internal credentials"), 401);
    }
    try {
      const out = await handleConnectorOperation(worker, operation, body, AbortSignal.timeout(OPERATION_BUDGET_MS));
      return c.json(out.body, out.status);
    } catch (error) {
      config.onError?.(error);
      return c.json(apiErrorBody("Unavailable", "Connections are unavailable"), 503);
    }
  });
  app.notFound((c) => notFound(c));
  return app;
}

export { CONNECTOR_NONCE_TTL_MS };
