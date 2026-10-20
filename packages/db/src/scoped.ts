import { z } from "zod";
import { Client, type ClientConfig, type Pool, type PoolClient } from "pg";

export type Transaction = Pick<PoolClient, "query">;
export interface TransactionLimits {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /**
   * Requests already queued for a connection before a new one is refused at once with
   * DatabaseUnavailable, instead of joining an unbounded queue.
   */
  maxWaiting?: number;
  /**
   * What happens to a statement abandoned at the deadline, besides closing its connection.
   * "none" (the default): nothing more; the statement and lock timeouts, capped at the
   * caller's time left, end it in Postgres. "backend": also send pg_cancel_backend for the
   * connection's backend. Only for a direct or session-mode connection: behind a transaction
   * pooler (Supavisor on port 6543) the backend that ran the statement may by then run
   * another request's statement, even another tenant's, and the cancel would hit that one.
   */
  cancel?: "none" | "backend";
}
const limitsSchema = z.strictObject({
  lockTimeoutMs: z.number().int().positive().max(2147483647).default(5000),
  statementTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .default(15000),
  maxWaiting: z.number().int().min(0).max(100000).default(50),
  cancel: z.enum(["none", "backend"]).default("none"),
});
export interface ScopedDatabaseOptions extends TransactionLimits {
  /**
   * Called when a backend cannot be cleaned: the in-transaction cleanup fails, work ended
   * the transaction itself, a statement after the work began was abandoned at the deadline,
   * or the session reset after it fails. The connection is then discarded instead of
   * reused. Hosted checks count these: any is a failure.
   */
  onResetFailure?: (error: unknown) => void;
}
type Limits = z.infer<typeof limitsSchema>;
export interface TransactionOptions {
  /**
   * Ends the caller's interest: a pending checkout gives up (its connection goes straight
   * back), and no further statement or COMMIT is sent; the transaction rolls back. A
   * statement still running is abandoned: its connection is closed, not returned to the pool
   * (see TransactionLimits.cancel), and an abandoned COMMIT is "commit_unknown".
   */
  signal?: AbortSignal;
  /**
   * The caller's time left. Read once a connection is checked out, it caps the statement and
   * lock timeouts, so Postgres itself cancels a statement running at the deadline; read again
   * before every statement, it abandons one still running shortly after the deadline, as the
   * signal does. Either way the caller gets DatabaseUnavailable("aborted"), or "commit_unknown"
   * when the statement abandoned was COMMIT.
   */
  remainingMs?: () => number;
}
export interface ScopedDatabase {
  tenant<T>(
    tenantId: string,
    work: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  /**
   * The runtime role with no tenant set: every tenant policy matches nothing. Only for platform
   * tables whose own policy allows the runtime a narrow write (stripe_events intake, stripe.md S-3).
   */
  platform?<T>(work: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

/**
 * No connection in time (pool saturated, queue full, connect timeout or failure), or the
 * caller's deadline passed before the transaction committed. Nothing was committed by this
 * transaction, except with "commit_unknown": the deadline passed while COMMIT was in flight,
 * so the transaction may have committed. "in_progress": another transaction still held the
 * write's idempotency key when the lock wait ended, so that one may yet commit. Either way
 * the caller may retry, and a write retries with its original idempotency key, which replays
 * a commit that did happen.
 */
export class DatabaseUnavailable extends Error {
  constructor(readonly reason: "busy" | "connect" | "aborted" | "commit_unknown" | "in_progress", options?: { cause?: unknown }) {
    super(`Database unavailable (${reason})`, options);
    this.name = "DatabaseUnavailable";
  }
}

async function checkout(pool: Pool, maxWaiting: number, signal: AbortSignal | undefined): Promise<PoolClient> {
  if (signal?.aborted) throw new DatabaseUnavailable("aborted");
  // The bound applies only to a checkout that would queue: an idle connection, or room for a
  // new one, is always taken, even with maxWaiting 0. pg-pool queues a checkout even when a
  // connection is idle and hands it over on the next tick, so in a burst the idle count stays
  // put while waitingCount grows; those waiting first take the idle connections and the room.
  const available = pool.idleCount + Math.max(0, (pool.options.max ?? 10) - pool.totalCount);
  if (pool.waitingCount - available >= maxWaiting) throw new DatabaseUnavailable("busy");
  const pending = pool.connect();
  if (!signal) return pending.catch((error: unknown) => { throw new DatabaseUnavailable("connect", { cause: error }); });
  return new Promise<PoolClient>((resolve, reject) => {
    const onAbort = () => reject(new DatabaseUnavailable("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then((client) => {
      signal.removeEventListener("abort", onAbort);
      // The checkout cannot be withdrawn from pg-pool's queue; return the connection on arrival.
      if (signal.aborted) client.release();
      else resolve(client);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(new DatabaseUnavailable("connect", { cause: error }));
    });
  });
}

const sqlState = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** Longest wait for ROLLBACK, the session reset or a cancel request before giving up on them. */
const CLEANUP_TIMEOUT_MS = 2000;
/**
 * Extra time the caller's own timer gives a statement past the deadline, so the statement
 * timeout Postgres enforces normally ends it first and the connection stays usable.
 */
const DEADLINE_GRACE_MS = 100;

/** True when the promise fulfils within `ms`; false when it rejects or takes longer. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([promise.then(() => true, () => false), late]).finally(() => clearTimeout(timer));
}

/** Cancel requests in flight per pool; past the cap an abandoned statement gets none. */
const cancelsInFlight = new WeakMap<Pool, number>();
const MAX_CANCELS_IN_FLIGHT = 2;

/**
 * Settings for a short-lived connection like the pool's own. The pool keeps the password as
 * a non-enumerable property (it may be a function), so a spread of its options drops it.
 */
export function cancelClientConfig(pool: Pool): ClientConfig {
  return {
    ...pool.options,
    password: pool.options.password,
    connectionTimeoutMillis: CLEANUP_TIMEOUT_MS,
    query_timeout: CLEANUP_TIMEOUT_MS,
    application_name: "zs-cancel",
  };
}

/**
 * Asks Postgres to stop what a backend is running, from a separate short-lived connection:
 * pg_cancel_backend works on the login's own sessions. Best effort and never awaited; the
 * abandoned connection is closed either way. At most MAX_CANCELS_IN_FLIGHT per pool run at
 * once, so repeated aborts cannot open connections without bound; a skipped cancel only
 * leaves the statement to its (deadline-capped) timeout.
 */
function cancelBackend(pool: Pool, pid: number | undefined): void {
  const inFlight = cancelsInFlight.get(pool) ?? 0;
  if (!pid || inFlight >= MAX_CANCELS_IN_FLIGHT) return;
  cancelsInFlight.set(pool, inFlight + 1);
  const client = new Client(cancelClientConfig(pool));
  client.on("error", () => undefined);
  void client.connect()
    .then(() => client.query("SELECT pg_cancel_backend($1)", [pid]))
    .catch(() => undefined)
    .finally(() => {
      cancelsInFlight.set(pool, (cancelsInFlight.get(pool) ?? 1) - 1);
      void client.end().catch(() => undefined);
    });
}

/** Whether the transaction gave up on a statement still running on its connection. */
interface Abandonment { abandoned: boolean }

/** The transaction's view of the connection, and how it sends COMMIT through the same gate. */
interface Guarded {
  tx: Transaction;
  commit(): Promise<unknown>;
}

/**
 * Once the caller's signal fires, or its time left (read again before every statement) runs
 * out, no statement starts. A statement still running then is abandoned: the caller gets
 * DatabaseUnavailable at once and the connection is closed rather than reused, since its
 * reply may never come. Closing it rolls back whatever the transaction had not committed, so
 * the reason is "aborted", except for an abandoned COMMIT, which Postgres may already have
 * applied: "commit_unknown". With cancel "backend", Postgres is also asked to stop the
 * statement; otherwise the deadline-capped statement timeout ends it.
 */
function guarded(
  pool: Pool,
  client: PoolClient,
  cancel: Limits["cancel"],
  options: TransactionOptions,
  state: Abandonment,
): Guarded {
  const { signal, remainingMs } = options;
  if (!signal && !remainingMs) return { tx: client, commit: () => client.query("COMMIT") };
  const run = (outcome: "aborted" | "commit_unknown", ...args: unknown[]) => {
    const left = remainingMs ? remainingMs() : Number.POSITIVE_INFINITY;
    // Nothing sent yet, so nothing can have committed.
    if (signal?.aborted || left <= 0) return Promise.reject(new DatabaseUnavailable("aborted"));
    const running = Promise.resolve((client.query as (...a: unknown[]) => unknown)(...args));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abandon);
      };
      function abandon() {
        settle();
        state.abandoned = true;
        if (cancel === "backend") cancelBackend(pool, (client as PoolClient & { processID?: number }).processID);
        reject(new DatabaseUnavailable(outcome));
      }
      signal?.addEventListener("abort", abandon, { once: true });
      if (Number.isFinite(left)) timer = setTimeout(abandon, left + DEADLINE_GRACE_MS);
      running.then((value) => { settle(); resolve(value); }, (error: unknown) => { settle(); reject(error); });
    });
  };
  return {
    tx: { query: ((...args: unknown[]) => run("aborted", ...args)) as PoolClient["query"] },
    commit: () => run("commit_unknown", "COMMIT"),
  };
}

