import { randomBytes } from "node:crypto";
import type { ScopedDatabase } from "@zs/db";

/** Which Supavisor mode a pooler URL's port selects; transaction mode shares backends between clients per transaction. */
export function poolerTransport(port: string): { port: string; mode: "transaction" | "session" | "unknown" } {
  return { port, mode: port === "6543" ? "transaction" : port === "5432" ? "session" : "unknown" };
}

const MARKER = "zs-contamination-probe-";

/**
 * Session-contamination probe for a pooled runtime database. Every tenth transaction leaves
 * session-scoped state behind that a COMMIT keeps: a custom setting (set_config(..., false))
 * and application_name (SET). Both are harmless to other clients of a shared pooler. The
 * other transactions, run concurrently on the same pool, must never see either, and must
 * still see their own transaction-local tenant.
 */
export async function sessionContaminationProbe(db: ScopedDatabase, tenantId: string, transactions = 200) {
  const jobs = Array.from({ length: transactions }, async (_, index) => {
    if (index % 10 === 0) {
      const marker = MARKER + randomBytes(6).toString("hex");
      await db.tenant(tenantId, async (tx) => {
        await tx.query("SELECT set_config('zs.contamination_probe', $1, false)", [marker]);
        await tx.query(`SET application_name = '${marker}'`);
      });
      return null;
    }
    return db.tenant(tenantId, async (tx) => (await tx.query<{ custom: string | null; app: string; tenant: string | null }>(
      `SELECT current_setting('zs.contamination_probe', true) AS custom, current_setting('application_name') AS app,
              current_setting('app.tenant_id', true) AS tenant, pg_sleep(random() * 0.02)`)).rows[0]!);
  });
  const reads = (await Promise.all(jobs)).filter((row) => row !== null);
  const contaminated = reads.filter((row) => (row.custom ?? "").startsWith(MARKER) || row.app.startsWith(MARKER));
  const wrongTenant = reads.filter((row) => row.tenant !== tenantId);
  return {
    ok: contaminated.length === 0 && wrongTenant.length === 0,
    detail: { reads: reads.length, dirtied: transactions - reads.length, contaminated: contaminated.length, wrongTenant: wrongTenant.length },
  };
}
