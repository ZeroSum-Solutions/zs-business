// The scheduled follow-up run (docs/requirements/agents.md G-13). One run lists the tenants whose
// agent may draft now, as the service role, and runs each one's slot as its agent principal,
// until none is left or starting another could outlast the time budget. Every switch and cap is
// checked again inside the agent's own actions (G-3..G-5). Before the tenants, it closes runs that
// stayed `running` past the stall limit (G-16). Time comes in as a dependency.
import {
  dueFollowUpTenants,
  scheduleSlot,
  stalledRuns,
  type FollowUpAgent,
} from "@zs/core";
import type { Transaction } from "@zs/db";

export interface ScheduledFollowUpSummary {
  readonly slot: string;
  readonly globalKilled: boolean;
  /** Tenants due when the run began. */
  readonly due: number;
  /** Tenants whose run for the slot this call reached the end of, whatever its outcome. */
  readonly finished: number;
  readonly drafted: number;
  readonly skipped: number;
  /** Tenant runs that ended on a stop reason (a switch, quiet hours or the daily cap). */
  readonly stopped: number;
  readonly errors: number;
  /** True when the budget ran out while tenants were still due. */
  readonly budgetSpent: boolean;
  /** G-16: runs this call closed because they stayed `running` past the stall limit. */
  readonly stalled: number;
}

export interface ScheduledFollowUpReport {
  readonly tenantId: string;
  readonly slot: string;
  readonly error: unknown;
}

export function createScheduledFollowUps(input: {
  /** A transaction as the service role, for the due-tenant read only. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly agent: Pick<FollowUpAgent, "runScheduled" | "stallRun">;
  readonly clock: { now(): Date };
  readonly slotMinutes: number;
  readonly budgetMs: number;
  /** G-16: close a run that has been `running` this long. */
  readonly stallAfterMs: number;
  /** The longest one tenant's run may take: its candidates times the model timeout. */
  readonly perTenantMs: number;
  readonly report?: (event: ScheduledFollowUpReport) => void;
}) {
  const { service, agent, clock, slotMinutes, budgetMs, perTenantMs, stallAfterMs } = input;
  return {
    async run(): Promise<ScheduledFollowUpSummary> {
      const startedAt = clock.now();
      const started = startedAt.getTime();
      const slot = scheduleSlot(startedAt, slotMinutes);
      const totals = { finished: 0, drafted: 0, skipped: 0, stopped: 0, errors: 0, budgetSpent: false, stalled: 0 };
      // G-16: close what stayed open first, so its late steps are refused and its counts are final.
      // Only the follow-up kind runs here; another kind's runs are closed by its own runner.
      for (const stuck of await service((tx) => stalledRuns(tx, startedAt, stallAfterMs))) {
        if (stuck.agentKind !== "inquiry_followup") continue;
        try {
          await agent.stallRun(stuck.tenantId, stuck.runId);
          totals.stalled += 1;
        } catch (error) {
          totals.errors += 1;
          input.report?.({ tenantId: stuck.tenantId, slot, error });
        }
      }
      const due = await service((tx) => dueFollowUpTenants(tx, startedAt, slot));
      for (const tenantId of due.tenantIds) {
        if (clock.now().getTime() - started + perTenantMs > budgetMs) {
          totals.budgetSpent = true;
          break;
        }
        try {
          const run = await agent.runScheduled(tenantId, slot);
          if (run.status === "running") continue;
          totals.finished += 1;
          totals.drafted += run.drafted;
          totals.skipped += run.skipped;
          if (run.stopReason) totals.stopped += 1;
        } catch (error) {
          // The run keeps what committed; the next call in the slot continues it.
          totals.errors += 1;
          input.report?.({ tenantId, slot, error });
        }
      }
      return { slot, globalKilled: due.globalKilled, due: due.tenantIds.length, ...totals };
    },
  };
}
export type ScheduledFollowUps = ReturnType<typeof createScheduledFollowUps>;
