// Vercel Node function for GET /cron/billing (stripe.md S-8), bundled by scripts/build-vercel.mjs
// into its own function, so the API function never holds the service database login. Like
// vercel.ts, it reads process.env and the system clock; one runner and one pool per instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { assertBillingCronFits, parseBillingEnv } from "./billing/config.js";
import { startBillingRunner } from "./billing/start.js";
import { cronRoutes } from "./delivery/cron.js";

const env = parseBillingEnv(process.env);
assertBillingCronFits(env.runner);
const clock = { now: () => new Date() };
const runner = env.runner === null ? null : startBillingRunner(env.runner, { clock, generateId: randomUUID }).runner;

export default getRequestListener(cronRoutes({
  path: "/cron/billing",
  killSwitch: "BILLING_WORKER",
  name: "Billing",
  cronSecret: env.cronSecret,
  runner,
  onError: (error) => console.error("Billing run failed", error),
}).fetch);
