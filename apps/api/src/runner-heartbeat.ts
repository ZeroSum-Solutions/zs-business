// Runner heartbeats (plans.md PL-26, migration 20261120100000). A runner that finished a run writes one row,
// so the API, which cannot read the workers' deploy flags, can tell the plan page whether the follow-up agent,
// the templated agents and the delivery worker (email and SMS) are running. A runner that is off writes nothing,
// and its row goes stale. The write is one bounded statement on the runner's service pool; it never throws and
// never holds a cron past its budget. Time comes from the database (`clock_timestamp()`), the throttle from the
// injected clock.
import type { PlanRunner } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import { runFailure } from "./cron-outcome.js";
import type { ServiceRun } from "./cron-alerts.js";

export interface RunnerBeat {
  readonly runner: PlanRunner;
  /** How long this beat counts, in seconds: the runner states it so the reader needs no worker settings. */
  readonly freshForSeconds: number;
}

/** A beat is written at most this often per runner: a Node worker that loops every few seconds would otherwise rewrite the row each time. */
export const HEARTBEAT_MIN_GAP_MS = 60_000;
/** All the time one heartbeat write may take, whatever the database does. */
export const HEARTBEAT_CAP_MS = 2_000;
/** The delivery worker's window: its cron cadence is a build variable the worker cannot see, so the window is generous (README states it). */
export const DELIVERY_HEARTBEAT_SECONDS = 30 * 60;
/** The follow-up window: two slots, or two worker loops when those are longer, so one missed run does not flip the page. */
export const followUpHeartbeatSeconds = (slotMinutes: number, intervalMs: number) => Math.max(slotMinutes * 60 * 2, Math.ceil(intervalMs / 1000) * 2);

export interface RunnerHeartbeats {
  /** Records that these runners finished a run. Never throws. */
  beat(beats: readonly RunnerBeat[]): Promise<void>;
}

export function createRunnerHeartbeats(deps: {
  readonly service: ServiceRun;
  readonly clock: { now(): Date };
  readonly report?: (message: string, error: unknown) => void;
  readonly minGapMs?: number;
  readonly capMs?: number;
}): RunnerHeartbeats {
  const minGap = deps.minGapMs ?? HEARTBEAT_MIN_GAP_MS;
  const cap = deps.capMs ?? HEARTBEAT_CAP_MS;
  const last = new Map<PlanRunner, number>();
  return {
    async beat(beats) {
      const now = deps.clock.now().getTime();
      const due = beats.filter((entry) => now - (last.get(entry.runner) ?? Number.NEGATIVE_INFINITY) >= minGap);
      if (due.length === 0) return;
      // Claim the slot before the write starts: a second call for the same runner while this one is in flight finds
      // it not due, so one runner never has two writes pending. A failed write gives the claim back.
      const before = new Map(due.map((entry) => [entry.runner, last.get(entry.runner)] as const));
      for (const entry of due) last.set(entry.runner, now);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.service(async (tx: Transaction) => {
            await tx.query(`SET LOCAL statement_timeout = ${Math.max(100, cap - 100)}`);
            await tx.query(
              `INSERT INTO runner_heartbeats (runner, beat_at, fresh_for_seconds)
               SELECT t.runner, clock_timestamp(), t.fresh FROM unnest($1::text[], $2::int[]) AS t(runner, fresh)
               ON CONFLICT (runner) DO UPDATE SET
                 beat_at = GREATEST(runner_heartbeats.beat_at, EXCLUDED.beat_at), fresh_for_seconds = EXCLUDED.fresh_for_seconds`,
              [due.map((entry) => entry.runner), due.map((entry) => entry.freshForSeconds)]);
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("heartbeat write timed out")), cap); }),
        ]);
      } catch (error) {
        for (const [runner, previous] of before) { if (previous === undefined) last.delete(runner); else last.set(runner, previous); }
        // The run itself finished; a missing beat only makes the plan page say "not running" until the next one.
        try { (deps.report ?? ((message, problem) => console.error(message, problem)))("Runner heartbeat not recorded", error); } catch { /* the log is the last resort */ }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/**
 * A runner whose `run()` records a beat after each run that did not fail (a throw, or a run whose every work item
 * failed, is the cron alerts' business and is no sign of life: `runFailure`). `job` is the cron-outcome rule name.
 */
export function withHeartbeats<R extends { run(): Promise<object> }>(
  runner: R, input: { readonly job: "followup" | "delivery"; readonly heartbeats: RunnerHeartbeats; readonly beats: readonly RunnerBeat[] },
): R {
  return {
    ...runner,
    async run() {
      const summary = await runner.run();
      if (runFailure(input.job, summary) === null) await input.heartbeats.beat(input.beats);
      return summary;
    },
  };
}

/** The service pool as the heartbeat writer's transaction runner. */
export const serviceOnPool = (pool: Pool): ServiceRun => (work) => asService(pool, work);