/** Only an unprivileged LOGIN whose sole membership is authenticated may serve tenant reads. */
const RUNTIME_LOGIN_CHECK = `SELECT rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
    AND pg_has_role(oid, 'authenticated', 'MEMBER')
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid AND m.roleid <> 'authenticated'::regrole)
    AND NOT pg_has_role(oid, 'service_role', 'MEMBER') AS safe
   FROM pg_roles r WHERE rolname=session_user`;

// DISCARD ALL without its DEALLOCATE ALL: node-postgres caches the names of the prepared
// statements it created on each connection, so deallocating them breaks later named queries.
const SESSION_RESET =
  "CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; UNLISTEN *; " +
  "SELECT pg_catalog.pg_advisory_unlock_all(); DISCARD PLANS; DISCARD TEMP; DISCARD SEQUENCES";
// Behind a transaction pooler (Supavisor, port 6543) the backend serves another client as
// soon as the transaction ends, and the post-commit SESSION_RESET may reach a different
// backend. So every transaction also clears its backend inside the transaction block, where
// all of this is legal on PostgreSQL 15 and 16 (only DISCARD ALL is refused there). It
// drops temp objects, held cursors, LISTEN subscriptions, SQL-level prepared statements
// (from_sql; node-postgres's own stay), cached plans and sequence state, session settings,
// role and session advisory locks. The transactional parts take effect at COMMIT.
const IN_TRANSACTION_CLEANUP =
  "CLOSE ALL; UNLISTEN *; DISCARD TEMP; DISCARD PLANS; DISCARD SEQUENCES; RESET ALL; RESET ROLE; " +
  "SET SESSION AUTHORIZATION DEFAULT; SELECT pg_catalog.pg_advisory_unlock_all(); " +
  "DO $$DECLARE s text; BEGIN FOR s IN SELECT name FROM pg_catalog.pg_prepared_statements WHERE from_sql " +
  "LOOP EXECUTE format('DEALLOCATE %I', s); END LOOP; END$$";
