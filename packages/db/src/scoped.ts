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
export interface ScopedDatabase {
  tenant<T>(
    tenantId: string,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T>;
}

async function transaction<T>(
  pool: Pool,
  role: "authenticated" | "service_role",
  tenantId: string | null,
  work: (tx: Transaction) => Promise<T>,
  limits = limitsSchema.parse({}),
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
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
    client.release(discard);
  }
}

/** Supply a server-owned pool; never expose this handle or arbitrary SQL to clients. */
export function createScopedDatabase(
  pool: Pool,
  options: TransactionLimits = {},
): ScopedDatabase {
  const limits = limitsSchema.parse(options);
  return {
    tenant: (tenantId, work) =>
      transaction(
        pool,
        "authenticated",
        z.uuid().parse(tenantId),
        work,
        limits,
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
