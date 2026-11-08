// GET /cron/activepieces: one webhook run per call (activepieces.md W-14). Vercel Cron calls it
// with `Authorization: Bearer <CRON_SECRET>`; anything else is 401 before any work. With the kill
// switch off it answers 200 without touching the database, so a scheduled call never alarms.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiErrorBody } from "@zs/core";
import { startCronRun, type CronAlerts } from "../cron-alerts.js";
import { CronRunFailed, runFailure } from "../cron-outcome.js";
import { responseHeaders } from "../response-headers.js";
import type { ActivepiecesRunner } from "./runner.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function activepiecesCronRoutes(config: {
  readonly cronSecret: string | null;
  /** Null when ACTIVEPIECES_WEBHOOK_WORKER is off. */
  readonly runner: ActivepiecesRunner | null;
  readonly onError?: (error: unknown) => void;
  /** Records a failed run as an alert and closes it on the next good run (cron-alerts.ts). */
  readonly alerts?: CronAlerts;
}) {
  const app = new Hono();
  app.use("*", responseHeaders);
  app.get("/cron/activepieces", async (c) => {
    if (config.cronSecret === null) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const given = c.req.header("authorization") ?? "";
    // Compare digests, so the comparison takes the same time whatever the length.
    if (!timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`)))
      return c.json(apiErrorBody("Unauthorized", "Invalid cron credentials"), 401);
    if (!config.runner) return c.json({ ran: false, reason: "ACTIVEPIECES_WEBHOOK_WORKER is off" }, 200);
    const run = startCronRun({ now: () => new Date() });
    let result: object;
    try {
      result = await config.runner.run();
    } catch (error) {
      // Leases and the ingest marks make a failed run safe to repeat on the next schedule.
      config.onError?.(error);
      await config.alerts?.failed("activepieces", error, run);
      return c.json(apiErrorBody("Unavailable", "Activepieces webhook run failed"), 503);
    }
    // A run whose deliveries all failed is a failure too, though it answers 200 (cron-outcome.ts).
    const failure = runFailure("activepieces", result);
    if (failure === null) await config.alerts?.succeeded("activepieces", run);
    else await config.alerts?.failed("activepieces", new CronRunFailed("activepieces", failure), run);
    return c.json({ ran: true, ...result }, 200);
  });
  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  return app;
}
