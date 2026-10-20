// Entry point: run the calendar worker as a long-lived Node process (google-calendar.md G-6), for
// any host that is not Vercel Cron. It runs once every CALENDAR_INTERVAL_MS until SIGINT or
// SIGTERM, and finishes the run in progress before it exits. CALENDAR_WORKER=on is required;
// otherwise it exits at once. Run from apps/api: `pnpm calendar:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseCalendarEnv } from "../calendar/config.js";
import { startCalendarRunner } from "../calendar/start.js";

const env = parseCalendarEnv(process.env);
if (env.runner === null) {
  console.log("CALENDAR_WORKER is off; nothing to run");
  process.exit(0);
}
const { runner, pool } = startCalendarRunner(env.runner, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await runner.run();
    if (Object.values(summary.counts).some((count) => count > 0)) console.log("Calendar run", summary);
  } catch (error) {
    console.error("Calendar run failed", error);
  }
  await sleep(env.runner.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await pool.end();