// Work runs under this savepoint. Deferred constraints fire inside it, with the tenant and
// role still set, so a violation there still rolls back to the savepoint. RELEASE fails if
// work ended the transaction itself; the client is then discarded.
const WORK_SAVEPOINT = "zs_work";
const WORK_DONE = `SET CONSTRAINTS ALL IMMEDIATE; RELEASE SAVEPOINT ${WORK_SAVEPOINT}`;

/** Like settlesWithin, but passes on the failure, or a timeout, so the caller can report it. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function transaction<T>(
  pool: Pool,
  role: "authenticated" | "service_role",
  tenantId: string | null,
  work: (tx: Transaction) => Promise<T>,
  limits = limitsSchema.parse({}),
  options: TransactionOptions = {},
  onResetFailure?: (error: unknown) => void,
): Promise<T> {
  const { signal } = options;
  const client = await checkout(pool, limits.maxWaiting, signal);
  // Which timeouts the caller's deadline shortened: only those report a cancellation as the deadline.
  const cutShort = new Set<string>();
  const state: Abandonment = { abandoned: false };
  // Every statement, setup, cleanup and COMMIT included, goes through the deadline gate.
  const { tx, commit } = guarded(pool, client, limits.cancel, options, state);
  let discard = false;
  const failed = (error: unknown) => {
    discard = true;
    onResetFailure?.(error);
  };
  let stage: "setup" | "work" | "cleanup" = "setup";
  try {
    // Postgres takes whole milliseconds and treats 0 as no limit.
    const remaining = options.remainingMs ? Math.max(1, Math.ceil(options.remainingMs())) : Number.POSITIVE_INFINITY;
    if (remaining < limits.statementTimeoutMs) cutShort.add("57014");
    if (remaining < limits.lockTimeoutMs) cutShort.add("55P03");
    const cap = (limit: number) => Math.min(limit, remaining);
    // Three round trips before the work. The first opens the transaction and, for the runtime
    // role, checks the login; the second sets the role, limits and tenant; the third opens
    // the work savepoint. set_config('role') is SET LOCAL ROLE with the same membership
    // check. All of it is transaction-local.
    if (role === "authenticated") {
      const [, login] = (await tx.query(
        `BEGIN ISOLATION LEVEL READ COMMITTED; ${RUNTIME_LOGIN_CHECK}`,
      )) as unknown as [unknown, { rows: { safe: boolean }[] }];
      if (!login.rows[0]?.safe)
        throw new Error("Runtime pool requires an unprivileged LOGIN member of authenticated only");
    } else {
      await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    }
    await tx.query(
      `SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),
              set_config('role',$3,true),set_config('app.tenant_id',$4,true)`,
      [`${cap(limits.lockTimeoutMs)}ms`, `${cap(limits.statementTimeoutMs)}ms`, role, tenantId ?? ""],
    );
    await tx.query(`SAVEPOINT ${WORK_SAVEPOINT}`);
    stage = "work";
    const result = await work(tx);
    // One round trip ends the work and cleans the backend. A failure before the RELEASE
    // (a deferred constraint) still rolls back to the savepoint; one after it cannot, and
    // is reported below.
    await tx.query(`${WORK_DONE}; ${IN_TRANSACTION_CLEANUP}`);
    stage = "cleanup";
    // A COMMIT abandoned at the deadline may still have committed: DatabaseUnavailable
    // ("commit_unknown"). A write retried with its idempotency key replays it.
    await commit();
    return result;
  } catch (error) {
    if (state.abandoned) {
      // An abandoned statement still occupies the connection: closing it rolls back instead,
      // but nothing can clean the backend first. Before the savepoint only transaction-local
      // settings exist; after it, behind a transaction pooler, the backend may keep session
      // state, so that is reported like any other cleanup failure.
      discard = true;
      if (stage !== "setup") onResetFailure?.(error);
    } else {
      // A failed COMMIT rolled back the cleanup with the work.
      if (stage === "cleanup") failed(error);
      // Rolling back to the savepoint undoes the work but keeps its session advisory locks,
      // sequence state and SQL prepared statements, so the backend is cleaned before the
      // transaction ends. These recovery statements bypass the deadline gate, like ROLLBACK:
      // the gate refuses every statement once the deadline has passed, which would leave a
      // pooled backend dirty. Each is bounded by CLEANUP_TIMEOUT_MS instead.
      if (stage === "work") {
        try {
          await within(client.query(`ROLLBACK TO SAVEPOINT ${WORK_SAVEPOINT}`), CLEANUP_TIMEOUT_MS);
          await within(client.query(IN_TRANSACTION_CLEANUP), CLEANUP_TIMEOUT_MS);
        } catch (cleanupError) {
          // A broken or unresponsive connection, or work ended the transaction (or released
          // the savepoint) itself, so the backend may keep session state. Discarding the
          // client ends a direct backend; behind a transaction pooler it closes only this
          // client's socket, and the pooler decides what becomes of the backend: residual
          // risk, reported as a failure.
          failed(cleanupError);
        }
      }
      // A ROLLBACK that does not answer in time closes the connection too.
      if (!(await settlesWithin(client.query("ROLLBACK"), CLEANUP_TIMEOUT_MS))) discard = true;
    }
    // A statement (57014 query_canceled) or lock wait (55P03 lock_not_available) that the
    // caller's deadline cut short is the deadline passing, not a fault in the work.
    if (cutShort.has(sqlState(error) ?? "")) throw new DatabaseUnavailable("aborted", { cause: error });
    throw error;
  } finally {
    // Belt and braces: on a direct or session-mode connection this reaches the same backend.
    // Work may also set session-scoped state that a commit keeps. A failed or slow reset
    // discards the client.
    if (!discard) {
      try {
        await within(client.query(SESSION_RESET), CLEANUP_TIMEOUT_MS);
      } catch (error) {
        failed(error);
      }
    }
    client.release(discard);
  }
}

/** Use separate unprivileged LOGIN credentials, never a superuser/service pool. */
export function createScopedDatabase(
  pool: Pool,
  options: ScopedDatabaseOptions = {},
): ScopedDatabase {
  const { onResetFailure, ...limitOptions } = options;
  const limits = limitsSchema.parse(limitOptions);
  return {
    tenant: (tenantId, work, transactionOptions = {}) =>
      transaction(
        pool,
        "authenticated",
        z.uuid().parse(tenantId),
        work,
        limits,
        transactionOptions,
        onResetFailure,
      ),
    platform: (work, transactionOptions = {}) =>
      transaction(pool, "authenticated", null, work, limits, transactionOptions, onResetFailure),
  };
}
/** Separate privileged entry point for migrations, provisioning, and outbox workers. */
export function asService<T>(
  pool: Pool,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return transaction(pool, "service_role", null, work);
}
