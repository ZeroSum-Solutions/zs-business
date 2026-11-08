// POST /internal/connections/<operation> (docs/requirements/connections.md C-3): the worker's five signed
// operations. Order of refusals, none of which says why beyond a status: no worker config -> 404; a query
// string -> 400; an unknown operation or method -> 404; an unsigned, stale, wrong-environment, wrong-host,
// replayed or forged request -> 401 (the signature check runs on the raw body, and the nonce is taken only
// after the tag verified); a body that does not fit the operation's strict schema -> 400. Domain outcomes
// are 200 with an `outcome` (core's handleConnectorOperation). Logs carry the operation and a reason code,
// never a body, a signature or a header.
import { Hono, type Context } from "hono";
import {
  apiErrorBody,
  CONNECTOR_NONCE_TTL_MS,
  handleConnectorOperation,
  handleShopifyOperation,
  isConnectorOperation,
  isShopifyOperation,
  verifyConnectorRequest,
  type ConnectionsWorker,
  type ConnectorEnv,
  type ShopifyWorkerOps,
} from "@zs/core";
import { responseHeaders } from "../response-headers.js";

/** Request bodies are small (an order query); anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024;
/** The API gives up at 7 seconds (C-10); the function is stopped at 30. */
const OPERATION_BUDGET_MS = 25_000;

/** The API sends a small signed body at once; one that takes longer than this is not ours. */
const READ_BUDGET_MS = 5_000;

/**
 * B-6: reads at most `max` bytes as they arrive and stops at the cap, so an unsigned chunked body is refused
 * without being buffered. Null when the body is larger than `max`. The read also ends (it throws) when `signal`
 * aborts: the caller went away or the read budget ran out, so a body that trickles in cannot hold the function.
 */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("The body read stopped"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  stopped.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function connectionsInternalRoutes(config: {
  /** Null when the worker is not configured: every route is 404. */
  readonly worker: Pick<ConnectionsWorker, "link" | "complete" | "cancel" | "run" | "disconnect" | "takeNonce"> | null;
  /** The native Shopify tier's nine operations under /internal/shopify/<operation> (C-21 to C-24, C-30); null when it is off. */
  readonly native?: ShopifyWorkerOps | null;
  readonly env: ConnectorEnv;
  readonly secrets: { readonly current: string; readonly previous?: string };
  readonly clock: { now(): Date };
  readonly onRefused?: (operation: string, reason: string) => void;
  readonly onError?: (error: unknown) => void;
  /** How long a request body may take to arrive (tests shorten it). */
  readonly readTimeoutMs?: number;
}) {
  const app = new Hono();
  app.use("*", responseHeaders);
  const notFound = (c: { json: (body: unknown, status: 404) => Response }) => c.json(apiErrorBody("NotFound", "Route not found"), 404);

  /**
   * The shared front of both signed routes: no query string, a capped body read, the signature check on the raw bytes
   * (the nonce is taken only after the tag verified). A Response means the request ended here.
   */
  async function signedBody(c: Context, operation: string, worker: Pick<ConnectionsWorker, "takeNonce">): Promise<{ readonly body: string } | Response> {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if (url.search !== "") return c.json(apiErrorBody("ValidationFailed", "No query string is accepted"), 400);
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 400);
    let body: string;
    try {
      const bytes = await readCapped(c.req.raw.body, MAX_BODY_BYTES, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(config.readTimeoutMs ?? READ_BUDGET_MS)]));
      if (bytes === null) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 400);
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
    return { body };
  }

  app.post("/internal/connections/:operation", async (c) => {
    const worker = config.worker;
    const operation = c.req.param("operation");
    if (!worker || !isConnectorOperation(operation)) return notFound(c);
    const signed = await signedBody(c, operation, worker);
    if (signed instanceof Response) return signed;
    try {
      // B-6: a caller that goes away (the API gave up at 7 s) stops the Composio calls too.
      const out = await handleConnectorOperation(worker, operation, signed.body, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(OPERATION_BUDGET_MS)]));
      return c.json(out.body, out.status);
    } catch (error) {
      config.onError?.(error);
      return c.json(apiErrorBody("Unavailable", "Connections are unavailable"), 503);
    }
  });

  // C-21 to C-24: the native Shopify tier. Same signature, same refusals; the operations never see a Shopify token.
  app.post("/internal/shopify/:operation", async (c) => {
    const worker = config.worker;
    const native = config.native;
    const operation = c.req.param("operation");
    if (!worker || !native || !isShopifyOperation(operation)) return notFound(c);
    const signed = await signedBody(c, `shopify:${operation}`, worker);
    if (signed instanceof Response) return signed;
    try {
      // B-6: only `orders` takes the signal; a caller that goes away stops its Shopify calls too.
      const out = await handleShopifyOperation(native, operation, signed.body, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(OPERATION_BUDGET_MS)]));
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
