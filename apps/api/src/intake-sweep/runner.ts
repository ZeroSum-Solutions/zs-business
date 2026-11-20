// The document intake sweep as the cron route calls it (document-intake.md DL-16): one bounded batch per call.
// `sweepFiles` deletes the stored PDF of each job that ended 30 days ago and marks the job, oldest first, so a
// repeated or overlapping call finds nothing left to do (deleting a missing object succeeds). A delete that throws
// fails the run, which raises a cron alert, and the next call starts again at the same job.
export interface IntakeSweepSummary {
  /** Stored PDFs removed by this run. */
  readonly removed: number;
  /** The most jobs the run looked at. A `removed` equal to it means more may be waiting for the next call. */
  readonly batch: number;
}
export interface IntakeSweepRunner {
  run(): Promise<IntakeSweepSummary>;
}

export function createIntakeSweepRunner(deps: {
  readonly sweep: { sweepFiles(limit: number): Promise<number> };
  readonly batch: number;
}): IntakeSweepRunner {
  return { run: async () => ({ removed: await deps.sweep.sweepFiles(deps.batch), batch: deps.batch }) };
}
