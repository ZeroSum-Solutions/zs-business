// GET /cron/delivery: one delivery run per call (resend.md R-9). Vercel Cron calls it with
// `Authorization: Bearer <CRON_SECRET>`; anything else is 401 before any work. With the kill
// switch off it answers 200 without touching the database, so a scheduled call never alarms.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiErrorBody } from "@zs/core";
import type { DeliveryRunner } from "./runner.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function cronRoutes(config: {
  readonly cronSecret: string | null;
  /** Null when DELIVERY_WORKER is off. */
  readonly runner: DeliveryRunner | null;
  readonly onError?: (error: unknown) => void;
}) {
  const app = new Hono();
  app.get("/cron/delivery", async (c) => {
    if (config.cronSecret === null) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const given = c.req.header("authorization") ?? "";
    // Compare digests, so the comparison takes the same time whatever the length.
    if (!timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`)))
      return c.json(apiErrorBody("Unauthorized", "Invalid cron credentials"), 401);
    if (!config.runner) return c.json({ ran: false, reason: "DELIVERY_WORKER is off" }, 200);
    try {
      return c.json({ ran: true, ...(await config.runner.run()) }, 200);
    } catch (error) {
      // Leases and the outbox state make a failed run safe to repeat on the next schedule.
      config.onError?.(error);
      return c.json(apiErrorBody("Unavailable", "Delivery run failed"), 503);
    }
  });
  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  return app;
}
