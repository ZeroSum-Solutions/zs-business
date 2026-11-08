// Connections C-21 to C-24: the API-to-worker calls of the native Shopify tier. Same signing as the Composio port
// (connections/signing.ts), a different path prefix. The API signs; the worker verifies and runs the operation.
// A transport failure, a non-200 answer or an answer that does not fit the contract is `ConnectorUnavailable`.
import {
  SHOPIFY_PATH_PREFIX,
  shopifyClaimCancelRequestSchema,
  shopifyClaimCancelResponseSchema,
  shopifyClaimConfirmRequestSchema,
  shopifyClaimConfirmResponseSchema,
  shopifyClaimStartRequestSchema,
  shopifyClaimStartResponseSchema,
  shopifyClaimStatusRequestSchema,
  shopifyClaimStatusResponseSchema,
  shopifyCreateHubRequestSchema,
  shopifyCreateHubResponseSchema,
  shopifyOpenRequestSchema,
  shopifyOpenResponseSchema,
  shopifyRedeemClaimRequestSchema,
  shopifyRedeemClaimResponseSchema,
  shopifySignInRequestSchema,
  shopifySignInResponseSchema,
  SHOPIFY_OPERATIONS,
  type ShopifyOperation,
} from "@zs/contracts";
import type { z } from "zod";
import { ConnectorUnavailable, CONNECTOR_TIMEOUT_MS } from "../connections/port.js";
import { signConnectorRequest, type ConnectorEnv } from "../connections/signing.js";
import type { ConnectionStateSecrets } from "../connections/tokens.js";
import type { ShopifyNativeWorker } from "./native-worker.js";

type Req<S extends z.ZodType> = z.infer<S>;
export interface ShopifyPort {
  open(request: Req<typeof shopifyOpenRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyOpenResponseSchema>>;
  createHub(request: Req<typeof shopifyCreateHubRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyCreateHubResponseSchema>>;
  redeemClaim(request: Req<typeof shopifyRedeemClaimRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyRedeemClaimResponseSchema>>;
  signIn(request: Req<typeof shopifySignInRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifySignInResponseSchema>>;
  claimStart(request: Req<typeof shopifyClaimStartRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyClaimStartResponseSchema>>;
  claimStatus(request: Req<typeof shopifyClaimStatusRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyClaimStatusResponseSchema>>;
  claimCancel(request: Req<typeof shopifyClaimCancelRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyClaimCancelResponseSchema>>;
  claimConfirm(request: Req<typeof shopifyClaimConfirmRequestSchema>, signal?: AbortSignal): Promise<z.infer<typeof shopifyClaimConfirmResponseSchema>>;
}

export type ShopifyWorkerOps = Pick<ShopifyNativeWorker, "open" | "createHub" | "redeemClaim" | "signIn" | "claimStart" | "claimStatus" | "claimCancel" | "claimConfirm">;

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface HttpShopifyPortConfig {
  readonly workerUrl: string;
  readonly env: ConnectorEnv;
  readonly secrets: ConnectionStateSecrets;
  readonly clock: { now(): Date };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createHttpShopifyPort(config: HttpShopifyPortConfig): ShopifyPort {
  const origin = new URL(config.workerUrl);
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? CONNECTOR_TIMEOUT_MS;
  async function call<Out>(operation: ShopifyOperation, request: unknown, schema: z.ZodType<Out>, signal?: AbortSignal): Promise<Out> {
    const path = `${SHOPIFY_PATH_PREFIX}${operation}`;
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
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ConnectorUnavailable("too_large");
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new ConnectorUnavailable("too_large");
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new ConnectorUnavailable("malformed"); }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new ConnectorUnavailable("malformed");
      return parsed.data;
    } catch (error) {
      if (error instanceof ConnectorUnavailable) throw error;
      throw new ConnectorUnavailable(timeout.aborted ? "timeout" : "network");
    }
  }
  return {
    open: (r, s) => call("open", r, shopifyOpenResponseSchema, s),
    createHub: (r, s) => call("create_hub", r, shopifyCreateHubResponseSchema, s),
    redeemClaim: (r, s) => call("redeem_claim", r, shopifyRedeemClaimResponseSchema, s),
    signIn: (r, s) => call("sign_in", r, shopifySignInResponseSchema, s),
    claimStart: (r, s) => call("claim_start", r, shopifyClaimStartResponseSchema, s),
    claimStatus: (r, s) => call("claim_status", r, shopifyClaimStatusResponseSchema, s),
    claimCancel: (r, s) => call("claim_cancel", r, shopifyClaimCancelResponseSchema, s),
    claimConfirm: (r, s) => call("claim_confirm", r, shopifyClaimConfirmResponseSchema, s),
  };
}

export const isShopifyOperation = (value: string): value is ShopifyOperation => (SHOPIFY_OPERATIONS as readonly string[]).includes(value);

/** The worker route's body: parse the verified raw body with the operation's strict schema, run it, answer 200 or 400. */
export async function handleShopifyOperation(
  worker: ShopifyWorkerOps,
  operation: ShopifyOperation,
  rawBody: string,
): Promise<{ readonly status: 200 | 400; readonly body: unknown }> {
  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid_body" } }; }
  const bad = { status: 400 as const, body: { error: "invalid_body" } };
  switch (operation) {
    case "open": { const r = shopifyOpenRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.open(r.data) } : bad; }
    case "create_hub": { const r = shopifyCreateHubRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.createHub(r.data) } : bad; }
    case "redeem_claim": { const r = shopifyRedeemClaimRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.redeemClaim(r.data) } : bad; }
    case "sign_in": { const r = shopifySignInRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.signIn(r.data) } : bad; }
    case "claim_start": { const r = shopifyClaimStartRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.claimStart(r.data) } : bad; }
    case "claim_status": {
      const r = shopifyClaimStatusRequestSchema.safeParse(json);
      return r.success ? { status: 200, body: { claim: await worker.claimStatus(r.data) } } : bad;
    }
    case "claim_cancel": { const r = shopifyClaimCancelRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.claimCancel(r.data) } : bad; }
    case "claim_confirm": { const r = shopifyClaimConfirmRequestSchema.safeParse(json); return r.success ? { status: 200, body: await worker.claimConfirm(r.data) } : bad; }
  }
}

/** In-process port over the worker, for tests. */
export function createLocalShopifyPort(worker: ShopifyWorkerOps): ShopifyPort {
  const via = async <Out>(operation: ShopifyOperation, request: unknown, schema: z.ZodType<Out>): Promise<Out> => {
    const out = await handleShopifyOperation(worker, operation, JSON.stringify(request));
    if (out.status !== 200) throw new ConnectorUnavailable("status");
    return schema.parse(out.body);
  };
  return {
    open: (r) => via("open", r, shopifyOpenResponseSchema),
    createHub: (r) => via("create_hub", r, shopifyCreateHubResponseSchema),
    redeemClaim: (r) => via("redeem_claim", r, shopifyRedeemClaimResponseSchema),
    signIn: (r) => via("sign_in", r, shopifySignInResponseSchema),
    claimStart: (r) => via("claim_start", r, shopifyClaimStartResponseSchema),
    claimStatus: (r) => via("claim_status", r, shopifyClaimStatusResponseSchema),
    claimCancel: (r) => via("claim_cancel", r, shopifyClaimCancelResponseSchema),
    claimConfirm: (r) => via("claim_confirm", r, shopifyClaimConfirmResponseSchema),
  };
}
