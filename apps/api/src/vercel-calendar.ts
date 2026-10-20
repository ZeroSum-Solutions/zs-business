// Vercel Node function for GET /cron/calendar (google-calendar.md G-6..G-10), bundled by
// scripts/build-vercel.mjs into its own function, so the API function never holds the service
// database login or the token private key. Like vercel.ts, it reads process.env and the system
// clock; one runner and one pool per instance.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { getRequestListener } from "@hono/node-server";
import { assertCalendarCronFits, parseCalendarEnv } from "./calendar/config.js";
import { startCalendarRunner } from "./calendar/start.js";
import { cronRoutes } from "./delivery/cron.js";

const env = parseCalendarEnv(process.env);
assertCalendarCronFits(env.runner);
const clock = { now: () => new Date() };
const runner = env.runner === null ? null : startCalendarRunner(env.runner, { clock, generateId: randomUUID }).runner;

export default getRequestListener(cronRoutes({
  path: "/cron/calendar",
  killSwitch: "CALENDAR_WORKER",
  name: "Calendar",
  cronSecret: env.cronSecret,
  runner,
  onError: (error) => console.error("Calendar run failed", error),
}).fetch);
