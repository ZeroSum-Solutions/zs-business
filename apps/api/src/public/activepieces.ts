// docs/requirements/activepieces.md W-9..W-13: the endpoint an Activepieces flow calls with its
// automation token. Anonymous to the owner auth: the token's tag is checked against the server key
// before any database work, then its row under the token's own tenant. A flow may propose an action
// (a pending approval an owner decides), read back its own proposals, and ask who it is. Nothing
// here reads customers or acts. Original code.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiErrorBody, createAutomationInbound, type AutomationKeySecrets, type AutomationPrincipal, type EdgeDependencies } from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "../routes/request.js";

export const ACTIVEPIECES_INBOUND_PREFIX = "/integrations/activepieces/v1";

export function activepiecesInboundRoutes(
  config: { readonly keySecrets: AutomationKeySecrets },
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  const inbound = (c: Context<AppEnv>) => createAutomationInbound(requestEdge(c), config);
  const principal = (c: Context<AppEnv>): Promise<AutomationPrincipal> => inbound(c).authenticate(c.req.header("Authorization"));
  return new Hono<AppEnv>()
    .use("*", bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .get("/me", async (c) => c.json(inbound(c).whoAmI(await principal(c))))
    .post("/proposals", async (c) => {
      const caller = await principal(c);
      return c.json(await inbound(c).propose(caller, await jsonBody(c), idempotencyKey(c)), 201);
    })
    .get("/proposals/:id", async (c) => {
      const caller = await principal(c);
      return c.json(await inbound(c).getProposal(caller, c.req.param("id")));
    });
}
