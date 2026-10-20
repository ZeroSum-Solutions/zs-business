import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Pool } from "pg";
import type { MigrationRecord } from "@zs/db";
import { currentTables, readLedger, type BackupFacts, type LedgerEntry } from "./hosted-backup.js";
import { redactSecrets } from "./hosted.js";

/** Where an --apply run stopped; the receipt names it. */
export type MigratePhase = "login-check" | "dry-run" | "backup-check" | "apply" | "ledger-check";

export type HostedMigrateMode = { mode: "dry-run" } | { mode: "apply"; backupPath: string; receiptPath: string };

export interface HostedMigrateDeps {
  readonly pool: Pick<Pool, "query">;
  /** Non-secret facts about the target (describeHosted), copied into the output. */
  readonly target: Record<string, string>;
  readonly migrate: (options: { dryRun: true } | { expect: readonly MigrationRecord[] }) => Promise<MigrationRecord[]>;
  readonly checkBackup: (path: string, ledger: readonly LedgerEntry[], tables: string[]) => Promise<BackupFacts>;
  readonly clock: { now(): Date };
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

interface Login {
  session_user: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; member_of: string[]; server_version: string;
}

async function checkLogin(pool: HostedMigrateDeps["pool"]): Promise<Login> {
  const login = (await pool.query<Login>(
    `SELECT session_user::text, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
            coalesce((SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m
              JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '{}') AS member_of,
            current_setting('server_version') AS server_version
       FROM pg_roles r WHERE r.rolname = session_user`,
  )).rows[0];
  if (!login || login.session_user !== "zs_migrator" || login.rolsuper || login.rolbypassrls)
    throw new Error("Refusing to run: the migrator login must be zs_migrator without superuser or BYPASSRLS");
  if (login.member_of.some((role) => !["zs_dispatcher", "zs_function_owner", "zs_rate_limiter"].includes(role)))
    throw new Error("Refusing to run: zs_migrator belongs to an unexpected role");
  return login;
}

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);
const describeError = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));

/**
 * The hosted migrate flow behind src/scripts/hosted-migrate.ts. --dry-run prints what would
 * apply. --apply reserves the receipt ("wx") before it touches the database, then always
 * writes the outcome there: result, the phase that failed, the redacted error, and whether
 * anything committed (false before the apply phase; read back from the ledger after it).
 */
export async function runHostedMigrate(mode: HostedMigrateMode, deps: HostedMigrateDeps): Promise<void> {
  const startedAt = deps.clock.now().toISOString();
  if (mode.mode === "dry-run") {
    const login = await checkLogin(deps.pool);
    const before = await readLedger(deps.pool);
    const pending = await deps.migrate({ dryRun: true });
    if ((await readLedger(deps.pool)).length !== before.length) throw new Error("Dry run changed schema_migrations; stopping");
    deps.log(JSON.stringify({ mode: "dry-run", startedAt, target: deps.target, login, before: names(before), pending, result: "rolled back" }, null, 2));
    return;
  }

  // An existing file or a missing folder fails here, before any database work.
  const receiptFile: FileHandle = await open(mode.receiptPath, "wx");
  const receipt: Record<string, unknown> = { mode: "apply", startedAt, target: deps.target };
  let phase: MigratePhase = "login-check";
  let failure: unknown;
  let before: LedgerEntry[] = [];
  let pending: MigrationRecord[] = [];
  try {
    receipt.login = await checkLogin(deps.pool);
    before = await readLedger(deps.pool);
    receipt.kind = before.length === 0 ? "fresh-install" : "upgrade";
    receipt.before = names(before);

    phase = "dry-run";
    pending = await deps.migrate({ dryRun: true });
    receipt.pending = pending;
    if ((await readLedger(deps.pool)).length !== before.length) throw new Error("Dry run changed schema_migrations; stopping");
    receipt.dryRun = { result: "rolled back", migrations: names(pending) };

    phase = "backup-check";
    receipt.backup = { file: mode.backupPath, ...(await deps.checkBackup(mode.backupPath, before, await currentTables(deps.pool))) };

    phase = "apply";
    // migrate() rolls back unless it applies exactly what the dry run reported.
    receipt.applied = names(await deps.migrate({ expect: pending }));
    phase = "ledger-check";
  } catch (error) {
    failure = error;
  }

  // Nothing can commit before the apply phase. From it on the ledger is the evidence, also
  // when a COMMIT reply was lost: the migrations run in one transaction, so it holds either
  // none or all of them.
  let committed: boolean | "unknown" = false;
  if (phase === "apply" || phase === "ledger-check") {
    const expected = [...names(before), ...names(pending)].sort();
    try {
      const after = names(await readLedger(deps.pool));
      receipt.after = after;
      const same = (list: string[]) => JSON.stringify(after) === JSON.stringify(list);
      committed = same(names(before)) ? false : same(expected) ? true : "unknown";
    } catch (error) {
      receipt.after = `unreadable: ${describeError(error)}`;
      committed = failure ? "unknown" : true;
      if (!failure) {
        failure = error;
        phase = "ledger-check";
      }
    }
  }
  receipt.committed = committed;
  receipt.result = failure ? "failed" : "committed";
  if (failure) {
    receipt.failedPhase = phase;
    receipt.error = describeError(failure);
  }
  receipt.finishedAt = deps.clock.now().toISOString();
  try {
    await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  } catch (error) {
    // Print the receipt so the evidence is not lost.
    deps.logError(JSON.stringify({ receiptWriteFailed: describeError(error), receipt }, null, 2));
    failure ??= error;
  } finally {
    await receiptFile.close().catch(() => undefined);
  }
  if (failure) throw failure;
  deps.log(JSON.stringify({ kind: receipt.kind, applied: receipt.applied, receipt: mode.receiptPath }, null, 2));
}
