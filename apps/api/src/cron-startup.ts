// A cron function that cannot start must still raise a cron alert. The Vercel cron entries used to build
// their config, pools and runner at module load, so a bad or missing variable threw before the cron
// route (and its alert recorder, cron-alerts.ts) existed: Vercel answered 500 and nobody was told.
//
// `guardCronEntry` moves that build into the first request. When it throws, the request is answered 503
// (never 2xx), and an authorised cron call records the failure as an alert on the job's own row, the
// error named `CronStartupFailed` so a startup failure reads differently from a failed run. The next good
// run of the job closes it like any other alert. The build is retried on every request until it works.
//
// What the startup alert needs, and what it does when that is missing:
//   - the job's service database URL (and DATABASE_CA_CERT unless the host is loopback), the same rule
//     the config enforces: the alert never opens a connection the config would refuse. Without it the
//     row cannot be written.
//   - OPS_ALERT_EMAIL and the Resend settings, for the email. When the row cannot be written, the email
//     still goes out (once an hour per job, by idempotency key).
// With neither, the failure is only in the Vercel log: the 503 and an operator-log line say so.
// A failure before this module runs (the bundle cannot load, a module-level throw in a dependency)
// cannot be caught here; Vercel answers 500 for it.
import { createHash, timingSafeEqual } from "node:crypto";
import { parse } from "pg-connection-string";
import { apiErrorBody } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import { createOpsAlertMailer } from "./cron-alert-mail.js";
import { createCronAlerts, describeCronError, startCronRun, type CronRun } from "./cron-alerts.js";
import { LOOPBACK } from "./env-schema.js";

type Env = Readonly<Record<string, string | undefined>>;
/** What a cron entry serves once it has started: a fetch handler (a Hono app's `fetch`). */
export type CronHandler = (request: Request) => Response | Promise<Response>;

/** The error a startup failure records: the job could not build its config, pools or runner. */
export class CronStartupFailed extends Error {
  constructor(job: string, cause: unknown) {
    let detail: string;
    try {
      detail = cause instanceof Error ? (cause.name === "Error" ? cause.message : `${cause.name}: ${cause.message}`) : String(cause);
    } catch {
      detail = "unreadable error";
    }
    super(`${job} failed to start: ${detail}`);
    this.name = "CronStartupFailed";
  }
}

/** Records a startup failure of `job`. Never throws. */
export type StartupRecorder = (failure: { readonly job: string; readonly error: CronStartupFailed; readonly run: CronRun }) => Promise<void>;

