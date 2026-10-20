// GET /cron/followup: one scheduled follow-up run per call (agents.md G-13). Vercel Cron calls it
// with `Authorization: Bearer <CRON_SECRET>`; anything else is 401 before any work. With
// FOLLOWUP_AGENT off it answers 200 without touching the database, so a scheduled call never alarms.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiErrorBody } from "@zs/core";
import type { ScheduledFollowUps } from "./runner.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function followUpCronRoutes(config: {
  readonly cronSecret: string | null;
  /** Null when FOLLOWUP_AGENT is off. */
  readonly runner: ScheduledFollowUps | null;
  readonly onError?: (error: unknown) => void;
}) {
  const app = new Hono();
  app.get("/cron/followup", async (c) => {
    if (config.cronSecret === null) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const given = c.req.header("authorization") ?? "";
    // Compare digests, so the comparison takes the same time whatever the length.
    if (!timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`)))
      return c.json(apiErrorBody("Unauthorized", "Invalid cron credentials"), 401);
    if (!config.runner) return c.json({ ran: false, reason: "FOLLOWUP_AGENT is off" }, 200);
    try {
      return c.json({ ran: true, ...(await config.runner.run()) }, 200);
    } catch (error) {
      // Each tenant's run keeps what committed; the next call in the slot continues it.
      config.onError?.(error);
      return c.json(apiErrorBody("Unavailable", "Follow-up run failed"), 503);
    }
  });
  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  return app;
}
