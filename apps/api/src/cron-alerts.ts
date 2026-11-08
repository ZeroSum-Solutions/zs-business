// Cron failure alerts: a failed scheduled run leaves a visible row in `cron_alerts` (migration
// 20261108400000), so nobody has to read Vercel logs to learn a job stopped. One row per job:
// a repeat failure raises the counter on the open row, a good run closes it, a later failure opens it
// again. The recorder never throws and never delays the cron past its budget: all alert work (the
// database write and the email) shares one deadline, the smaller of ALERT_CAP_MS and what is left of
// the function's time. An alert that cannot be written (the database is the very thing that failed) is
// reported to the operator log and the cron answers as before.
//
// Time comes from the database (`clock_timestamp()`), not the function's clock, so overlapping runs and
// clock skew cannot order a row's times wrongly. The email goes out while an open alert has no
// `notified_at`, on any later failure too, and `notified_at` is set only after the provider took it, so a
// failed send is retried by the next failing run. The send's idempotency key is job + opened_at, so a
// retry after a lost answer cannot mail twice.
import { asService, type Transaction } from "@zs/db";
import type { Pool } from "pg";
import { createOpsAlertMailer, type CronAlertNotifier } from "./cron-alert-mail.js";

/** Runs `work` in one service-role transaction. */
export type ServiceRun = <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;

/** A cron function's own clock: when its run began, for the stale-success check and the time left. */
export interface CronRun {
  readonly startedAt: Date;
  /** Monotonic milliseconds at the start (performance.now()). */
  readonly startedMonotonicMs: number;
}

export interface CronAlerts {
  /** The run of `job` failed. Opens the alert, or raises the count on the open one. Never throws. */
  failed(job: string, error: unknown, run?: CronRun): Promise<void>;
  /**
   * The run of `job` finished well. Closes the job's open alert unless a failure newer than the start of
   * `run` is on it (a stale success must not resolve a newer failure). One statement. Never throws.
   */
  succeeded(job: string, run?: CronRun): Promise<void>;
}

export interface OpenCronAlert {
  readonly job: string;
  readonly openedAt: string;
  readonly lastFailedAt: string;
  readonly failureCount: number;
  readonly lastError: string;
}

const MAX_ERROR_LENGTH = 500;
/** All alert work of one call, database and email together. */
export const ALERT_CAP_MS = 3_000;
/** A cron function lives 30 s on Vercel; the alert work leaves this much of it for the answer. */
export const FUNCTION_MS = 30_000;
export const ANSWER_RESERVE_MS = 1_500;
/** Below this the email is not started; the next failing run sends it. */
const MIN_SEND_MS = 400;

/** Starts timing one cron run. */
export const startCronRun = (clock: { now(): Date }): CronRun => ({ startedAt: clock.now(), startedMonotonicMs: performance.now() });

/** What the table keeps of an error: replacements for URLs, credentials and addresses, in this order. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
  [/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{2,}){1,2}/g, "<jwt>"],
  [/\bBearer\s+\S+/gi, "Bearer <secret>"],
  [/\b(?:sk|rk|pk|whsec|ghp|re|shpat|shpca|shpss|sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/g, "<secret>"],
  [/\b(?:sk|csk)-[A-Za-z0-9_-]{8,}/g, "<secret>"],
  // `NAME=value` always; `NAME: value` unless the value opens a validation message ("KEY: must be base64").
  [/\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|key)(?:[_-][a-z0-9]+)*)(?:\s*=\s*|\s*:\s*(?!(?:must|is|are|invalid|required|expected|too|should|cannot|not|needs|has|missing)\b))("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=<secret>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "<email>"],
];

/**
 * What the table keeps of a thrown value: its class and message, with URLs, credentials, JWTs,
 * key=value secrets and email addresses replaced, cut to 500 characters. Never the stack. Never throws,
 * whatever was thrown (a null-prototype object and a throwing `toString` included).
 */
export function describeCronError(error: unknown): string {
  let raw: string;
  try {
    raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    raw = "unreadable error";
  }
  let text = raw;
  try {
    for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
    text = text.replace(/\s+/g, " ").trim();
  } catch {
    text = "";
  }
  return (text === "" ? "unknown error" : text).slice(0, MAX_ERROR_LENGTH);
}

/** Runs `work`; rejects when it takes longer than `ms`. The timer is cleared either way. */
async function within<T>(ms: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("alert work timed out")), Math.max(1, Math.floor(ms))); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface UpsertRow { opened_at: string; failure_count: number; notified: boolean }

