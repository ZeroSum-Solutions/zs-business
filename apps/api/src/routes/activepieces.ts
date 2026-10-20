import { Hono, type Context } from "hono";
import { createAutomationAdmin, type AutomationEdgeConfig, type EdgeDependencies } from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// activepieces.md W-1, W-2, W-5, W-9: an owner's webhook endpoints, their deliveries and the
// automation tokens a flow uses. Every route needs the `integrations` permission (owners).
export function activepiecesRoutes(config: AutomationEdgeConfig, requestEdge: (c: Context<AppEnv>) => EdgeDependencies) {
  const admin = (c: Context<AppEnv>) => createAutomationAdmin(requestEdge(c), config, c.var.session.principal);
  // Signing secrets and tokens appear in a few of these replies; no cache may keep any of them.
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .get("/webhooks", async (c) => c.json(await admin(c).listEndpoints()))
    .post("/webhooks", async (c) =>
      c.json(await admin(c).createEndpoint(await jsonBody(c), idempotencyKey(c)), 201))
    .post("/webhooks/:id/update", async (c) =>
      c.json(await admin(c).updateEndpoint(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
    .post("/webhooks/:id/rotate", async (c) =>
      c.json(await admin(c).rotateEndpointSecret(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
    .get("/webhooks/:id/deliveries", async (c) => c.json(await admin(c).listDeliveries(c.req.param("id"), c.req.query())))
    .post("/deliveries/:id/replay", async (c) =>
      c.json(await admin(c).replayDelivery(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
    .get("/tokens", async (c) => c.json(await admin(c).listTokens()))
    .post("/tokens", async (c) =>
      c.json(await admin(c).createToken(await jsonBody(c), idempotencyKey(c)), 201))
    .post("/tokens/:id/revoke", async (c) =>
      c.json(await admin(c).revokeToken(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
}
