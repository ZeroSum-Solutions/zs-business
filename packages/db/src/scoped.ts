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
   * Called when the session reset after a transaction fails; the connection is then
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
// Behind a transaction pooler (Supavisor, port 6543) the server connection may serve another
// client between COMMIT and SESSION_RESET, which then may run on another backend. So the
// settings and session locks work can leave behind are also reset inside the transaction,
// after deferred constraints fire with the tenant and role still set.
const TRANSACTION_RESET =
  "SET CONSTRAINTS ALL IMMEDIATE; RESET ALL; RESET ROLE; SELECT pg_catalog.pg_advisory_unlock_all()";

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
    const result = await work(client);
    await client.query(TRANSACTION_RESET);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    // Work may set session-scoped state (set_config(..., false), SET, temp objects) that a
    // commit keeps; the next borrower must start clean. A failed reset discards the client.
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
