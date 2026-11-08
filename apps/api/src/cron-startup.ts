// A cron function that cannot start must still raise a cron alert. The Vercel cron entries used to build
// their config, pools and runner at module load, so a bad or missing variable threw before the cron
// route (and its alert recorder, cron-alerts.ts) existed: Vercel answered 500 and nobody was told.
//
// `guardCronEntry` moves that build into the request:
//   - The cron call is authenticated BEFORE anything is built: the secret must be set, at least 32
//     characters and not the .env.example placeholder (the rule the env parsers use), and match the
//     bearer. An unauthorised call opens no pool, logs nothing and writes nothing; it gets the 404 or 401
//     the healthy route gives.
//   - The build has a deadline. A build that hangs keeps running (and is adopted if it ends well); later
//     requests wait on that same build instead of starting another.
//   - A failed build answers 503 and records a startup alert on the job's own row, the error named
//     `CronStartupFailed`, so the next good run of the job closes it like any other alert. One recording
//     runs at a time per instance, and the next build waits for it: a quick recovery cannot be closed
//     before its failure row exists.
//   - A worker switched off closes a stale startup alert once per instance (`disabled`).
//   - Only the build counts as a startup failure. An error the built handler throws behaves as before.
// One deadline (FUNCTION_MS less the answer reserve, from the start of the request) covers build, record
// and email, so the 503 goes out before Vercel stops the function.
//
// What the startup alert needs, and what it does when that is missing:
//   - the job's service database URL, and DATABASE_CA_CERT unless the host is loopback: the same rule the
//     config enforces. The alert never opens a connection the config would refuse. Without it no row.
//   - OPS_ALERT_EMAIL and the Resend settings. When no row was persisted, an email of its own goes out
//     (once an hour per job and deployment).
// With neither, the failure is only in the Vercel log. A failure before this module runs (the bundle
// cannot load, a module-level throw in a dependency) cannot be caught here; Vercel answers 500.
import { createHash, timingSafeEqual } from "node:crypto";
import { parse } from "pg-connection-string";
import type { Pool } from "pg";
import { apiErrorBody } from "@zs/core";
import { asService, createRuntimePool } from "@zs/db";
import { PLACEHOLDER_CRON_SECRET } from "./cron-common.js";
import { createOpsAlertMailer } from "./cron-alert-mail.js";
import { ANSWER_RESERVE_MS, createCronAlerts, describeCronError, FUNCTION_MS, startCronRun, type CronRun } from "./cron-alerts.js";
import { LOOPBACK } from "./env-schema.js";

type Env = Readonly<Record<string, string | undefined>>;
/** What a cron entry serves once it has started: a fetch handler (a Hono app's `fetch`). */
export type CronHandler = (request: Request) => Response | Promise<Response>;
export interface CronEntry {
  readonly fetch: CronHandler;
  /** True when the job's kill switch is off: a stale startup alert is closed once, on the first authorised call. */
  readonly disabled?: boolean;
}

/** The error a startup failure records: the job could not build its config, pools or runner. The text is redacted. */
export class CronStartupFailed extends Error {
  constructor(job: string, cause: unknown) {
    super(`${job} failed to start: ${describeCronError(cause).replace(/^Error: /, "")}`);
    this.name = "CronStartupFailed";
  }
}

/** The alert side of a startup failure. Neither method throws. */
export interface StartupAlerts {
  /** Records a startup failure of `job`: the row, and the email. One at a time. */
  record(failure: { readonly job: string; readonly error: CronStartupFailed; readonly run: CronRun }): Promise<void>;
  /** The job starts again with its switch off: closes its open startup alert. */
  closeStartup(job: string, run: CronRun): Promise<void>;
}

/** Milliseconds of the shared deadline that are left for this request. */
const millisLeft = (run: CronRun): number => FUNCTION_MS - ANSWER_RESERVE_MS - (performance.now() - run.startedMonotonicMs);

/** Rejects with `Error(label)` after `ms`; the timer is cleared either way. */
async function withDeadline<T>(ms: number, work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), Math.max(1, Math.floor(ms))); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Waits for `work` at most `ms`; never rejects. */
async function settleWithin(ms: number, work: Promise<unknown>): Promise<void> {
  await withDeadline(ms, work, "wait timed out").catch(() => undefined);
}

/** The pool options for the job's service login, or null when the config would refuse them (or none are set). */
function serviceTarget(env: Env, variable: string): { connectionString: string; ssl?: { ca: string; rejectUnauthorized: true } } | null {
  const url = env[variable];
  if (!url || url.includes("?")) return null; // URL options could retarget the connection or replace the pinned TLS settings
  let host: string;
  try {
    host = (parse(url).host ?? "").toLowerCase();
  } catch {
    return null;
  }
  const ca = env.DATABASE_CA_CERT;
  // A CA that is set but is not a certificate is refused by the config, on a loopback host too.
  if (ca !== undefined && !ca.includes("BEGIN CERTIFICATE")) return null;
  if (!LOOPBACK.has(host) && ca === undefined) return null; // never an unpinned TLS connection to a hosted database
  return { connectionString: url, ...(ca === undefined ? {} : { ssl: { ca, rejectUnauthorized: true as const } }) };
}

