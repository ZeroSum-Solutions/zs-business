import { z } from "zod";
import { Client, type Pool, type PoolClient } from "pg";

export type Transaction = Pick<PoolClient, "query">;
export interface TransactionLimits {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  /**
   * Requests already queued for a connection before a new one is refused at once with
   * DatabaseUnavailable, instead of joining an unbounded queue.
   */
  maxWaiting?: number;
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
});
export interface TransactionOptions {
  /**
   * Ends the caller's interest: a pending checkout gives up (its connection goes straight
   * back), and no further statement or COMMIT is sent; the transaction rolls back. A
   * statement still running is abandoned: Postgres is asked to cancel it and its connection
   * is closed, not returned to the pool.
   */
  signal?: AbortSignal;
  /**
   * The caller's time left. Read once a connection is checked out, it caps the statement and
   * lock timeouts, so Postgres itself cancels a statement running at the deadline; read again
   * before every statement, it abandons one still running shortly after the deadline, as the
   * signal does. Either way the caller gets DatabaseUnavailable("aborted").
   */
  remainingMs?: () => number;
}
export interface ScopedDatabase {
  tenant<T>(
    tenantId: string,
    work: (tx: Transaction) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

/**
 * No connection in time (pool saturated, queue full, connect timeout or failure), or the
 * caller's deadline passed before the transaction committed. Nothing was committed by this
 * transaction, so the caller may retry; a write retries with its original idempotency key.
 */
export class DatabaseUnavailable extends Error {
  constructor(readonly reason: "busy" | "connect" | "aborted", options?: { cause?: unknown }) {
    super(`Database unavailable (${reason})`, options);
    this.name = "DatabaseUnavailable";
  }
}

async function checkout(pool: Pool, maxWaiting: number, signal: AbortSignal | undefined): Promise<PoolClient> {
  if (signal?.aborted) throw new DatabaseUnavailable("aborted");
  // The bound applies only to a checkout that would queue: an idle connection, or room for a
  // new one, is always taken, even with maxWaiting 0.
  const wouldQueue = pool.idleCount === 0 && pool.totalCount >= (pool.options.max ?? 10);
  if (wouldQueue && pool.waitingCount >= maxWaiting) throw new DatabaseUnavailable("busy");
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

/**
 * Asks Postgres to stop what a backend is running, from a separate short-lived connection:
 * pg_cancel_backend works on the login's own sessions. Best effort and never awaited; the
 * abandoned connection is closed either way.
 */
function cancelBackend(pool: Pool, pid: number | undefined): void {
  if (!pid) return;
  const client = new Client({ ...pool.options, connectionTimeoutMillis: CLEANUP_TIMEOUT_MS, query_timeout: CLEANUP_TIMEOUT_MS });
  client.on("error", () => undefined);
  void client.connect()
    .then(() => client.query("SELECT pg_cancel_backend($1)", [pid]))
    .catch(() => undefined)
    .finally(() => client.end().catch(() => undefined));
}

/** Whether the transaction gave up on a statement still running on its connection. */
interface Abandonment { abandoned: boolean }

/**
 * The transaction's view of the connection. Once the caller's signal fires, or its time left
 * (read again before every statement) runs out, no statement starts. A statement still running
 * then is abandoned: the caller gets DatabaseUnavailable("aborted") at once, Postgres is asked
 * to cancel it, and the connection is closed rather than reused, since its reply may never come.
 */
function guarded(pool: Pool, client: PoolClient, options: TransactionOptions, state: Abandonment): Transaction {
  const { signal, remainingMs } = options;
  if (!signal && !remainingMs) return client;
  const query = (...args: unknown[]) => {
    const left = remainingMs ? remainingMs() : Number.POSITIVE_INFINITY;
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
        cancelBackend(pool, (client as PoolClient & { processID?: number }).processID);
        reject(new DatabaseUnavailable("aborted"));
      }
      signal?.addEventListener("abort", abandon, { once: true });
      if (Number.isFinite(left)) timer = setTimeout(abandon, left + DEADLINE_GRACE_MS);
      running.then((value) => { settle(); resolve(value); }, (error: unknown) => { settle(); reject(error); });
    });
  };
  return { query: query as PoolClient["query"] };
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

async function transaction<T>(
  pool: Pool,
  role: "authenticated" | "service_role",
  tenantId: string | null,
  work: (tx: Transaction) => Promise<T>,
  limits = limitsSchema.parse({}),
  options: TransactionOptions = {},
): Promise<T> {
  const { signal } = options;
  const client = await checkout(pool, limits.maxWaiting, signal);
  // Which timeouts the caller's deadline shortened: only those report a cancellation as the deadline.
  const cutShort = new Set<string>();
  const state: Abandonment = { abandoned: false };
  // Every statement, setup and COMMIT included, goes through the deadline gate.
  const tx = guarded(pool, client, options, state);
  let discard = false;
  try {
    // Postgres takes whole milliseconds and treats 0 as no limit.
    const remaining = options.remainingMs ? Math.max(1, Math.ceil(options.remainingMs())) : Number.POSITIVE_INFINITY;
    if (remaining < limits.statementTimeoutMs) cutShort.add("57014");
    if (remaining < limits.lockTimeoutMs) cutShort.add("55P03");
    const cap = (limit: number) => Math.min(limit, remaining);
    // Two round trips before the work. The first opens the transaction and, for the runtime
    // role, checks the login; the second sets the role, limits and tenant. set_config('role')
    // is SET LOCAL ROLE with the same membership check. All of it is transaction-local.
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
    const result = await work(tx);
    // A COMMIT abandoned at the deadline may still have committed; a write retried with its
    // idempotency key replays it.
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    // An abandoned statement still occupies the connection: closing it rolls back instead.
    // A ROLLBACK that does not answer in time closes it too.
    if (state.abandoned || !(await settlesWithin(client.query("ROLLBACK"), CLEANUP_TIMEOUT_MS))) discard = true;
    // A statement (57014 query_canceled) or lock wait (55P03 lock_not_available) that the
    // caller's deadline cut short is the deadline passing, not a fault in the work.
    if (cutShort.has(sqlState(error) ?? "")) throw new DatabaseUnavailable("aborted", { cause: error });
    throw error;
  } finally {
    // Work may set session-scoped state (set_config(..., false), SET, temp objects) that a
    // commit keeps; the next borrower must start clean. A failed or slow reset discards the client.
    if (state.abandoned) discard = true;
    if (!discard && !(await settlesWithin(client.query(SESSION_RESET), CLEANUP_TIMEOUT_MS))) discard = true;
    client.release(discard);
  }
}

/** Use separate unprivileged LOGIN credentials, never a superuser/service pool. */
export function createScopedDatabase(
  pool: Pool,
  options: TransactionLimits = {},
): ScopedDatabase {
  const limits = limitsSchema.parse(options);
  return {
    tenant: (tenantId, work, options = {}) =>
      transaction(
        pool,
        "authenticated",
        z.uuid().parse(tenantId),
        work,
        limits,
        options,
      ),
  };
}
/** Separate privileged entry point for migrations, provisioning, and outbox workers. */
export function asService<T>(
  pool: Pool,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return transaction(pool, "service_role", null, work);
}
