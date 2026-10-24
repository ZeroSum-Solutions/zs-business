// Entry point: run the enrichment worker as a long-lived Node process (enrichment.md E-3, E-15).
// It claims requests, calls Treg, purges expired results and checks the balance every
// ENRICHMENT_INTERVAL_MS until SIGINT or SIGTERM, finishing the run in progress. ENRICHMENT_WORKER=on
// is required; otherwise it exits at once. Run from apps/api: `pnpm enrichment:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnrichmentRunnerEnv } from "../enrichment/config.js";
import { startEnrichmentWorker } from "../enrichment/start.js";

const env = parseEnrichmentRunnerEnv(process.env);
if (env === null) {
  console.log("ENRICHMENT_WORKER is off; nothing to run");
  process.exit(0);
}
const { worker, pool } = startEnrichmentWorker(env, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const run = await worker.runOnce({ claimLimit: env.claimLimit });
    const purged = await worker.purgeExpired();
    if (run.claimed > 0 || purged > 0) console.log("Enrichment run", { claimed: run.claimed, purged });
  } catch (error) {
    console.error("Enrichment run failed", error);
  }
  await sleep(env.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await pool.end();
