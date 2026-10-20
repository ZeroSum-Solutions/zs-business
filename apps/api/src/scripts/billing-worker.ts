// Entry point: run the billing worker as a long-lived Node process (stripe.md S-8), for any host
// that is not Vercel Cron. It runs once every BILLING_INTERVAL_MS until SIGINT or SIGTERM, and
// finishes the run in progress before it exits. BILLING_WORKER=on is required; otherwise it
// exits at once. Run from apps/api: `pnpm billing:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseBillingEnv } from "../billing/config.js";
import { startBillingRunner } from "../billing/start.js";

const env = parseBillingEnv(process.env);
if (env.runner === null) {
  console.log("BILLING_WORKER is off; nothing to run");
  process.exit(0);
}
const { runner, pool } = startBillingRunner(env.runner, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await runner.run();
    if (summary.claimed > 0) console.log("Billing run", summary);
  } catch (error) {
    console.error("Billing run failed", error);
  }
  await sleep(env.runner.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await pool.end();
