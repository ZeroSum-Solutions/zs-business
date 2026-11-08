// Connections C-1, C-3: the ConnectorPort, one method per worker operation, and its two bodies.
//   - `createHttpConnectorPort`: what the API holds. It signs each request (signing.ts), aborts at
//     7 seconds (C-10) or when the caller does, follows no redirect and reads a bounded body. Any
//     transport failure, non-200 answer or answer that does not fit the contract is
//     `ConnectorUnavailable`; callers turn it into `provider_unavailable`.
//   - `createLocalConnectorPort`: the worker's own operations behind the same interface, for tests
//     and for the worker's route handler, which shares `handleConnectorOperation` with it.
// Callers outside the adapter never see a Composio ID or slug they could pass back: requests name
// our connection and attempt IDs and our tool names.
import {
  CONNECTOR_OPERATIONS,
  connectorCancelRequestSchema,
  connectorCancelResponseSchema,
  connectorCompleteRequestSchema,
  connectorCompleteResponseSchema,
  connectorDisconnectRequestSchema,
  connectorDisconnectResponseSchema,
  connectorLinkRequestSchema,
  connectorLinkResponseSchema,
  connectorRunRequestSchema,
  connectorRunResponseSchema,
  type ConnectorCompleteResponse,
  type ConnectorLinkResponse,
  type ConnectorOperation,
  type ConnectorRunResponse,
} from "@zs/contracts";
import type { z } from "zod";
import { ComposioError } from "./composio.js";
import { CONNECTOR_PATH_PREFIX, signConnectorRequest, type ConnectorEnv } from "./signing.js";
import type { ConnectionStateSecrets } from "./tokens.js";
import type { ConnectionsWorker } from "./worker.js";

export type ConnectorLinkRequest = z.infer<typeof connectorLinkRequestSchema>;
export type ConnectorCompleteRequest = z.infer<typeof connectorCompleteRequestSchema>;
export type ConnectorCancelRequest = z.infer<typeof connectorCancelRequestSchema>;
export type ConnectorRunRequest = z.infer<typeof connectorRunRequestSchema>;
export type ConnectorDisconnectRequest = z.infer<typeof connectorDisconnectRequestSchema>;
export type ConnectorCancelResponse = z.infer<typeof connectorCancelResponseSchema>;
export type ConnectorDisconnectResponse = z.infer<typeof connectorDisconnectResponseSchema>;

/**
 * C-4: what `link` hands its caller. `beforeProvider` says the refusal came before any call to Composio. It is not part of the wire body (the strict contract is
 * unchanged, so API and worker deploy in either order): the worker route sends it in the
 * `BEFORE_PROVIDER_HEADER` response header, an older API ignores that header, and an older worker never sends it.
 * Absent means unknown, and the caller keeps the connect charge.
 */
export type ConnectorLinkResult = ConnectorLinkResponse & { readonly beforeProvider?: true };
export const BEFORE_PROVIDER_HEADER = "x-zs-link-before-provider";

export interface ConnectorPort {
  link(request: ConnectorLinkRequest, signal?: AbortSignal): Promise<ConnectorLinkResult>;
  complete(request: ConnectorCompleteRequest, signal?: AbortSignal): Promise<ConnectorCompleteResponse>;
  cancel(request: ConnectorCancelRequest, signal?: AbortSignal): Promise<ConnectorCancelResponse>;
  run(request: ConnectorRunRequest, signal?: AbortSignal): Promise<ConnectorRunResponse>;
  disconnect(request: ConnectorDisconnectRequest, signal?: AbortSignal): Promise<ConnectorDisconnectResponse>;
}

/** The worker could not be reached, or answered something that is not the contract. */
export class ConnectorUnavailable extends Error {
  constructor(readonly detail: "timeout" | "network" | "status" | "malformed" | "too_large") {
    super(`connector ${detail}`);
    this.name = "ConnectorUnavailable";
  }
}

