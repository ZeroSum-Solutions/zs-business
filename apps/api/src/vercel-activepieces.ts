// Vercel Node function for GET /cron/activepieces, bundled by scripts/build-vercel.mjs into its own
// function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service database login. Like vercel.ts, it reads
// process.env and the system clock; one runner and one pool per function instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsOnPool } from "./cron-alerts.js";
import { assertActivepiecesCronFits, parseActivepiecesWorkerEnv } from "./activepieces/config.js";
import { activepiecesCronRoutes } from "./activepieces/cron.js";
import { startActivepiecesRunner } from "./activepieces/start.js";
import { createStartupRecorder, guardCronEntry } from "./cron-startup.js";

const clock = { now: () => new Date() };

// Built on the first request, not at module load, so a start-up failure raises a cron alert (cron-startup.ts).
export default getRequestListener(guardCronEntry({
  job: "activepieces",
  cronPath: "/cron/activepieces",
  env: process.env,
  clock,
  recordStartupFailure: createStartupRecorder({ env: process.env, clock, databaseUrlVariable: "ACTIVEPIECES_DATABASE_URL" }),
  build: () => {
    const env = parseActivepiecesWorkerEnv(process.env);
    assertActivepiecesCronFits(env.runner);
    const started = env.runner === null ? null : startActivepiecesRunner(env.runner, { clock, generateId: randomUUID });
    const runner = started?.runner ?? null;

    return activepiecesCronRoutes({
      cronSecret: env.cronSecret,
      runner,
      ...(started === null ? {} : { alerts: createCronAlertsOnPool(started.pool, clock, process.env) }),
      onError: (error) => console.error("Activepieces webhook run failed", error),
    }).fetch;
  },
}));
