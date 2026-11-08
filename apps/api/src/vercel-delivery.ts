// Vercel Node function for GET /cron/delivery, bundled by scripts/build-vercel.mjs into its own
// function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service database login. Like vercel.ts, it
// reads process.env and the system clock; one runner and one pool per function instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { assertDeliveryCronFits, parseDeliveryEnv } from "./delivery/config.js";
import { cronRoutes } from "./delivery/cron.js";
import { startDeliveryRunner } from "./delivery/start.js";
import { createStartupRecorder, guardCronEntry } from "./cron-startup.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "delivery",
  cronPath: "/cron/delivery",
  env: process.env,
  clock,
  recordStartupFailure: createStartupRecorder({ env: process.env, clock, databaseUrlVariable: "DELIVERY_DATABASE_URL" }),
  build: () => {
    const env = parseDeliveryEnv(process.env);
    assertDeliveryCronFits(env.runner);
    const started = env.runner === null ? null : startDeliveryRunner(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return cronRoutes({
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.pool, clock, process.env) }),
      onError: (error) => console.error("Delivery run failed", error),
    }).fetch;
  },
}));
