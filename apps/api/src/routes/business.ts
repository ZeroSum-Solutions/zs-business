import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// business-profile.md BP-5..BP-7: who the business is. Any member reads it; only owners (the
// `business` permission) change it, compare-and-set on the revision, with an idempotency key.
export const businessRoutes = new Hono<AppEnv>()
  .get("/business", async (c) => c.json(await c.var.session.getBusiness()))
  .put("/business", async (c) => c.json(await c.var.session.updateBusiness(await jsonBody(c), idempotencyKey(c))));
