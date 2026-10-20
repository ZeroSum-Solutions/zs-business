// Entry point: run the scheduled follow-up agent as a long-lived Node process (agents.md G-13),
// for any host that is not Vercel Cron. It runs once every FOLLOWUP_INTERVAL_MS until SIGINT or
// SIGTERM, and finishes the run in progress before it exits. FOLLOWUP_AGENT=on is required;
// otherwise it exits at once. Run from apps/api: `pnpm followup:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseFollowUpEnv } from "../followup/config.js";
import { startFollowUpRunner } from "../followup/start.js";

const env = parseFollowUpEnv(process.env);
if (env.runner === null) {
  console.log("FOLLOWUP_AGENT is off; nothing to run");
  process.exit(0);
}
const { runner, close } = await startFollowUpRunner(env.runner, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await runner.run();
    if (summary.finished > 0 || summary.errors > 0 || summary.budgetSpent) console.log("Follow-up run", summary);
  } catch (error) {
    console.error("Follow-up run failed", error);
  }
  await sleep(env.runner.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await close();