/** Shuts a pool within a short wait; a connection that hangs must not hold the answer. */
async function closeQuickly(pool: { end(): Promise<void> }): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pool.end(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
  } catch {
    /* closing is best effort */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The pool options for the job's service login, or null when the config would refuse them (or none are set). */
function serviceTarget(env: Env, variable: string): { connectionString: string; ssl?: { ca: string; rejectUnauthorized: true } } | null {
  const url = env[variable];
  if (!url) return null;
  let host: string;
  try {
    host = (parse(url).host ?? "").toLowerCase();
  } catch {
    return null;
  }
  const ca = env.DATABASE_CA_CERT;
  const hasCa = ca !== undefined && ca.includes("BEGIN CERTIFICATE");
  const loopback = LOOPBACK.has(host);
  if (!loopback && !hasCa) return null; // never an unpinned TLS connection to a hosted database
  if ((!loopback || hasCa) && url.includes("?")) return null; // URL options would replace the pinned settings
  return { connectionString: url, ...(hasCa ? { ssl: { ca, rejectUnauthorized: true as const } } : {}) };
}

/** The startup recorder over the process environment: the alert row, and the email when the row fails. */
export function createStartupRecorder(deps: {
  readonly env: Env;
  readonly clock: { now(): Date };
  /** The environment variable that holds this job's service database URL. */
  readonly databaseUrlVariable: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly report?: (message: string, detail?: unknown) => void;
}): StartupRecorder {
  const report = (message: string, detail?: unknown) => {
    try { (deps.report ?? ((m, d) => console.error(m, d ?? "")))(message, detail); } catch { /* the log is the last resort */ }
  };
  return async ({ job, error, run }) => {
    try {
      const notify = createOpsAlertMailer({ env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}), report: (m, d) => report(m, d) });
      const target = serviceTarget(deps.env, deps.databaseUrlVariable);
      let recorded = false;
      if (target === null) {
        report(`Startup alert for ${job} has no usable ${deps.databaseUrlVariable}: the row is not written`);
      } else {
        const pool = createRuntimePool({
          ...target, max: 1, connectionTimeoutMs: 2_500, applicationName: `zs-${job}-startup`,
          onError: (summary) => console.error(`Startup alert pool error (${job})`, summary),
        });
        try {
          let failedToWrite = false;
          await createCronAlerts({
            service: (work) => asService(pool, work),
            clock: deps.clock,
            notify,
            report: (message, problem) => { failedToWrite = true; report(message, problem); },
          }).failed(job, error, run);
          recorded = !failedToWrite;
        } finally {
          await closeQuickly(pool);
        }
      }
      if (recorded) return;
      // No row: the email alone, keyed by the hour so a failing minute-by-minute cron mails once an hour.
      const hour = new Date(Math.floor(deps.clock.now().getTime() / 3_600_000) * 3_600_000).toISOString();
      await notify({ job, openedAt: hour, failureCount: 1, error: describeCronError(error) }, { timeoutMs: 3_000 });
    } catch (problem) {
      report(`Startup alert for ${job} not raised`, problem instanceof Error ? problem.message : problem);
    }
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, code: Parameters<typeof apiErrorBody>[0], message: string) =>
  new Response(JSON.stringify(apiErrorBody(code, message)), { status, headers: JSON_HEADERS });

/**
 * The fetch handler for a cron function. `build` parses the environment and starts the runner; it runs
 * on the first request (and again on each request while it keeps failing). A failure answers 503, and
 * an authorised GET of `cronPath` also records a startup alert. Other paths of the same function (the
 * connections worker's signed operations) answer 503 without recording one: the cron tick records it.
 */
export function guardCronEntry(options: {
  readonly job: string;
  readonly cronPath: string;
  readonly env: Env;
  readonly clock: { now(): Date };
  readonly build: () => CronHandler | Promise<CronHandler>;
  readonly recordStartupFailure: StartupRecorder;
  readonly report?: (message: string) => void;
}): CronHandler {
  const { job, cronPath, env } = options;
  const report = options.report ?? ((message: string) => console.error(message));
  let ready: Promise<CronHandler> | null = null;
  const handler = (): Promise<CronHandler> => {
    if (ready === null) {
      const attempt = (async () => options.build())();
      ready = attempt;
      attempt.catch(() => { if (ready === attempt) ready = null; }); // retry on the next request
    }
    return ready;
  };
  const authorised = (request: Request): boolean => {
    const secret = env.CRON_SECRET;
    if (!secret) return false;
    return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
  };

  return async (request) => {
    const run = startCronRun(options.clock);
    try {
      return await (await handler())(request);
    } catch (problem) {
      // Only a failed build gets here: the cron route answers its own errors.
      const error = new CronStartupFailed(job, problem);
      report(`Cron ${job} failed to start: ${describeCronError(error)}`);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === cronPath) {
        if (!env.CRON_SECRET) return answer(404, "NotFound", "Route not found");
        if (!authorised(request)) return answer(401, "Unauthorized", "Invalid cron credentials");
        // The recorder promises not to throw; a broken one must still not change the answer or hide the cause.
        await options.recordStartupFailure({ job, error, run }).catch((failure: unknown) => report(`Startup alert for ${job} not raised: ${describeCronError(failure)}`));
      }
      return answer(503, "Unavailable", `${job} failed to start`);
    }
  };
}