/** C-10: the API gives up on the worker at 7 seconds, inside the request's 10 second deadline. */
export const CONNECTOR_TIMEOUT_MS = 7_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface HttpConnectorPortConfig {
  /** CONNECTIONS_WORKER_URL: the worker project's origin. */
  readonly workerUrl: string;
  readonly env: ConnectorEnv;
  /** CONNECTIONS_INTERNAL_SECRET; requests are signed with `current` only. */
  readonly secrets: ConnectionStateSecrets;
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorUnavailable("too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorUnavailable("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpConnectorPort(config: HttpConnectorPortConfig): ConnectorPort {
  const origin = new URL(config.workerUrl);
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  async function call<Out>(operation: ConnectorOperation, request: unknown, schema: z.ZodType<Out>, signal?: AbortSignal, onHeaders?: (headers: Headers, out: Out) => Out): Promise<Out> {
    const path = `${CONNECTOR_PATH_PREFIX}${operation}`;
    const body = JSON.stringify(request);
    const headers = signConnectorRequest({ secret: config.secrets.current, env: config.env, host: origin.host, path, body, now: config.clock.now() });
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${origin.origin}${path}`, {
        method: "POST",
        redirect: "error",
        headers: { ...headers, "content-type": "application/json" },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new ConnectorUnavailable(timeout.aborted ? "timeout" : "network");
    }
    try {
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConnectorUnavailable("status");
      }
      const text = await readBounded(response);
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new ConnectorUnavailable("malformed"); }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new ConnectorUnavailable("malformed");
      return onHeaders ? onHeaders(response.headers, parsed.data) : parsed.data;
    } catch (error) {
      if (error instanceof ConnectorUnavailable) throw error;
      throw new ConnectorUnavailable(timeout.aborted ? "timeout" : "network");
    }
  }
  return {
    link: (request, signal) => call<ConnectorLinkResult>("link", request, connectorLinkResponseSchema, signal,
      (headers, out) => (out.outcome === "refused" && headers.get(BEFORE_PROVIDER_HEADER) === "1" ? { ...out, beforeProvider: true as const } : out)),
    complete: (request, signal) => call("complete", request, connectorCompleteResponseSchema, signal),
    cancel: (request, signal) => call("cancel", request, connectorCancelResponseSchema, signal),
    run: (request, signal) => call("run", request, connectorRunResponseSchema, signal),
    disconnect: (request, signal) => call("disconnect", request, connectorDisconnectResponseSchema, signal),
  };
}

/** The worker's operations behind the port interface, in process. */
export function createLocalConnectorPort(worker: Pick<ConnectionsWorker, "link" | "complete" | "cancel" | "run" | "disconnect">): ConnectorPort {
  return {
    link: (request, signal) => worker.link(request, signal),
    complete: (request, signal) => worker.complete(request, signal),
    cancel: (request, signal) => worker.cancel(request, signal),
    run: (request, signal) => worker.run(request, signal),
    disconnect: (request, signal) => worker.disconnect(request, signal),
  };
}

export const isConnectorOperation = (value: string): value is ConnectorOperation =>
  (CONNECTOR_OPERATIONS as readonly string[]).includes(value);

/**
 * The worker route's body: parse the raw (already verified) body with the operation's strict schema,
 * run it, and answer a status and JSON. A body that does not fit is 400; a Composio failure the
 * operation does not turn into an outcome is 502. Domain outcomes are always 200.
 */
export async function handleConnectorOperation(
  worker: Pick<ConnectionsWorker, "link" | "complete" | "cancel" | "run" | "disconnect">,
  operation: ConnectorOperation,
  rawBody: string,
  signal?: AbortSignal,
): Promise<{ readonly status: 200 | 400 | 502; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> }> {
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid_body" } }; }
  const port = createLocalConnectorPort(worker);
  const bad = { status: 400 as const, body: { error: "invalid_body" } };
  try {
    switch (operation) {
      case "link": {
        const r = connectorLinkRequestSchema.safeParse(json);
        if (!r.success) return bad;
        // C-4: the body stays the strict contract; the "nothing was created" fact rides in a header.
        const { beforeProvider, ...body } = await port.link(r.data, signal);
        return { status: 200, body, ...(beforeProvider === true ? { headers: { [BEFORE_PROVIDER_HEADER]: "1" } } : {}) };
      }
      case "complete": { const r = connectorCompleteRequestSchema.safeParse(json); return r.success ? { status: 200, body: await port.complete(r.data, signal) } : bad; }
      case "cancel": { const r = connectorCancelRequestSchema.safeParse(json); return r.success ? { status: 200, body: await port.cancel(r.data, signal) } : bad; }
      case "run": { const r = connectorRunRequestSchema.safeParse(json); return r.success ? { status: 200, body: await port.run(r.data, signal) } : bad; }
      case "disconnect": { const r = connectorDisconnectRequestSchema.safeParse(json); return r.success ? { status: 200, body: await port.disconnect(r.data, signal) } : bad; }
    }
  } catch (error) {
    if (error instanceof ComposioError) return { status: 502, body: { error: "provider_unavailable" } };
    throw error;
  }
}
