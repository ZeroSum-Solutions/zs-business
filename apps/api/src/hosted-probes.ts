import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseUnavailable, type ScopedDatabase, type Transaction } from "@zs/db";

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

/** A short code for a rejected transaction: the DatabaseUnavailable reason, the SQLSTATE, or the message. */
export function rejectionCode(error: unknown): string {
  if (error instanceof DatabaseUnavailable) return error.reason;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

export interface TenantLoadTarget {
  tenantId: string;
  /** Contacts the tenant must see; any other count is a crossover. */
  contacts: number;
}

/**
 * Load probe: `transactions` concurrent scoped transactions, alternately for each target,
 * each reading its tenant setting and contact counts. Every transaction settles before the
 * probe returns, so none runs on into a later check. A rejection (for example "busy", when
 * the database's maxWaiting is smaller than the queue the load builds) fails the probe and is
 * counted by code.
 */
export async function concurrentTenantProbe(
  db: ScopedDatabase,
  targets: readonly [TenantLoadTarget, TenantLoadTarget],
  options: { transactions?: number } = {},
) {
  const { transactions = 200 } = options;
  const settled = await Promise.allSettled(Array.from({ length: transactions }, (_, index) => {
    const target = targets[index % 2]!;
    return db.tenant(target.tenantId, async (tx) => {
      const row = (await tx.query<{ setting: string; contacts: number; foreign: number }>(
        `SELECT current_setting('app.tenant_id') AS setting, (SELECT count(*)::int FROM crm_contacts) AS contacts,
                (SELECT count(*)::int FROM crm_contacts WHERE tenant_id <> $1) AS foreign, pg_sleep(random()*0.05)`, [target.tenantId])).rows[0]!;
      return { tenant: target.tenantId, expected: target.contacts, ...row };
    });
  }));
  const rows = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
  const rejected: Record<string, number> = {};
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      const code = rejectionCode(outcome.reason);
      rejected[code] = (rejected[code] ?? 0) + 1;
    }
  }
  const bad = rows.filter((row) => row.setting !== row.tenant || row.foreign !== 0 || row.contacts !== row.expected);
  const failures = [
    ...Object.entries(rejected).map(([code, count]) => `${count} transactions rejected with ${code}`),
    ...(bad.length > 0 ? [`${bad.length} transactions saw another tenant's setting or rows`] : []),
  ];
  return {
    ok: failures.length === 0,
    detail: { total: transactions, fulfilled: rows.length, rejected, bad: bad.slice(0, 5), failures },
  };
}

const ABANDON_MARKER = "zs-abandon-probe-";
/** First key of the probe's two-key advisory locks, so pg_locks can find them on any backend. */
const ABANDON_LOCK_SPACE = 7_413_210;

export interface AbandonProbeOptions {
  rounds?: number;
  /** Transactions per round abandoned while their statement runs. */
  abandonedPerRound?: number;
  readsPerRound?: number;
  /** How long the abandoned statement runs in Postgres. */
  sleepMs?: number;
  /** When, after the statement starts, its caller gives up. */
  abandonAfterMs?: number;
  /** How long the backends of abandoned statements may keep the probe's locks once those statements ended. */
  settleMs?: number;
}

interface AbandonRead {
  pid: number;
  custom: string | null;
  advisory: number;
  prepared: number;
}

/**
 * Abandoned-transaction probe for a pooled runtime database. Each abandoned transaction dirties
 * its backend's session state (a session advisory lock, a PREPAREd statement, a session
 * setting), starts a pg_sleep and is abandoned through its AbortSignal while the sleep runs:
 * createScopedDatabase then closes the connection without cleaning the backend. What happens
 * to that backend is the pooler's business: Postgres ends it on a direct connection; behind a
 * transaction pooler it may be destroyed, or cleaned and given to another client. Once the
 * sleeps have ended, reader transactions on the same database check their backend: none may
 * see any marker. No backend at all may still hold a probe lock after settleMs. The probe
 * records every backend pid it saw, so `reused` tells whether a reader ran on a backend that
 * an abandoned transaction had used before it.
 */
