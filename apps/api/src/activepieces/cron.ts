// GET /cron/activepieces: one webhook run per call (activepieces.md W-14). Vercel Cron calls it
// with `Authorization: Bearer <CRON_SECRET>`; anything else is 401 before any work. With the kill
// switch off it answers 200 without touching the database, so a scheduled call never alarms.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiErrorBody } from "@zs/core";
import type { ActivepiecesRunner } from "./runner.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function activepiecesCronRoutes(config: {
  readonly cronSecret: string | null;
  /** Null when ACTIVEPIECES_WEBHOOK_WORKER is off. */
  readonly runner: ActivepiecesRunner | null;
  readonly onError?: (error: unknown) => void;
}) {
  const app = new Hono();
  app.get("/cron/activepieces", async (c) => {
    if (config.cronSecret === null) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const given = c.req.header("authorization") ?? "";
    // Compare digests, so the comparison takes the same time whatever the length.
    if (!timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`)))
      return c.json(apiErrorBody("Unauthorized", "Invalid cron credentials"), 401);
    if (!config.runner) return c.json({ ran: false, reason: "ACTIVEPIECES_WEBHOOK_WORKER is off" }, 200);
    try {
      return c.json({ ran: true, ...(await config.runner.run()) }, 200);
    } catch (error) {
      // Leases and the ingest marks make a failed run safe to repeat on the next schedule.
      config.onError?.(error);
      return c.json(apiErrorBody("Unavailable", "Activepieces webhook run failed"), 503);
    }
  });
  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  return app;
}
