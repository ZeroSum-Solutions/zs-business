// docs/requirements/connections.md C-21, C-22: the embedded app's anonymous calls, mounted at
// /public/v1/shopify/embedded/<operation>. The only credential is the Shopify session token (an ID token) in
// `Authorization: Bearer`; no cookie is read or set. The route checks nothing about the token: it rate-limits by the
// caller's address and forwards it to the worker, which verifies it. Every answer is no-store.
import { ValidationFailed, shopifyClaimCodeSchema, shopifyIdTokenSchema } from "@zs/contracts";
import { createShopifyEmbedded, type EdgeDependencies } from "@zs/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiErrorBody } from "@zs/core";
import type { AppEnv } from "../app.js";
import { createClientAddress, addressBucket, type ClientIpConfig } from "./client-ip.js";

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

export function shopifyEmbeddedRoutes(
  config: { readonly clientIp?: ClientIpConfig | undefined },
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  const clientAddress = createClientAddress(config.clientIp);
  const session = (c: Context<AppEnv>) => {
    const socket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress;
    return createShopifyEmbedded(requestEdge(c), addressBucket(clientAddress(socket, (name) => c.req.header(name))));
  };
  /** A missing or malformed token is a plain 401: nothing about the worker or the store is learned. */
  const tokenOf = (c: Context<AppEnv>): string | null => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    const parsed = shopifyIdTokenSchema.safeParse(match?.[1]);
    return parsed.success ? parsed.data : null;
  };
  const refused = (c: Context<AppEnv>) => c.json(apiErrorBody("Unauthorized", "Invalid session token"), 401);
  /** A session token the worker rejects (expired, wrong app, forged) is a 401 too, so the page can ask App Bridge for a fresh one and retry once. */
  const answer = (c: Context<AppEnv>, result: { readonly outcome: string }) => (result.outcome === "invalid_token" ? refused(c) : c.json(result));
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
    })
    .use("*", bodyLimit({ maxSize: 2048, onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413) }))
    .post("/open", async (c) => {
      const token = tokenOf(c);
      return token === null ? refused(c) : answer(c, await session(c).open(token, c.var.signal));
    })
    .post("/create-hub", async (c) => {
      const token = tokenOf(c);
      return token === null ? refused(c) : answer(c, await session(c).createHub(token, c.var.signal));
    })
    .post("/sign-in", async (c) => {
      const token = tokenOf(c);
      return token === null ? refused(c) : answer(c, await session(c).signIn(token, c.var.signal));
    })
    .post("/redeem-claim", async (c) => {
      const token = tokenOf(c);
      if (token === null) return refused(c);
      let body: unknown;
      try { body = await c.req.json(); } catch { throw new ValidationFailed("Invalid request"); }
      const code = shopifyClaimCodeSchema.safeParse((body as { code?: unknown } | null)?.code);
      if (!code.success) return c.json({ outcome: "invalid_code" });
      return answer(c, await session(c).redeemClaim(token, code.data, c.var.signal));
    });
}
