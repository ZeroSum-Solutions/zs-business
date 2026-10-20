// Entry point: run the delivery worker as a long-lived Node process (resend.md R-9), for any host
// that is not Vercel Cron. It runs once every DELIVERY_INTERVAL_MS until SIGINT or SIGTERM, and
// finishes the run in progress before it exits. DELIVERY_WORKER=on is required; otherwise it
// exits at once. Run from apps/api: `pnpm delivery:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseDeliveryEnv } from "../delivery/config.js";
import { startDeliveryRunner } from "../delivery/start.js";

const env = parseDeliveryEnv(process.env);
if (env.runner === null) {
  console.log("DELIVERY_WORKER is off; nothing to run");
  process.exit(0);
}
const { runner, pool } = startDeliveryRunner(env.runner, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await runner.run();
    if (summary.claimed > 0 || summary.ingested > 0) console.log("Delivery run", summary);
  } catch (error) {
    console.error("Delivery run failed", error);
  }
  await sleep(env.runner.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await pool.end();
