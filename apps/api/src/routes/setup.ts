import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// industry-templates.md IT-4, IT-6, IT-11. Any member reads the setup and the template previews;
// only owners (the `business` permission) apply a template or take its booking page live. The
// apply key is the server's own (`template:<id>`), so the route takes no Idempotency-Key.
export const setupRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.var.session.getSetup()))
  .post("/apply", async (c) => {
    const applied = await c.var.session.applyTemplate(await jsonBody(c));
    return c.json(applied, applied.replayed ? 200 : 201);
  })
  .post("/booking-pages/:id/published", async (c) =>
    c.json(await c.var.session.setBookingPagePublished(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
