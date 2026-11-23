import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

/** Billing (delivery.md D-4, stripe.md S-1); the session requires the owner-only "billing" permission. */
export const billingRoutes = new Hono<AppEnv>()
  .get("/wallet", async (c) => c.json(await c.var.session.getWallet()))
  .get("/wallet/top-ups", async (c) => c.json(await c.var.session.listTopUps()))
  .post("/wallet/top-ups", async (c) =>
    c.json(await c.var.session.createTopUp(await jsonBody(c), idempotencyKey(c), c.var.signal), 201))
  // plans.md PL-4..PL-7: the Hub plan, its Checkout and the Stripe Billing Portal.
  // PL-26: `?features=1` adds the plan page's feature lists; a caller that does not ask gets the answer it always had.
  // PL-27: `&free=1` adds `freeTier` (with `features`), for the same reason.
  .get("/billing/plan", async (c) => c.json(await c.var.session.getBillingPlan({
    features: c.req.query("features") === "1", freeTier: c.req.query("free") === "1",
  })))
  .post("/billing/plan/checkout", async (c) =>
    c.json(await c.var.session.startPlanCheckout(await jsonBody(c), idempotencyKey(c), c.var.signal), 201))
  .post("/billing/portal", async (c) => c.json(await c.var.session.openBillingPortal(c.var.signal)));