export async function abandonedTransactionProbe(db: ScopedDatabase, tenantId: string, options: AbandonProbeOptions = {}) {
  const { rounds = 5, abandonedPerRound = 4, readsPerRound = 8, sleepMs = 1000, abandonAfterMs = 100, settleMs = 5000 } = options;
  const abandonedPids = new Set<number>();
  const keys: number[] = [];
  const applied = { advisory: 0, prepared: 0, custom: 0 };
  const outcomes: Record<string, number> = {};
  const reads: AbandonRead[] = [];
  let reused = 0;

  const abandon = async () => {
    const marker = ABANDON_MARKER + randomBytes(6).toString("hex");
    const key = randomInt(1, 2 ** 31 - 1);
    keys.push(key);
    const controller = new AbortController();
    let pid = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await db.tenant(tenantId, async (tx) => {
      pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      if (await attempt(tx, "SELECT pg_advisory_lock($1::int, $2::int)", [ABANDON_LOCK_SPACE, key])) applied.advisory += 1;
      if (await attempt(tx, `PREPARE ${marker.replaceAll("-", "_")} AS SELECT 1`)) applied.prepared += 1;
      if (await attempt(tx, "SELECT set_config('zs.abandon_probe', $1, false)", [marker])) applied.custom += 1;
      const sleeping = tx.query("SELECT pg_sleep($1)", [sleepMs / 1000]);
      timer = setTimeout(() => controller.abort(), abandonAfterMs);
      await sleeping;
    }, { signal: controller.signal }).then(() => "completed", rejectionCode).finally(() => clearTimeout(timer));
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (pid) abandonedPids.add(pid);
  };
  const read = () => db.tenant(tenantId, async (tx) => (await tx.query<AbandonRead>(
    `SELECT pg_backend_pid() AS pid, current_setting('zs.abandon_probe', true) AS custom,
            (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()) AS advisory,
            (SELECT count(*)::int FROM pg_prepared_statements WHERE name LIKE 'zs\\_abandon\\_probe\\_%') AS prepared,
            pg_sleep(random() * 0.02)`)).rows[0]!);
  // Every backend, not only the reader's, still holding a probe lock.
  const heldLocks = () => db.tenant(tenantId, async (tx) => (await tx.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::int::oid AND objsubid=2 AND objid::bigint = ANY($2::bigint[])`,
    [ABANDON_LOCK_SPACE, keys])).rows.map((row) => row.pid));

  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(Array.from({ length: abandonedPerRound }, abandon));
    // Readers start once the abandoned statements have ended, so their backends are free for reuse.
    await delay(Math.max(0, sleepMs - abandonAfterMs) + 100);
    const batch = await Promise.all(Array.from({ length: readsPerRound }, read));
    // A later round may abandon a backend these readers used; only earlier abandonments count.
    reused += batch.filter((row) => abandonedPids.has(row.pid)).length;
    reads.push(...batch);
  }
  let lockedBy = await heldLocks();
  for (const giveUp = Date.now() + settleMs; lockedBy.length > 0 && Date.now() < giveUp; lockedBy = await heldLocks()) await delay(100);

  const abandoned = outcomes.aborted ?? 0;
  const contaminated = {
    custom: reads.filter((row) => (row.custom ?? "").startsWith(ABANDON_MARKER)).length,
    advisory: reads.filter((row) => row.advisory > 0).length,
    prepared: reads.filter((row) => row.prepared > 0).length,
  };
  const failures = [
    ...Object.entries(contaminated).filter(([, count]) => count > 0).map(([kind, count]) => `${count} reads saw leftover ${kind} state`),
    ...(lockedBy.length > 0 ? [`${lockedBy.length} probe advisory locks still held ${settleMs} ms later, by backends ${[...new Set(lockedBy)].join(", ")}`] : []),
    ...(abandoned === 0 ? ["no transaction was abandoned in flight"] : []),
    ...Object.entries(outcomes).filter(([code]) => code !== "aborted").map(([code, count]) => `${count} transactions ended with ${code}, not aborted`),
  ];
  return {
    ok: failures.length === 0,
    detail: {
      abandoned,
      outcomes,
      reads: reads.length,
      applied,
      backends: { abandoned: [...abandonedPids].sort((x, y) => x - y), read: [...new Set(reads.map((row) => row.pid))].sort((x, y) => x - y) },
      reused,
      contaminated,
      lockedBy,
      failures,
    },
  };
}
