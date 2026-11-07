import { CONNECT_ATTEMPT_HEADER, CONNECT_GRANT_HEADER } from "@zs/contracts";
import type { createConnectionsSession } from "@zs/core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.js";
import { deferredJsonBody, idempotencyKey } from "./request.js";

/**
 * Managed-tier connections (docs/requirements/connections.md C-4, C-5, C-13), mounted at /v1/connections only
 * when the API has the connections config; without it every one of these is an unknown route (404). Each needs
 * the `integrations` permission. The attempt token and the staged grant travel in headers (the dashboard keeps
 * them in cookies), never in a URL, and nothing here may be cached. A body is read before the session runs but
 * judged after its permission check, so a caller without `integrations` gets 403 for any body (C-2).
 */
export function connectionsRoutes(session: (c: Context<AppEnv>) => ReturnType<typeof createConnectionsSession>) {
  const noStore = (c: Context<AppEnv>) => c.header("Cache-Control", "no-store");
  return new Hono<AppEnv>()
    // C-11: the list names the stores a business connected.
    .get("/", async (c) => {
      noStore(c);
      return c.json(await session(c).list());
    })
    // C-5: what the owner reviews before confirming the grant the callback staged.
    .get("/pending", async (c) => {
      noStore(c);
      return c.json(await session(c).pending(c.req.header(CONNECT_GRANT_HEADER)));
    })
    .post("/confirm", async (c) => {
      noStore(c);
      return c.json(await session(c).confirm(c.req.header(CONNECT_GRANT_HEADER), await deferredJsonBody(c)));
    })
    // C-5: cancels the attempt and has the worker delete its Composio account.
    .delete("/pending", async (c) => {
      noStore(c);
      // D-2: the staged grant names the attempt it came from and wins over the attempt cookie.
      return c.json(await session(c).cancel({ grant: c.req.header(CONNECT_GRANT_HEADER), attempt: c.req.header(CONNECT_ATTEMPT_HEADER) }, c.var.signal));
    })
    // C-4: the signed attempt token goes back in a header and never in the body.
    .post("/:toolkit/connect", async (c) => {
      const { authorizeUrl, attempt } = await session(c).start(c.req.param("toolkit"), await deferredJsonBody(c), c.var.signal);
      noStore(c);
      c.header(CONNECT_ATTEMPT_HEADER, attempt);
      return c.json({ authorizeUrl }, 200);
    })
    .post("/:id/disconnect", async (c) => {
      noStore(c);
      return c.json(await session(c).disconnect(c.req.param("id"), idempotencyKey(c), c.var.signal));
    });
}
