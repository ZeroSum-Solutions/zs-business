// The scheduled follow-up run (docs/requirements/agents.md G-13). One run lists the tenants whose
// agent may draft now, as the service role, and runs each one's slot as its agent principal,
// until none is left or starting another could outlast the time budget. Every switch and cap is
// checked again inside the agent's own actions (G-3..G-5). Time comes in as a dependency.
import {
  dueFollowUpTenants,
  scheduleSlot,
  type FollowUpAgent,
  type FollowUpModel,
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
}

export interface ScheduledFollowUpReport {
  readonly tenantId: string;
  readonly slot: string;
  readonly error: unknown;
}

export function createScheduledFollowUps(input: {
  /** A transaction as the service role, for the due-tenant read only. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly agent: Pick<FollowUpAgent, "runScheduled">;
  readonly clock: { now(): Date };
  readonly slotMinutes: number;
  readonly budgetMs: number;
  /** The longest one tenant's run may take: its candidates times the model timeout. */
  readonly perTenantMs: number;
  readonly report?: (event: ScheduledFollowUpReport) => void;
}) {
  const { service, agent, clock, slotMinutes, budgetMs, perTenantMs } = input;
  return {
    async run(): Promise<ScheduledFollowUpSummary> {
      const startedAt = clock.now();
      const started = startedAt.getTime();
      const slot = scheduleSlot(startedAt, slotMinutes);
      const due = await service((tx) => dueFollowUpTenants(tx, startedAt, slot));
      const totals = { finished: 0, drafted: 0, skipped: 0, stopped: 0, errors: 0, budgetSpent: false };
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

/** Thrown in place of a draft the model did not return in time; the run records `model_error`. */
export class ModelTimedOut extends Error {
  constructor(ms: number) {
    super(`Model gave no draft within ${ms} ms`);
    this.name = "ModelTimedOut";
  }
}

/**
 * Bounds each model call, so one slow answer cannot hold a run past its budget. The port has no
 * abort signal (agents.md known limits), so a late answer is dropped, never used.
 */
export function withModelTimeout(model: FollowUpModel, ms: number): FollowUpModel {
  return {
    draft(prompt) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ModelTimedOut(ms)), ms); });
      return Promise.race([model.draft(prompt), late]).finally(() => clearTimeout(timer));
    },
  };
}
