// Connections C-22: the API-side edge of the native Shopify tier.
//   - `createShopifyClaimsSession`: a signed-in hub owner starts, reads, cancels and confirms a claim. The worker
//     holds the claim; this layer decides who may ask.
//   - `createShopifyEmbedded`: the embedded app's anonymous calls. The Shopify ID token is the only credential and
//     only the worker checks it; this layer rate-limits by caller address and maps a dead worker to "unavailable".
// Both are off (NotFound) when the API has no Shopify port.
import {
  Conflict,
  NotFound,
  TenantDenied,
  uuidSchema,
  type ShopifyClaimStartResponse,
  type ShopifyClaimView,
  type ShopifyCreateHubResponse,
  type ShopifyOpenResponse,
  type ShopifyOrdersResponse,
  type ShopifyRedeemClaimResponse,
  type ShopifySignInResponse,
} from "@zs/contracts";
import { ConnectionsRefused } from "../edge/errors.js";
import type { EdgeDependencies, Principal } from "../edge/session.js";
import { requireMember } from "../members/access.js";
import { ConnectorUnavailable } from "../connections/port.js";
import type { ConnectionCharge } from "../connections/limits.js";
import type { ShopifyPort } from "./port.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

function shopifyOf(deps: EdgeDependencies) {
  const config = deps.connections;
  if (!config?.shopify) throw new NotFound();
  return { shopify: config.shopify, limiter: config.limiter };
}

async function unavailable<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ConnectorUnavailable) throw new ConnectionsRefused("unavailable");
    throw error;
  }
}

async function charge(limiter: ReturnType<typeof shopifyOf>["limiter"], charges: readonly ConnectionCharge[], signal?: AbortSignal): Promise<void> {
  const taken = await limiter.take(charges, signal ? { signal } : {});
  if (!taken.ok) throw new ConnectionsRefused("rate_limited", taken.retryAfterSeconds);
}

export function createShopifyClaimsSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  /** Owners only: a claim binds a store to the whole business. Staff with `integrations` cannot start one. */
  const owner = async () => {
    const { shopify, limiter } = shopifyOf(deps);
    const member = await deps.db.tenant(tenantId, (tx) => requireMember(tx, tenantId, actorId, "integrations"));
    if (member.role !== "owner") throw new TenantDenied();
    return { shopify, limiter, memberId: member.memberId };
  };
  return {
    async start(signal?: AbortSignal): Promise<ShopifyClaimStartResponse> {
      const { shopify, limiter, memberId } = await owner();
      await charge(limiter, [{ key: `shopify-claim-start:${tenantId}`, rule: { limit: 10, windowMs: HOUR } }], signal);
      const out = await unavailable(shopify.claimStart({ tenantId, memberId }, signal));
      if (out.outcome === "already_connected") throw new Conflict("A store is already connected", { reason: "already_connected" });
      return out;
    },
    async status(signal?: AbortSignal): Promise<{ claim: ShopifyClaimView | null }> {
      const { shopify } = await owner();
      return unavailable(shopify.claimStatus({ tenantId }, signal));
    },
    async cancel(claimId: unknown, signal?: AbortSignal): Promise<{ outcome: "cancelled" }> {
      const { shopify } = await owner();
      const id = uuidSchema.safeParse(claimId);
      if (!id.success) throw new NotFound();
      const out = await unavailable(shopify.claimCancel({ tenantId, claimId: id.data }, signal));
      if (out.outcome === "not_found") throw new NotFound();
      return { outcome: "cancelled" };
    },
    async confirm(claimId: unknown, signal?: AbortSignal): Promise<{ connectionId: string }> {
      const { shopify, memberId } = await owner();
      const id = uuidSchema.safeParse(claimId);
      if (!id.success) throw new NotFound();
      const out = await unavailable(shopify.claimConfirm({ tenantId, claimId: id.data, memberId }, signal));
      switch (out.outcome) {
        case "confirmed": return { connectionId: out.connectionId };
        case "not_found": throw new NotFound();
        case "billing_conflict": throw new Conflict("This business's billing cannot take the store", { reason: "billing_conflict", detail: out.reason });
        default: throw new Conflict("The claim cannot be confirmed", { reason: out.outcome });
      }
    },
  };
}

/** The embedded app's calls; `address` is the caller's network address, already canonical. */
export function createShopifyEmbedded(deps: EdgeDependencies, address: string) {
  const { shopify, limiter } = shopifyOf(deps);
  const guard = (signal?: AbortSignal) => charge(limiter, [{ key: `shopify-embedded:${address}`, rule: { limit: 240, windowMs: 10 * MINUTE } }], signal);
  return {
    async open(idToken: string, signal?: AbortSignal): Promise<ShopifyOpenResponse> {
      await guard(signal);
      return unavailable(shopify.open({ idToken }, signal));
    },
    /** C-30: the same guard as `open`, so a page load (open, then orders) costs two of the 240. */
    async orders(idToken: string, signal?: AbortSignal): Promise<ShopifyOrdersResponse> {
      await guard(signal);
      return unavailable(shopify.orders({ idToken }, signal));
    },
    async createHub(idToken: string, signal?: AbortSignal): Promise<ShopifyCreateHubResponse> {
      await charge(limiter, [{ key: `shopify-create-hub:${address}`, rule: { limit: 20, windowMs: HOUR } }], signal);
      return unavailable(shopify.createHub({ idToken }, signal));
    },
    async redeemClaim(idToken: string, code: string, signal?: AbortSignal): Promise<ShopifyRedeemClaimResponse> {
      await charge(limiter, [{ key: `shopify-redeem:${address}`, rule: { limit: 30, windowMs: HOUR } }], signal);
      return unavailable(shopify.redeemClaim({ idToken, code }, signal));
    },
    async signIn(idToken: string, signal?: AbortSignal): Promise<ShopifySignInResponse> {
      await charge(limiter, [{ key: `shopify-sign-in:${address}`, rule: { limit: 20, windowMs: HOUR } }], signal);
      return unavailable(shopify.signIn({ idToken }, signal));
    },
  };
}

export type { ShopifyPort };
