// Cron failure alerts: a failed scheduled run leaves a visible row in `cron_alerts` (migration
// 20261108300000), so nobody has to read Vercel logs to learn a job stopped. One row per job:
// a repeat failure raises the counter on the open row, the next good run closes it, a later
// failure opens it again. The recorder never throws: an alert that cannot be written (the database
// is the very thing that failed) is reported to the operator log and the cron answers as before.
import { asService, createRuntimePool, type Transaction } from "@zs/db";
import type { Pool } from "pg";

/** Runs `work` in one service-role transaction. */
export type ServiceRun = <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;

export interface CronAlerts {
  /** The run of `job` failed. Opens the alert, or raises the count on the open one. */
  failed(job: string, error: unknown): Promise<void>;
  /** The run of `job` finished. Closes the job's open alert, if any. */
  succeeded(job: string): Promise<void>;
}

export interface OpenCronAlert {
  readonly job: string;
  readonly openedAt: string;
  readonly lastFailedAt: string;
  readonly failureCount: number;
  readonly lastError: string;
}

const MAX_ERROR_LENGTH = 500;

/**
 * What the table keeps of an error: its class and message, with URLs, credentials and key-shaped
 * tokens replaced, cut to 500 characters. Never the stack.
 */
export function describeCronError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const text = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b(?:sk|rk|pk|whsec|ghp)_[A-Za-z0-9_]{8,}/g, "<secret>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <secret>")
    .replace(/\s+/g, " ")
    .trim();
  return (text === "" ? "unknown error" : text).slice(0, MAX_ERROR_LENGTH);
}

export function createCronAlerts(deps: {
  readonly service: ServiceRun;
  readonly clock: { now(): Date };
  /** The operator log, for an alert that could not be written. */
  readonly report?: (message: string, error: unknown) => void;
}): CronAlerts {
  const report = deps.report ?? ((message, error) => console.error(message, error));
  return {
    async failed(job, error) {
      const at = deps.clock.now().toISOString();
      try {
        await deps.service((tx) => tx.query(
          `INSERT INTO cron_alerts (job, opened_at, last_failed_at, failure_count, last_error)
           VALUES ($1, $2, $2, 1, $3)
           ON CONFLICT (job) DO UPDATE SET
             opened_at = CASE WHEN cron_alerts.resolved_at IS NULL THEN cron_alerts.opened_at ELSE EXCLUDED.opened_at END,
             failure_count = CASE WHEN cron_alerts.resolved_at IS NULL THEN cron_alerts.failure_count + 1 ELSE 1 END,
             last_failed_at = EXCLUDED.last_failed_at,
             last_error = EXCLUDED.last_error,
             resolved_at = NULL`,
          [job, at, describeCronError(error)],
        ));
      } catch (writeError) {
        report(`Cron alert for ${job} not recorded`, writeError);
      }
    },
    async succeeded(job) {
      try {
        await deps.service((tx) => tx.query(
          "UPDATE cron_alerts SET resolved_at = $2 WHERE job = $1 AND resolved_at IS NULL",
          [job, deps.clock.now().toISOString()],
        ));
      } catch (writeError) {
        report(`Cron alert for ${job} not cleared`, writeError);
      }
    },
  };
}

/**
 * The alerts for one cron function, over its own service login. The pool opens on first use, so a
 * run that never fails and never ends costs no connection beyond the one the runner holds.
 */
export function createCronAlertsForEnv(
  env: { readonly serviceDatabaseUrl: string; readonly databaseCaCert: string | undefined },
  clock: { now(): Date },
): CronAlerts {
  let pool: Pool | null = null;
  const service: ServiceRun = (work) => {
    pool ??= createRuntimePool({
      connectionString: env.serviceDatabaseUrl,
      max: 1,
      applicationName: "zs-cron-alerts",
      ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
      onError: (summary) => console.error("Cron alerts pool error", summary),
    });
    return asService(pool, work);
  };
  return createCronAlerts({ service, clock });
}

/** The jobs that are failing now, newest failure first. */
export async function listOpenCronAlerts(service: ServiceRun): Promise<OpenCronAlert[]> {
  const result = await service((tx) => tx.query<{
    job: string; opened_at: Date; last_failed_at: Date; failure_count: number; last_error: string;
  }>("SELECT job, opened_at, last_failed_at, failure_count, last_error FROM cron_alerts WHERE resolved_at IS NULL ORDER BY last_failed_at DESC"));
  return result.rows.map((row) => ({
    job: row.job,
    openedAt: row.opened_at.toISOString(),
    lastFailedAt: row.last_failed_at.toISOString(),
    failureCount: row.failure_count,
    lastError: row.last_error,
  }));
}
