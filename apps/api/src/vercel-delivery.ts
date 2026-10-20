// Vercel Node function for GET /cron/delivery, bundled by scripts/build-vercel.mjs into its own
// function, so the API function never holds the service database login. Like vercel.ts, it
// reads process.env and the system clock; one runner and one pool per function instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { parseDeliveryEnv } from "./delivery/config.js";
import { cronRoutes } from "./delivery/cron.js";
import { startDeliveryRunner } from "./delivery/start.js";

const env = parseDeliveryEnv(process.env);
const clock = { now: () => new Date() };
const runner = env.runner === null ? null : startDeliveryRunner(env.runner, { clock, generateId: randomUUID }).runner;

export default getRequestListener(cronRoutes({
  cronSecret: env.cronSecret,
  runner,
  onError: (error) => console.error("Delivery run failed", error),
}).fetch);
