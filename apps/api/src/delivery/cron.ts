// GET /cron/delivery: one delivery run per call (resend.md R-9); GET /cron/billing reuses it (stripe.md S-8). Vercel Cron calls it with
// `Authorization: Bearer <CRON_SECRET>`; anything else is 401 before any work. With the kill
// switch off it answers 200 without touching the database, so a scheduled call never alarms.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { apiErrorBody, PLAN_PRICE_ALERT_JOB } from "@zs/core";
import { startCronRun, type CronAlerts } from "../cron-alerts.js";
import { CronRunFailed, runFailure } from "../cron-outcome.js";
import { responseHeaders } from "../response-headers.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function cronRoutes(config: {
  readonly cronSecret: string | null;
  /** Null when the kill switch is off. */
  readonly runner: { run(): Promise<object> } | null;
  readonly onError?: (error: unknown) => void;
  /** Defaults to the delivery worker's route and switch. */
  readonly path?: string;
  readonly killSwitch?: string;
  readonly name?: string;
  /** Records a failed run as an alert and closes it on the next good run (cron-alerts.ts). */
  readonly alerts?: CronAlerts;
}) {
  const app = new Hono();
  app.use("*", responseHeaders);
  const path = config.path ?? "/cron/delivery";
  const job = path.replace(/^\/cron\//, "");
  const killSwitch = config.killSwitch ?? "DELIVERY_WORKER";
  const name = config.name ?? "Delivery";
  app.get(path, async (c) => {
    if (config.cronSecret === null) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const given = c.req.header("authorization") ?? "";
    // Compare digests, so the comparison takes the same time whatever the length.
    if (!timingSafeEqual(digest(given), digest(`Bearer ${config.cronSecret}`)))
      return c.json(apiErrorBody("Unauthorized", "Invalid cron credentials"), 401);
    if (!config.runner) return c.json({ ran: false, reason: `${killSwitch} is off` }, 200);
    const run = startCronRun({ now: () => new Date() });
    let result: object;
    try {
      result = await config.runner.run();
    } catch (error) {
      // Leases and the outbox state make a failed run safe to repeat on the next schedule.
      config.onError?.(error);
      await config.alerts?.failed(job, error, run);
      return c.json(apiErrorBody("Unavailable", `${name} run failed`), 503);
    }
    // PL-2: core wrote an unknown-price alert row; this run mails it once.
    if (job === "billing" && n((result as { outcomes?: Record<string, unknown> }).outcomes?.plan_held) > 0) await config.alerts?.notifyOpen(PLAN_PRICE_ALERT_JOB, run);
    // A run whose work items all failed is a failure too, though it answers 200 (cron-outcome.ts).
    const failure = runFailure(job, result);
    if (failure === null) await config.alerts?.succeeded(job, run);
    else await config.alerts?.failed(job, new CronRunFailed(job, failure), run);
    return c.json({ ran: true, ...result }, 200);
  });
  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  return app;
}

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
