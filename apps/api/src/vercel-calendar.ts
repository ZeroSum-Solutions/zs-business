// Vercel Node function for GET /cron/calendar (google-calendar.md G-6..G-10), bundled by
// scripts/build-vercel.mjs into its own function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service
// database login or the token private key. Like vercel.ts, it reads process.env and the system
// clock; one runner and one pool per instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { assertCalendarCronFits, parseCalendarEnv } from "./calendar/config.js";
import { startCalendarRunner } from "./calendar/start.js";
import { cronRoutes } from "./delivery/cron.js";
import { createStartupRecorder, guardCronEntry } from "./cron-startup.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "calendar",
  cronPath: "/cron/calendar",
  env: process.env,
  clock,
  recordStartupFailure: createStartupRecorder({ env: process.env, clock, databaseUrlVariable: "CALENDAR_DATABASE_URL" }),
  build: () => {
    const env = parseCalendarEnv(process.env);
    assertCalendarCronFits(env.runner);
    const started = env.runner === null ? null : startCalendarRunner(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return cronRoutes({
      path: "/cron/calendar",
      killSwitch: "CALENDAR_WORKER",
      name: "Calendar",
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.pool, clock, process.env) }),
      onError: (error) => console.error("Calendar run failed", error),
    }).fetch;
  },
}));
