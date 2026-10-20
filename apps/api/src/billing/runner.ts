// The process that runs the M5 billing worker (docs/requirements/stripe.md S-8). One run applies
// stored Stripe events in passes until a pass claims fewer than the limit or the budget is spent.
// Time, ids and the database come in as dependencies.
import { createBillingWorker, type BillingWorker } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";

export interface BillingRunSummary {
  readonly passes: number;
  readonly claimed: number;
  readonly outcomes: Record<string, number>;
  /** True when the budget ran out while events were still due. */
  readonly budgetSpent: boolean;
}

export function createBillingWorkerFromPool(deps: {
  /** A pool whose login may SET ROLE service_role. */
  readonly pool: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly report?: (event: { readonly eventId: string; readonly type: string; readonly outcome: string }) => void;
}): BillingWorker {
  return createBillingWorker({
    service: <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.pool, work),
    clock: deps.clock,
    generateId: deps.generateId,
    ...(deps.report ? { report: deps.report } : {}),
  });
}

export function createBillingRunner(input: {
  readonly worker: BillingWorker;
  readonly clock: { now(): Date };
  readonly budgetMs: number;
  readonly claimLimit: number;
}) {
  const { worker, clock, budgetMs, claimLimit } = input;
  return {
    async run(): Promise<BillingRunSummary> {
      const started = clock.now().getTime();
      const outcomes: Record<string, number> = {};
      let passes = 0;
      let claimed = 0;
      let budgetSpent = false;
      for (;;) {
        if (passes > 0 && clock.now().getTime() - started >= budgetMs) {
          budgetSpent = true;
          break;
        }
        const pass = await worker.runOnce(claimLimit);
        passes += 1;
        claimed += pass.claimed;
        for (const [outcome, count] of Object.entries(pass.outcomes)) outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
        if (pass.claimed < claimLimit) break;
      }
      return { passes, claimed, outcomes, budgetSpent };
    },
  };
}
export type BillingRunner = ReturnType<typeof createBillingRunner>;
