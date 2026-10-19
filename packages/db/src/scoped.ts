import { z } from "zod";
import type { Pool, PoolClient } from "pg";

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
   * statement already running is bounded by the statement timeout.
   */
  signal?: AbortSignal;
  /**
   * The caller's time left, read once a connection is checked out. No statement or lock
   * wait in this transaction runs longer, so Postgres itself cancels a statement still
   * running when the caller's deadline passes, instead of holding the connection until the
   * statement timeout. Such a cancellation is DatabaseUnavailable("aborted").
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
  if (pool.waitingCount >= maxWaiting) throw new DatabaseUnavailable("busy");
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

/** The work's view of the connection: once the caller's signal fires, no more statements. */
function guarded(client: PoolClient, signal: AbortSignal | undefined): Transaction {
  if (!signal) return client;
  const query = (...args: unknown[]) => {
    if (signal.aborted) return Promise.reject(new DatabaseUnavailable("aborted"));
    return (client.query as (...a: unknown[]) => unknown)(...args);
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
      const [, login] = (await client.query(
        `BEGIN ISOLATION LEVEL READ COMMITTED; ${RUNTIME_LOGIN_CHECK}`,
      )) as unknown as [unknown, { rows: { safe: boolean }[] }];
      if (!login.rows[0]?.safe)
        throw new Error("Runtime pool requires an unprivileged LOGIN member of authenticated only");
    } else {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    }
    await client.query(
      `SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),
              set_config('role',$3,true),set_config('app.tenant_id',$4,true)`,
      [`${cap(limits.lockTimeoutMs)}ms`, `${cap(limits.statementTimeoutMs)}ms`, role, tenantId ?? ""],
    );
    const result = await work(guarded(client, signal));
    if (signal?.aborted) throw new DatabaseUnavailable("aborted");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    // A statement (57014 query_canceled) or lock wait (55P03 lock_not_available) that the
    // caller's deadline cut short is the deadline passing, not a fault in the work.
    if (cutShort.has(sqlState(error) ?? "")) throw new DatabaseUnavailable("aborted", { cause: error });
    throw error;
  } finally {
    // Work may set session-scoped state (set_config(..., false), SET, temp objects) that a
    // commit keeps; the next borrower must start clean. A failed reset discards the client.
    if (!discard) {
      try {
        await client.query(SESSION_RESET);
      } catch {
        discard = true;
      }
    }
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
