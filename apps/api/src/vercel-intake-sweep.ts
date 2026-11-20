// Vercel Node function for GET /cron/intake-sweep (document-intake.md DL-16), bundled by scripts/build-vercel.mjs into
// its own function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the R2
// keys or the service database login. Like vercel.ts, it reads process.env and the system clock; one runner and its
// pools per instance. There is no schedule unless the build sets INTAKE_SWEEP_CRON_SCHEDULE, and INTAKE_SWEEP_WORKER=on
// is the run-time switch.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { cronRoutes } from "./delivery/cron.js";
import { createStartupAlerts, guardCronEntry } from "./cron-startup.js";
import { parseIntakeSweepEnv } from "./intake-sweep/config.js";
import { startIntakeSweep } from "./intake-sweep/start.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "intake-sweep",
  cronPath: "/cron/intake-sweep",
  env: process.env,
  clock,
  startupAlerts: createStartupAlerts({ env: process.env, clock, databaseUrlVariable: "INTAKE_SWEEP_SERVICE_DATABASE_URL" }),
  build: async () => {
    const env = parseIntakeSweepEnv(process.env);
    const started = env.runner === null ? null : await startIntakeSweep(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return { fetch: cronRoutes({
      path: "/cron/intake-sweep",
      killSwitch: "INTAKE_SWEEP_WORKER",
      name: "Intake sweep",
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.servicePool, clock, process.env) }),
      onError: (error) => console.error("Intake sweep run failed", error),
    }).fetch, disabled: runner === null };
  },
}));
