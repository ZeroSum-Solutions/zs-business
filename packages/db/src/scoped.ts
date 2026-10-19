import { z } from "zod";
import type { Pool, PoolClient } from "pg";

export type Transaction = Pick<PoolClient, "query">;
export interface TransactionLimits {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
}
const limitsSchema = z.strictObject({
  lockTimeoutMs: z.number().int().positive().max(2147483647).default(5000),
  statementTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .default(15000),
});
export interface ScopedDatabaseOptions extends TransactionLimits {
  /**
   * Called when a backend cannot be cleaned: the in-transaction cleanup fails, work ended
   * the transaction itself, or the session reset after it fails. The connection is then
   * discarded instead of reused. Hosted checks count these: any is a failure.
   */
  onResetFailure?: (error: unknown) => void;
}
export interface ScopedDatabase {
  tenant<T>(
    tenantId: string,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
}

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

async function transaction<T>(
  pool: Pool,
  role: "authenticated" | "service_role",
  tenantId: string | null,
  work: (tx: Transaction) => Promise<T>,
  limits = limitsSchema.parse({}),
  onResetFailure?: (error: unknown) => void,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  const failed = (error: unknown) => {
    discard = true;
    onResetFailure?.(error);
  };
  let stage: "setup" | "work" | "cleanup" = "setup";
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (role === "authenticated") {
      const login = await client.query<{ safe: boolean }>(
        `SELECT rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)
          AND pg_has_role(oid, 'authenticated', 'MEMBER')
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid AND m.roleid <> 'authenticated'::regrole)
          AND NOT pg_has_role(oid, 'service_role', 'MEMBER') AS safe
         FROM pg_roles r WHERE rolname=session_user`,
      );
      if (!login.rows[0]?.safe)
        throw new Error("Runtime pool requires an unprivileged LOGIN member of authenticated only");
    }
    await client.query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [`${limits.lockTimeoutMs}ms`, `${limits.statementTimeoutMs}ms`],
    );
    await client.query(
      role === "authenticated"
        ? "SET LOCAL ROLE authenticated"
        : "SET LOCAL ROLE service_role",
    );
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId ?? "",
    ]);
    await client.query(`SAVEPOINT ${WORK_SAVEPOINT}`);
    stage = "work";
    const result = await work(client);
    await client.query(WORK_DONE);
    stage = "cleanup";
    await client.query(IN_TRANSACTION_CLEANUP);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Rolling back to the savepoint undoes the work but keeps its session advisory locks,
    // sequence state and SQL prepared statements, so the backend is cleaned before the
    // transaction ends. Before the savepoint only transaction-local settings exist.
    if (stage === "cleanup") failed(error);
    if (stage === "work") {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${WORK_SAVEPOINT}`);
        await client.query(IN_TRANSACTION_CLEANUP);
      } catch (cleanupError) {
        // A broken connection, or work ended the transaction (or released the savepoint)
        // itself, so the backend may keep session state. Discarding the client ends a direct
        // backend; behind a transaction pooler it closes only this client's socket, and the
        // pooler decides what becomes of the backend: residual risk, reported as a failure.
        failed(cleanupError);
      }
    }
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    // Belt and braces: on a direct or session-mode connection this reaches the same backend.
    // A failed reset discards the client.
    if (!discard) {
      try {
        await client.query(SESSION_RESET);
      } catch (error) {
        discard = true;
        onResetFailure?.(error);
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
    tenant: (tenantId, work) =>
      transaction(
        pool,
        "authenticated",
        z.uuid().parse(tenantId),
        work,
        limits,
        onResetFailure,
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
