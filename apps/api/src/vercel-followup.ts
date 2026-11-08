// Vercel Node function for GET /cron/followup, bundled by scripts/build-vercel.mjs into its own
// function, in the workers Vercel project (`pnpm build:vercel:worker`), so the API project never holds the service database login. Like vercel.ts, it
// reads process.env and the system clock; one runner and its pools per function instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { createCronAlertsForEnv } from "./cron-alerts.js";
import { parseFollowUpEnv } from "./followup/config.js";
import { followUpCronRoutes } from "./followup/cron.js";
import { startFollowUpRunner } from "./followup/start.js";

const env = parseFollowUpEnv(process.env);
const clock = { now: () => new Date() };
const runner = env.runner === null ? null : (await startFollowUpRunner(env.runner, { clock, generateId: randomUUID })).runner;

export default getRequestListener(followUpCronRoutes({
  cronSecret: env.cronSecret,
  runner,
  ...(env.runner === null ? {} : { alerts: createCronAlertsForEnv(env.runner, clock) }),
  onError: (error) => console.error("Follow-up run failed", error),
}).fetch);
