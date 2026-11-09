// Vercel Node function for GET /cron/outreach (outreach-sequencer.md OS-13), bundled by scripts/build-vercel.mjs into its
// own function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service
// database login, the token private key or the send switch. Like vercel.ts, it reads process.env and the system clock;
// one runner and its pools per instance. There is no schedule unless the build sets OUTREACH_CRON_SCHEDULE, and
// OUTREACH_WORKER=on and OUTREACH_SEND_ENABLED=true are the run-time switches.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { cronRoutes } from "./delivery/cron.js";
import { createStartupAlerts, guardCronEntry } from "./cron-startup.js";
import { assertOutreachCronFits, parseOutreachEnv } from "./outreach/config.js";
import { startOutreachRunner } from "./outreach/start.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "outreach",
  cronPath: "/cron/outreach",
  env: process.env,
  clock,
  startupAlerts: createStartupAlerts({ env: process.env, clock, databaseUrlVariable: "OUTREACH_DATABASE_URL" }),
  build: async () => {
    const env = parseOutreachEnv(process.env);
    assertOutreachCronFits(env.runner);
    const started = env.runner === null ? null : await startOutreachRunner(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return { fetch: cronRoutes({
      path: "/cron/outreach",
      killSwitch: "OUTREACH_WORKER",
      name: "Outreach",
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.servicePool, clock, process.env) }),
      onError: (error) => console.error("Outreach run failed", error),
    }).fetch, disabled: runner === null };
  },
}));
