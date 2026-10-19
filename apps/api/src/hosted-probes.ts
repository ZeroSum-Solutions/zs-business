import { randomBytes } from "node:crypto";
import type { ScopedDatabase, Transaction } from "@zs/db";

export type PoolerMode = "transaction" | "session";

/** Which Supavisor mode a pooler URL's port selects; transaction mode shares backends between clients per transaction. */
export function poolerTransport(port: string): { port: string; mode: PoolerMode | "unknown" } {
  return { port, mode: port === "6543" ? "transaction" : port === "5432" ? "session" : "unknown" };
}

const TRANSPORT_FLAG = "--expect-transport=";

/**
 * The transport the deployment uses, from `--expect-transport=transaction|session`. The
 * default is transaction mode (port 6543), which the serverless API needs. A bare `--`
 * (as pnpm passes it) is ignored; any other argument is refused.
 */
export function expectedTransport(argv: readonly string[]): PoolerMode {
  let expected: PoolerMode = "transaction";
  for (const arg of argv) {
    if (arg === "--") continue;
    if (!arg.startsWith(TRANSPORT_FLAG)) throw new Error(`unknown argument ${arg}; only ${TRANSPORT_FLAG}transaction|session`);
    const value = arg.slice(TRANSPORT_FLAG.length);
    if (value !== "transaction" && value !== "session")
      throw new Error(`unsupported transport ${JSON.stringify(value)}: expected transaction (6543) or session (5432)`);
    expected = value;
  }
  return expected;
}

/** A gate, not metadata: the runtime URL must use the expected transport, and unknown ports are unsupported. */
export function transportGate(port: string, expected: PoolerMode): { ok: boolean; detail: Record<string, unknown> } {
  const actual = poolerTransport(port);
  if (actual.mode === "unknown")
    return { ok: false, detail: { ...actual, expected, error: `unsupported transport: port ${port} is neither Supavisor transaction (6543) nor session (5432) mode` } };
  if (actual.mode !== expected)
    return { ok: false, detail: { ...actual, expected, error: `runtime URL uses ${actual.mode} mode; the deployment uses ${expected} mode` } };
  return { ok: true, detail: { ...actual, expected } };
}

const MARKER = "zs-contamination-probe-";

export interface ContaminationProbeOptions {
  rounds?: number;
  /** Dirtying transactions per round, alternately committed and thrown. */
  dirtyPerRound?: number;
  readsPerRound?: number;
}

interface Read {
  pid: number;
  custom: string | null;
  app: string;
  tenant: string | null;
  advisory: number;
  temp: number;
  cursors: number;
  listens: number;
}

/** One savepoint per optional step: a step the server refuses cannot leave state behind. */
async function attempt(tx: Transaction, sql: string, values: unknown[] = []): Promise<boolean> {
  await tx.query("SAVEPOINT zs_probe_step");
  try {
    await tx.query(sql, values);
    await tx.query("RELEASE SAVEPOINT zs_probe_step");
    return true;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT zs_probe_step");
    return false;
  }
}

/**
 * Session-contamination probe for a pooled runtime database. In each round some
 * transactions leave behind every kind of session state a COMMIT or ROLLBACK keeps: a
 * custom setting (set_config(..., false)), application_name, a session advisory lock, a
 * temp table, a held cursor and a LISTEN subscription; half of them commit, half throw.
 * All are harmless to other clients of a shared pooler (unique names, nobody notifies).
 * Then other transactions read the session state of their backend; none may see any of it,
 * and each must still see its own transaction-local tenant. Every transaction records
 * pg_backend_pid(): unless some reader ran on a backend that a committed and a thrown
 * dirtying transaction used before it, the probe proved nothing and fails.
 */