/** The startup alerts over the process environment: the alert row, and an email of its own when no row was written. */
export function createStartupAlerts(deps: {
  readonly env: Env;
  readonly clock: { now(): Date };
  /** The environment variable that holds this job's service database URL. */
  readonly databaseUrlVariable: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly report?: (message: string) => void;
}): StartupAlerts & { dispose(): Promise<void> } {
  const log = (message: string, detail?: unknown) => {
    try { (deps.report ?? ((m: string) => console.error(m)))(detail === undefined ? message : `${message}: ${describeCronError(detail)}`); } catch { /* the log is the last resort */ }
  };
  // One mailer, so its "setting missing" notice is logged once per instance.
  const mailer = createOpsAlertMailer({ env: deps.env, ...(deps.fetch ? { fetch: deps.fetch } : {}), report: (message, detail) => log(message, detail) });
  let pool: Pool | null = null;
  let running: Promise<void> | null = null;
  /** One pool for the instance: made on first use, never one per failure. Idle clients leave after 10 s. */
  const servicePool = (target: NonNullable<ReturnType<typeof serviceTarget>>): Pool =>
    (pool ??= createRuntimePool({
      ...target, max: 2, connectionTimeoutMs: 2_500, applicationName: "zs-cron-startup",
      onError: (summary) => log("Startup alert pool error", `${summary.code ?? ""} ${summary.message}`),
    }));

  async function recordOnce(job: string, error: CronStartupFailed, run: CronRun): Promise<void> {
    const target = serviceTarget(deps.env, deps.databaseUrlVariable);
    let persisted = false;
    if (target === null) log(`Startup alert for ${job} has no usable ${deps.databaseUrlVariable}: the row is not written`);
    else {
      await createCronAlerts({
        service: (work) => asService(servicePool(target), work),
        clock: deps.clock,
        notify: mailer,
        onPersisted: () => { persisted = true; },
        report: (message, problem) => log(message, problem),
      }).failed(job, error, run);
    }
    if (persisted) return; // the row is there; its email (or its retry on the next tick) is the recorder's
    const left = millisLeft(run);
    if (left < 600) {
      log(`Startup alert for ${job}: no time left for the email`);
      return;
    }
    // No row: an email of its own, keyed by the hour so a failing cron mails once an hour.
    const hour = new Date(Math.floor(deps.clock.now().getTime() / 3_600_000) * 3_600_000).toISOString();
    await mailer({ job, openedAt: hour, failureCount: 1, error: describeCronError(error), unrecorded: true }, { timeoutMs: Math.min(3_000, left - 300) });
  }

  return {
    record({ job, error, run }) {
      // One recording at a time: a failure that arrives while one runs is the same incident.
      if (running !== null) return running;
      const current = (async () => {
        try { await recordOnce(job, error, run); } catch (problem) { log(`Startup alert for ${job} not raised`, problem); }
      })().finally(() => { running = null; });
      running = current;
      return current;
    },
    async closeStartup(job, run) {
      try {
        const target = serviceTarget(deps.env, deps.databaseUrlVariable);
        if (target === null) return;
        const ms = Math.min(3_000, millisLeft(run) - 300);
        if (ms < 400) return;
        await withDeadline(ms, asService(servicePool(target), async (tx) => {
          await tx.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(ms) - 100)}`);
          await tx.query(
            "UPDATE cron_alerts SET resolved_at = clock_timestamp() WHERE job = $1 AND resolved_at IS NULL AND last_error LIKE 'CronStartupFailed:%'",
            [job],
          );
        }), "closing the startup alert timed out");
      } catch (problem) {
        log(`Startup alert for ${job} not closed`, problem);
      }
    },
    async dispose() {
      const held = pool;
      pool = null;
      if (held) await held.end().catch(() => undefined);
    },
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, code: Parameters<typeof apiErrorBody>[0], message: string) =>
  new Response(JSON.stringify(apiErrorBody(code, message)), { status, headers: JSON_HEADERS });
/** The env parsers' rule for CRON_SECRET: at least 32 characters, not the .env.example placeholder. */
const usableSecret = (secret: string): boolean => secret.length >= 32 && secret !== PLACEHOLDER_CRON_SECRET;

/** After a failed build, requests that are not the cron call wait this long before they start another build. */
const OTHER_PATH_BACKOFF_MS = 10_000;
/** The longest a build may take. A cold start builds lazy pools and runs one login check; the rest of the 30 s is for the run. */
const DEFAULT_BUILD_TIMEOUT_MS = 8_000;
/** Kept free after the build wait, for the alert and the answer. */
const AFTER_BUILD_RESERVE_MS = 4_000;

/**
 * The fetch handler for a cron function. `build` parses the environment and starts the runner. See the
 * top of this file for the order of events.
 */
export function guardCronEntry(options: {
  readonly job: string;
  readonly cronPath: string;
  readonly env: Env;
  readonly clock: { now(): Date };
  readonly build: () => CronEntry | Promise<CronEntry>;
  readonly startupAlerts: StartupAlerts;
  /** "build": paths other than the cron call (the connections worker's signed routes) also start the build, without an alert. Default "not-found". */
  readonly otherPaths?: "build" | "not-found";
  readonly buildTimeoutMs?: number;
  readonly report?: (message: string) => void;
}): CronHandler {
  const { job, cronPath, env } = options;
  const report = options.report ?? ((message: string) => console.error(message));
  const buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  let entry: CronEntry | null = null;
  let building: Promise<CronEntry> | null = null;
  let recording: Promise<void> | null = null;
  let failedAtMs: number | null = null;
  let closePending = false;
  const recordedFailures = new WeakSet<object>();

  const ensureBuild = (): Promise<CronEntry> => {
    if (building !== null) return building;
    const attempt = (async () => options.build())();
    building = attempt;
    attempt.then(
      (built) => { entry = built; closePending = built.disabled === true; if (building === attempt) building = null; },
      () => { failedAtMs = performance.now(); if (building === attempt) building = null; },
    );
    return attempt;
  };
  /** Waits for the build within the shared deadline; the build itself keeps running if it is late. */
  const awaitBuild = (run: CronRun): Promise<CronEntry> => {
    const ms = Math.min(buildTimeoutMs, millisLeft(run) - AFTER_BUILD_RESERVE_MS);
    const pending = ensureBuild();
    return withDeadline(ms, pending, `build timed out after ${Math.max(0, Math.floor(ms))} ms`);
  };

  async function authorisedCall(request: Request): Promise<Response> {
    const secret = env.CRON_SECRET;
    if (!secret) return answer(404, "NotFound", "Route not found");
    if (!usableSecret(secret) || !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`)))
      return answer(401, "Unauthorized", "Invalid cron credentials");
    const run = startCronRun(options.clock);
    if (entry === null) {
      // The previous failure is on its row before this build starts, so a recovery cannot close nothing.
      if (recording !== null) await settleWithin(millisLeft(run) - AFTER_BUILD_RESERVE_MS, recording);
      if (entry === null) {
        try {
          await awaitBuild(run);
        } catch (problem) {
          return startupFailed(problem, run);
        }
      }
    }
    const ready = entry as CronEntry | null;
    if (ready === null) return answer(503, "Unavailable", `${job} failed to start`);
    if (closePending) {
      closePending = false;
      await options.startupAlerts.closeStartup(job, run);
    }
    return ready.fetch(request);
  }

  async function startupFailed(problem: unknown, run: CronRun): Promise<Response> {
    const error = new CronStartupFailed(job, problem);
    report(`Cron ${job} failed to start: ${describeCronError(error)}`);
    // One recording per failing build (every waiter sees the same rejection), one at a time.
    const first = typeof problem === "object" && problem !== null ? !recordedFailures.has(problem) : true;
    if (typeof problem === "object" && problem !== null) recordedFailures.add(problem);
    if (recording === null && first) {
      const current = (async () => options.startupAlerts.record({ job, error, run }))()
        .catch((failure: unknown) => report(`Startup alert for ${job} not raised: ${describeCronError(failure)}`))
        .finally(() => { if (recording === current) recording = null; });
      recording = current;
    }
    if (recording !== null) await settleWithin(millisLeft(run) - 200, recording);
    return answer(503, "Unavailable", `${job} failed to start`);
  }

  async function otherCall(request: Request): Promise<Response> {
    // Not the cron call, so no secret to check here: the built routes verify their own signatures. No log, no alert.
    if (failedAtMs !== null && performance.now() - failedAtMs < OTHER_PATH_BACKOFF_MS) return answer(503, "Unavailable", `${job} failed to start`);
    let built: CronEntry;
    try {
      built = await awaitBuild(startCronRun(options.clock));
    } catch {
      return answer(503, "Unavailable", `${job} failed to start`);
    }
    return built.fetch(request);
  }

  return async (request) => {
    let path: string | null = null;
    try { path = new URL(request.url).pathname; } catch { /* an unreadable URL is never the cron path */ }
    const isCron = request.method === "GET" && path === cronPath;
    if (isCron && (entry === null || closePending)) return authorisedCall(request);
    if (entry !== null) return entry.fetch(request); // built: the handler's own behaviour, errors included
    if (isCron || options.otherPaths !== "build") return answer(404, "NotFound", "Route not found");
    return otherCall(request);
  };
}
