import { Pool } from "pg";

/** What a pool error log may say: the SQLSTATE or socket code and a short message, never the URL. */
export interface PoolErrorSummary {
  readonly code: string | undefined;
  readonly message: string;
}

export interface RuntimePoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  /**
   * Longest wait for a connection, queued behind busy ones or while a new one opens.
   * node-postgres defaults to no limit; a request would then wait forever.
   */
  readonly connectionTimeoutMs?: number;
  /** Close a connection that has been idle this long. */
  readonly idleTimeoutMs?: number;
  /** Shown in pg_stat_activity, so an operator can tell this process's sessions apart. */
  readonly applicationName?: string;
  /** Receives at most `maxErrorReportsPerMinute` summaries of idle-connection errors. */
  readonly onError: (summary: PoolErrorSummary) => void;
  readonly maxErrorReportsPerMinute?: number;
  readonly now?: () => number;
}

const MAX_MESSAGE = 200;

/** A loggable summary of a pool error: a code and a truncated message with URLs removed. */
export function summarizePoolError(error: unknown): PoolErrorSummary {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").slice(0, MAX_MESSAGE);
  return { code, message };
}

/**
 * The pool for a server process. An idle connection can fail at any time (a restart, a
 * failover, a network drop); the pool then emits `error` outside any request. Without a
 * listener Node treats that as an unhandled error and exits. With one, the pool drops the
 * broken connection and opens a new one for the next request.
 */
export function createRuntimePool(options: RuntimePoolOptions): Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
  });
  const limit = options.maxErrorReportsPerMinute ?? 10;
  const now = options.now ?? (() => Date.now());
  let windowStart = Number.NEGATIVE_INFINITY;
  let reports = 0;
  let suppressed = 0;
  pool.on("error", (error) => {
    const at = now();
    if (at - windowStart >= 60_000) {
      if (suppressed > 0) options.onError({ code: undefined, message: `${suppressed} more pool errors not shown` });
      windowStart = at;
      reports = 0;
      suppressed = 0;
    }
    if (reports >= limit) {
      suppressed += 1;
      return;
    }
    reports += 1;
    options.onError(summarizePoolError(error));
  });
  return pool;
}

/** The probe each pool is running, so overlapping readiness checks share one connection. */
const probes = new WeakMap<Pool, Promise<boolean>>();

/**
 * Readiness: can this pool reach the database now? A bounded `SELECT 1`; never throws.
 * Liveness (`/healthz`) stays separate, so a database outage does not restart the process.
 * A probe that times out closes its connection instead of leaving it checked out, and checks
 * that arrive while one runs wait for it rather than take another connection.
 */
export async function checkDatabase(pool: Pool, timeoutMs = 2000): Promise<boolean> {
  let probe = probes.get(pool);
  if (!probe) {
    probe = runProbe(pool, timeoutMs).finally(() => probes.delete(pool));
    probes.set(pool, probe);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(pool: Pool, timeoutMs: number): Promise<boolean> {
  const client = await pool.connect().catch(() => undefined);
  if (!client) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = client.query("SELECT 1").then(() => true, () => false);
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const ok = await Promise.race([answered, timedOut]);
  clearTimeout(timer);
  // A connection that failed or did not answer in time is closed, not reused.
  client.release(ok ? undefined : new Error("Readiness probe failed"));
  return ok;
}