export async function sessionContaminationProbe(db: ScopedDatabase, tenantId: string, options: ContaminationProbeOptions = {}) {
  const { rounds = 20, dirtyPerRound = 2, readsPerRound = 8 } = options;
  const dirtied = { committed: new Set<number>(), thrown: new Set<number>() };
  const applied = { advisory: 0, temp: 0, cursor: 0, listen: 0 };
  const unexpected: string[] = [];
  const reads: Read[] = [];
  const handoffs = { fromCommitted: 0, fromThrown: 0 };

  const dirty = async (throws: boolean) => {
    const marker = MARKER + randomBytes(6).toString("hex");
    const name = marker.replaceAll("-", "_");
    const probeError = new Error(marker);
    let pid = 0;
    try {
      await db.tenant(tenantId, async (tx) => {
        pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await tx.query("SELECT set_config('zs.contamination_probe', $1, false)", [marker]);
        await tx.query(`SET application_name = '${marker}'`);
        if (await attempt(tx, "SELECT pg_advisory_lock(hashtext($1))", [marker])) applied.advisory += 1;
        if (await attempt(tx, `CREATE TEMP TABLE ${name} AS SELECT 1 AS probe`)) applied.temp += 1;
        if (await attempt(tx, `DECLARE ${name} CURSOR WITH HOLD FOR SELECT 1`)) applied.cursor += 1;
        if (await attempt(tx, `LISTEN ${name}`)) applied.listen += 1;
        if (throws) throw probeError;
      });
      if (throws) unexpected.push("a throwing transaction committed");
    } catch (error) {
      if (error !== probeError) unexpected.push(error instanceof Error ? error.message : String(error));
    }
    if (pid) (throws ? dirtied.thrown : dirtied.committed).add(pid);
  };
  const read = () => db.tenant(tenantId, async (tx) => (await tx.query<Read>(
    `SELECT pg_backend_pid() AS pid, current_setting('zs.contamination_probe', true) AS custom,
            current_setting('application_name') AS app, current_setting('app.tenant_id', true) AS tenant,
            (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()) AS advisory,
            (SELECT count(*)::int FROM pg_class WHERE relnamespace=pg_my_temp_schema()) AS temp,
            (SELECT count(*)::int FROM pg_cursors WHERE is_holdable) AS cursors,
            (SELECT count(*)::int FROM pg_listening_channels()) AS listens,
            pg_sleep(random() * 0.02)`)).rows[0]!);

  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(Array.from({ length: dirtyPerRound }, (_, index) => dirty(index % 2 === 1)));
    // Readers start only after this round's dirtying transactions ended.
    const batch = await Promise.all(Array.from({ length: readsPerRound }, read));
    for (const row of batch) {
      if (dirtied.committed.has(row.pid)) handoffs.fromCommitted += 1;
      if (dirtied.thrown.has(row.pid)) handoffs.fromThrown += 1;
    }
    reads.push(...batch);
  }

  const contaminated = {
    custom: reads.filter((row) => (row.custom ?? "").startsWith(MARKER)).length,
    app: reads.filter((row) => row.app.startsWith(MARKER)).length,
    advisory: reads.filter((row) => row.advisory > 0).length,
    temp: reads.filter((row) => row.temp > 0).length,
    cursor: reads.filter((row) => row.cursors > 0).length,
    listen: reads.filter((row) => row.listens > 0).length,
  };
  const wrongTenant = reads.filter((row) => row.tenant !== tenantId).length;
  const failures = [
    ...Object.entries(contaminated).filter(([, count]) => count > 0).map(([kind, count]) => `${count} reads saw leftover ${kind} state`),
    ...(wrongTenant > 0 ? [`${wrongTenant} reads saw the wrong tenant`] : []),
    ...(handoffs.fromCommitted === 0 ? ["no handoff observed from a committed dirtying transaction"] : []),
    ...(handoffs.fromThrown === 0 ? ["no handoff observed from a throwing dirtying transaction"] : []),
    ...(unexpected.length > 0 ? [`${unexpected.length} dirtying transactions failed unexpectedly: ${unexpected.slice(0, 3).join("; ")}`] : []),
  ];
  return {
    ok: failures.length === 0,
    detail: {
      reads: reads.length,
      dirtied: { committed: rounds * Math.ceil(dirtyPerRound / 2), thrown: rounds * Math.floor(dirtyPerRound / 2) },
      applied,
      backends: { dirtied: new Set([...dirtied.committed, ...dirtied.thrown]).size, read: new Set(reads.map((row) => row.pid)).size },
      handoffs,
      contaminated,
      wrongTenant,
      failures,
    },
  };
}
