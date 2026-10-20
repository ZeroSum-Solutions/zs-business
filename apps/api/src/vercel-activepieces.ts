// Vercel Node function for GET /cron/activepieces, bundled by scripts/build-vercel.mjs into its own
// function, so the API function never holds the service database login. Like vercel.ts, it reads
// process.env and the system clock; one runner and one pool per function instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { parseActivepiecesWorkerEnv } from "./activepieces/config.js";
import { activepiecesCronRoutes } from "./activepieces/cron.js";
import { startActivepiecesRunner } from "./activepieces/start.js";

const env = parseActivepiecesWorkerEnv(process.env);
const clock = { now: () => new Date() };
const runner = env.runner === null ? null : startActivepiecesRunner(env.runner, { clock, generateId: randomUUID }).runner;

export default getRequestListener(activepiecesCronRoutes({
  cronSecret: env.cronSecret,
  runner,
  onError: (error) => console.error("Activepieces webhook run failed", error),
}).fetch);
