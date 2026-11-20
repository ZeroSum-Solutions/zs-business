// The document intake sweep as the cron route calls it (document-intake.md DL-16): one bounded run per call.
// `sweepFiles` deletes the stored PDF of each job that ended 30 days ago and marks the job, oldest first, so a
// repeated call finds nothing left to do (deleting a missing object succeeds). The run asks for a few jobs at a
// time and stops at `batch` jobs, when nothing is left, or when the time budget is spent, so a slow object store
// cannot carry it past the function's deadline. A delete that throws fails the run, which raises a cron alert, and
// the next call starts again at the same job. Two overlapping runs may both delete (and count) the same file.
export interface IntakeSweepSummary {
  /** Stored PDFs removed by this run. */
  readonly removed: number;
  /** The most jobs the run would look at. A `removed` equal to it, or `stopped: "budget"`, means more may be waiting. */
  readonly batch: number;
  /** Why the run ended: nothing left, the batch is full, or the time budget is spent. */
  readonly stopped: "empty" | "batch" | "budget";
}
export interface IntakeSweepRunner {
  run(): Promise<IntakeSweepSummary>;
}

/** Jobs asked of `sweepFiles` per call; the budget is checked between calls. */
export const SWEEP_CHUNK = 5;

export function createIntakeSweepRunner(deps: {
  readonly sweep: { sweepFiles(limit: number): Promise<number> };
  readonly batch: number;
  readonly budgetMs: number;
  readonly now: () => number;
}): IntakeSweepRunner {
  return {
    async run() {
      const started = deps.now();
      let removed = 0;
      for (;;) {
        if (removed >= deps.batch) return { removed, batch: deps.batch, stopped: "batch" };
        if (deps.now() - started >= deps.budgetMs) return { removed, batch: deps.batch, stopped: "budget" };
        const ask = Math.min(SWEEP_CHUNK, deps.batch - removed);
        const done = await deps.sweep.sweepFiles(ask);
        removed += done;
        if (done < ask) return { removed, batch: deps.batch, stopped: "empty" };
      }
    },
  };
}
