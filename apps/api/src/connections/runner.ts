// The cron's runner: one bounded pass per call (docs/requirements/connections.md C-9). The pass bounds
// itself (20 seconds by default and never above 25, inside the function's 30; 200 Composio calls) and leases
// one row at a time for a minute (FOR UPDATE SKIP LOCKED in a short transaction, released by its holder), so
// a call cut short or two overlapping calls are safe.
import type { ConnectionsWorker } from "@zs/core";

export function createConnectionsRunner(worker: Pick<ConnectionsWorker, "pass">): { run(): Promise<object> } {
  return { run: () => worker.pass() };
}
