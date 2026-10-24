// BT-1: browser work runs only through `BrowserRunner`. `plan` drives the browser with a model and
// stops before any submit; `execute` submits an approved form with no model. In this revision
// `execute` is refused (BT-11).
import {
  Conflict,
  type BrowserClaim,
  type BrowserEventInput,
  type BrowserStopReason,
} from "@zs/contracts";

/** What the runner may do while it plans: ask whether to stop, record a step, store a file (BT-7). */
export interface BrowserHooks {
  /** BT-12: read before every step; a reason means stop now. */
  beforeStep(): Promise<BrowserStopReason | null>;
  /** BT-9: record one step. `stop` is set when the server closed the run on this step (a cap). */
  recordStep(input: BrowserEventInput): Promise<{ readonly seq: number; readonly stop: BrowserStopReason | null }>;
  /** BT-13: store a downloaded PDF, or an audit screenshot (BT-10). */
  saveArtifact(input: { readonly kind: "invoice_pdf" | "screenshot"; readonly name: string; readonly bytes: Uint8Array }):
    Promise<{ readonly id: string; readonly duplicate: boolean }>;
}

export interface BrowserPlanCommand {
  readonly claim: BrowserClaim;
  /** BT-6: the profile directory, built from the claim's tenant and target. */
  readonly profileDir: string;
  readonly hooks: BrowserHooks;
}
export type BrowserPlanOutcome =
  | { readonly outcome: "read_done"; readonly steps: number; readonly artifacts: number }
  /** BT-11: specified, never produced in this revision. */
  | { readonly outcome: "submit_ready" }
  | { readonly outcome: "stopped"; readonly reason: BrowserStopReason; readonly steps: number };

export interface BrowserExecuteCommand {
  readonly runId: string;
  readonly approvalId: string;
}
export interface BrowserRunner {
  plan(command: BrowserPlanCommand, signal?: AbortSignal): Promise<BrowserPlanOutcome>;
  execute(command: BrowserExecuteCommand, signal?: AbortSignal): Promise<never>;
}

/** BT-11: every runner's `execute`. */
export function refuseWriteTasks(): never {
  throw new Conflict("Write tasks are disabled", { reason: "write_tasks_disabled" });
}
