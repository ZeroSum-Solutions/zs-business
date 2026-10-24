// BT-7: one pass of the runner loop: claim a job, run the browser against it through the hooks, report.
// The hooks are the only way the runner touches the system (the service in service.ts).
import type { BrowserClaim, BrowserFinishInput, BrowserRun } from "@zs/contracts";
import type { BrowserRunner } from "./port.js";
import { profilePath } from "./profile.js";
import type { BrowserRunnerService } from "./service.js";

export interface BrowserJobDeps {
  readonly service: BrowserRunnerService;
  readonly runner: BrowserRunner;
  /** BT-6: the absolute directory that holds every profile. */
  readonly browserRoot: string;
  readonly signal?: AbortSignal;
}

export async function runBrowserJob(deps: BrowserJobDeps): Promise<{ claim: BrowserClaim; run: BrowserRun } | null> {
  const claim = await deps.service.claim();
  if (!claim) return null;
  const lease = { runId: claim.runId, token: claim.leaseToken };
  let finish: BrowserFinishInput;
  try {
    const outcome = await deps.runner.plan({
      claim,
      profileDir: profilePath(deps.browserRoot, claim.tenantId, claim.targetId),
      hooks: {
        beforeStep: async () => (await deps.service.control(lease)).stop,
        recordStep: (input) => deps.service.appendEvent(lease, input),
        saveArtifact: (input) => deps.service.putArtifact(lease, input),
      },
    }, deps.signal);
    finish = outcome.outcome === "read_done" ? { outcome: "read_done" }
      : outcome.outcome === "stopped" ? { outcome: "stopped", reason: outcome.reason }
        : { outcome: "stopped", reason: "runner_error" };
  } catch {
    // The runner crashed or the planner was cut off. The run is closed with a reason, never left running.
    finish = { outcome: "stopped", reason: "runner_error" };
  }
  return { claim, run: await deps.service.finish(lease, finish) };
}
