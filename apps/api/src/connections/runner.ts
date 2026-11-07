// The cron's runner: one bounded pass per call (docs/requirements/connections.md C-9). The pass bounds
// itself (40 seconds, 200 Composio calls, set in the worker's config) and claims one row at a time with
// FOR UPDATE SKIP LOCKED, so a call cut short or two overlapping calls are safe.
import type { ConnectionsWorker } from "@zs/core";

export function createConnectionsRunner(worker: Pick<ConnectionsWorker, "pass">): { run(): Promise<object> } {
  return { run: () => worker.pass() };
}
