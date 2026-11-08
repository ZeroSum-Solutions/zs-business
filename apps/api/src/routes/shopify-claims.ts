import type { createShopifyClaimsSession } from "@zs/core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.js";

/**
 * docs/requirements/connections.md C-22: an existing hub owner links the hub to an installed store. Mounted at
 * /v1/shopify/claims only when the API has the Shopify port (otherwise 404). Owners only; nothing here is cached.
 *   POST   /            starts a claim: returns the one-time code (shown once) and its expiry
 *   GET    /current     the open claim, or null
 *   POST   /:id/confirm binds the store the merchant redeemed the code from
 *   DELETE /:id         cancels
 */
export function shopifyClaimsRoutes(session: (c: Context<AppEnv>) => ReturnType<typeof createShopifyClaimsSession>) {
  const noStore = (c: Context<AppEnv>) => c.header("Cache-Control", "no-store");
  return new Hono<AppEnv>()
    .post("/", async (c) => {
      noStore(c);
      return c.json(await session(c).start(c.var.signal), 201);
    })
    .get("/current", async (c) => {
      noStore(c);
      return c.json(await session(c).status(c.var.signal));
    })
    .post("/:id/confirm", async (c) => {
      noStore(c);
      return c.json(await session(c).confirm(c.req.param("id"), c.var.signal));
    })
    .delete("/:id", async (c) => {
      noStore(c);
      return c.json(await session(c).cancel(c.req.param("id"), c.var.signal));
    });
}
