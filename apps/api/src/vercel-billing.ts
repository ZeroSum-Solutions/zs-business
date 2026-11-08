// Vercel Node function for GET /cron/billing (stripe.md S-8), bundled by scripts/build-vercel.mjs
// into its own function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service database login. Like
// vercel.ts, it reads process.env and the system clock; one runner and one pool per instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { assertBillingCronFits, parseBillingEnv } from "./billing/config.js";
import { startBillingRunner } from "./billing/start.js";
import { cronRoutes } from "./delivery/cron.js";
import { createStartupRecorder, guardCronEntry } from "./cron-startup.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "billing",
  cronPath: "/cron/billing",
  env: process.env,
  clock,
  recordStartupFailure: createStartupRecorder({ env: process.env, clock, databaseUrlVariable: "BILLING_DATABASE_URL" }),
  build: () => {
    const env = parseBillingEnv(process.env);
    assertBillingCronFits(env.runner);
    const started = env.runner === null ? null : startBillingRunner(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return cronRoutes({
      path: "/cron/billing",
      killSwitch: "BILLING_WORKER",
      name: "Billing",
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.pool, clock, process.env) }),
      onError: (error) => console.error("Billing run failed", error),
    }).fetch;
  },
}));
