// Entry point: run the image worker as a long-lived Node process (image-port.md IM-7, IM-11, IM-13).
// Each pass starts queued jobs, asks the vendor about unknown outcomes, promotes approved variants,
// expires and sweeps staging files, and settles the wallet, every IMAGE_INTERVAL_MS until SIGINT or
// SIGTERM, finishing the pass in progress. IMAGE_WORKER=on is required; otherwise it exits at once.
// Run from apps/api: `pnpm image:worker`.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseImageRunnerEnv } from "../images/config.js";
import { startImageWorker } from "../images/start.js";

const env = parseImageRunnerEnv(process.env);
if (env === null) {
  console.log("IMAGE_WORKER is off; nothing to run");
  process.exit(0);
}
const { worker, close } = await startImageWorker(env, { clock: { now: () => new Date() }, generateId: randomUUID });
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

while (!stop.signal.aborted) {
  try {
    const summary = await worker.runOnce();
    if (Object.values(summary).some((count) => count > 0)) console.log("Image run", summary);
  } catch (error) {
    console.error("Image run failed", error);
  }
  await sleep(env.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
}
await close();
