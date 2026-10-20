import { Hono } from "hono";
import type { AppEnv } from "../app.js";

/** Billing reads (delivery.md D-4); the session requires the owner-only "billing" permission. */
export const billingRoutes = new Hono<AppEnv>()
  .get("/wallet", async (c) => c.json(await c.var.session.getWallet()));
