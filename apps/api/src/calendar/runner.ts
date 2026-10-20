// The process that runs the M5 calendar worker (docs/requirements/google-calendar.md G-6..G-10).
// One run makes worker passes until a pass moves nothing or the budget is spent; leases make a run
// cut short safe to pick up on the next schedule. Time, ids and the database come in as dependencies.
import { createCalendarWorker, type CalendarWorkerConfig, type CalendarWorkerReport, type GoogleClient } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";

/** What the runner needs of a worker: one pass, answering how many of each thing it did. */
export interface CalendarPassWorker {
  runOnce(): Promise<object>;
}

export interface CalendarRunSummary {
  readonly passes: number;
  /** Each count summed over the passes. */
  readonly counts: Record<string, number>;
  /** True when the budget ran out while passes were still moving work. */
  readonly budgetSpent: boolean;
}

export function createCalendarWorkerFromPool(deps: {
  /** A pool whose login may SET ROLE service_role. */
  readonly pool: Pool;
  readonly google: GoogleClient;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: CalendarWorkerConfig;
  readonly report?: (event: CalendarWorkerReport) => void;
}): CalendarPassWorker {
  return createCalendarWorker({
    service: <T>(work: (tx: Transaction) => Promise<T>) => asService(deps.pool, work),
    google: deps.google,
    clock: deps.clock,
    generateId: deps.generateId,
    config: deps.config,
    ...(deps.report ? { report: deps.report } : {}),
  });
}

/** The numeric fields of a pass; anything else a worker reports is ignored. */
const numericCounts = (pass: object): Array<[string, number]> =>
  Object.entries(pass).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));

export function createCalendarRunner(input: {
  readonly worker: CalendarPassWorker;
  readonly clock: { now(): Date };
  readonly budgetMs: number;
}) {
  const { worker, clock, budgetMs } = input;
  return {
    async run(): Promise<CalendarRunSummary> {
      const started = clock.now().getTime();
      const counts: Record<string, number> = {};
      let passes = 0;
      let budgetSpent = false;
      for (;;) {
        if (passes > 0 && clock.now().getTime() - started >= budgetMs) {
          budgetSpent = true;
          break;
        }
        const pass = numericCounts(await worker.runOnce());
        passes += 1;
        for (const [name, count] of pass) counts[name] = (counts[name] ?? 0) + count;
        // A pass that moved nothing means nothing more is due now.
        if (pass.every(([, count]) => count === 0)) break;
      }
      return { passes, counts, budgetSpent };
    },
  };
}
export type CalendarRunner = ReturnType<typeof createCalendarRunner>;