export function createCronAlerts(deps: {
  readonly service: ServiceRun;
  readonly clock: { now(): Date };
  /** The operator log, for an alert that could not be written. */
  readonly report?: (message: string, error: unknown) => void;
  /** Called while an alert is open and unnotified. Resolves true when the notice was accepted. Must not throw. */
  readonly notify?: CronAlertNotifier;
  /** Called once the alert row is written, before the email: a failed email or `notified_at` mark is then not a lost row. */
  readonly onPersisted?: () => void;
  /** Monotonic milliseconds; tests inject one. */
  readonly monotonicMs?: () => number;
  readonly capMs?: number;
}): CronAlerts {
  const monotonic = deps.monotonicMs ?? (() => performance.now());
  const capMs = deps.capMs ?? ALERT_CAP_MS;
  const report = (message: string, error: unknown): void => {
    try { (deps.report ?? ((m, e) => console.error(m, e)))(message, error); } catch { /* the log is the last resort */ }
  };
  /** Milliseconds this call may still use: the cap, or what is left of the function, whichever is less. */
  const budgetFor = (run: CronRun | undefined): number => {
    if (!run) return capMs;
    const left = FUNCTION_MS - ANSWER_RESERVE_MS - (monotonic() - run.startedMonotonicMs);
    return Math.min(capMs, left);
  };
  /** One bounded service transaction: the statement timeout is set first, so a stuck write frees its connection. */
  const bounded = <T>(ms: number, work: (tx: Transaction) => Promise<T>): Promise<T> => {
    const statementMs = Math.max(100, Math.floor(ms) - 100);
    return within(ms, () => deps.service(async (tx) => {
      await tx.query(`SET LOCAL statement_timeout = ${statementMs}`);
      return work(tx);
    }));
  };

  return {
    async failed(job, error, run) {
      try {
        const began = monotonic();
        const total = budgetFor(run);
        if (total < 200) {
          report(`Cron alert for ${job} not recorded`, "no time left in the function");
          return;
        }
        const text = describeCronError(error);
        const spent = () => monotonic() - began;
        const written = await bounded(total, (tx) => tx.query<UpsertRow>(
          `INSERT INTO cron_alerts (job, opened_at, last_failed_at, failure_count, last_error, notified_at)
           VALUES ($1, clock_timestamp(), clock_timestamp(), 1, $2, NULL)
           ON CONFLICT (job) DO UPDATE SET
             opened_at = CASE WHEN cron_alerts.resolved_at IS NULL THEN cron_alerts.opened_at ELSE EXCLUDED.opened_at END,
             failure_count = CASE WHEN cron_alerts.resolved_at IS NULL THEN cron_alerts.failure_count + 1 ELSE 1 END,
             notified_at = CASE WHEN cron_alerts.resolved_at IS NULL THEN cron_alerts.notified_at ELSE NULL END,
             last_error = CASE WHEN EXCLUDED.last_failed_at >= cron_alerts.last_failed_at THEN EXCLUDED.last_error ELSE cron_alerts.last_error END,
             last_failed_at = GREATEST(cron_alerts.last_failed_at, EXCLUDED.last_failed_at),
             resolved_at = NULL
           RETURNING opened_at::text AS opened_at, failure_count, notified_at IS NOT NULL AS notified`,
          [job, text],
        ));
        const row = written.rows[0];
        if (row) { try { deps.onPersisted?.(); } catch { /* a hook must not change the recorder */ } }
        if (!row || row.notified || !deps.notify) return;
        const sendMs = total - spent();
        if (sendMs < MIN_SEND_MS) return; // the next failing run sends it
        const sent = await deps.notify({ job, openedAt: row.opened_at, failureCount: row.failure_count, error: text }, { timeoutMs: sendMs });
        if (!sent) return;
        const markMs = total - spent();
        if (markMs < 200) return; // sent but unmarked: the next failure resends with the same idempotency key
        await bounded(markMs, (tx) => tx.query(
          "UPDATE cron_alerts SET notified_at = clock_timestamp() WHERE job = $1 AND opened_at = $2::timestamptz AND notified_at IS NULL",
          [job, row.opened_at],
        ));
      } catch (problem) {
        report(`Cron alert for ${job} not recorded`, problem);
      }
    },
    async succeeded(job, run) {
      try {
        const total = budgetFor(run);
        if (total < 200) return;
        const startedAt = (run?.startedAt ?? deps.clock.now()).toISOString();
        await bounded(total, (tx) => tx.query(
          "UPDATE cron_alerts SET resolved_at = clock_timestamp() WHERE job = $1 AND resolved_at IS NULL AND last_failed_at <= $2::timestamptz",
          [job, startedAt],
        ));
      } catch (problem) {
        report(`Cron alert for ${job} not cleared`, problem);
      }
    },
  };
}

/**
 * The alerts for one cron function, over the service pool its runner already holds (no second pool,
 * so no extra connection from the function's budget).
 */
export function createCronAlertsOnPool(
  pool: Pool,
  clock: { now(): Date },
  /** The process environment, for OPS_ALERT_EMAIL, the Resend settings and the environment name; the entry point passes it. */
  source: Readonly<Record<string, string | undefined>>,
): CronAlerts {
  return createCronAlerts({
    service: (work) => asService(pool, work),
    clock,
    notify: createOpsAlertMailer({ env: source }),
  });
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
