// Entry point: run the Activepieces webhook worker as a long-lived Node process (activepieces.md
// W-14), for any host that is not Vercel Cron. It runs once every ACTIVEPIECES_INTERVAL_MS until
// SIGINT or SIGTERM, and finishes the run in progress before it exits.
// ACTIVEPIECES_WEBHOOK_WORKER=on is required; otherwise it exits at once. Run from apps/api:
// `pnpm activepieces:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseActivepiecesWorkerEnv } from "../activepieces/config.js";
import { startActivepiecesRunner } from "../activepieces/start.js";

const env = parseActivepiecesWorkerEnv(process.env);
if (env.runner === null) {
  console.log("ACTIVEPIECES_WEBHOOK_WORKER is off; nothing to run");
  process.exit(0);
}
const { runner, pool } = startActivepiecesRunner(env.runner, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await runner.run();
    if (summary.claimed > 0 || summary.ingested > 0) console.log("Activepieces webhook run", summary);
  } catch (error) {
    console.error("Activepieces webhook run failed", error);
  }
  await sleep(env.runner.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await pool.end();
