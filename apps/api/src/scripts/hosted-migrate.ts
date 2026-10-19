// Entry point, owner-run: apply supabase/migrations to one hosted Supabase project as the
// restricted zs_migrator login (supabase/hosted/bootstrap-roles.sql creates it).
//   ZS_TARGET_REF            the project ref; the URL must name it
//   MIGRATOR_DATABASE_URL    zs_migrator.<ref> on the session pooler (port 5432), no query string
// Modes:
//   --dry-run                                   run every pending migration, then roll back
//   --apply --backup <file> --receipt <file>    dry run, then apply; --backup is a pg_dump -Fc
//                                               of this project taken within the last two hours
//                                               (pg_restore must read all of it, every table in
//                                               public and zs_internal with its data), recorded
//                                               by size and sha256; --receipt must not exist yet
//                                               and afterwards always records the outcome
//   --migrations <dir>                          another directory (staged upgrade rehearsal)
// Output and the receipt hold names, checksums and role facts only, never credentials.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { migrate } from "@zs/db";
import { assertHostedDatabaseUrl, describeHosted, hostedPool } from "../hosted.js";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    backup: { type: "string" },
    receipt: { type: "string" },
    migrations: { type: "string" },
  },
});
if (values["dry-run"] === values.apply) throw new Error("Pass exactly one of --dry-run or --apply");
if (values.apply && (!values.backup || !values.receipt)) throw new Error("--apply needs --backup <file> and --receipt <file>");

const target = assertHostedDatabaseUrl(process.env.MIGRATOR_DATABASE_URL ?? "", {
  projectRef: process.env.ZS_TARGET_REF ?? "", role: "zs_migrator",
});
const directory = values.migrations
  ? pathToFileURL(resolve(values.migrations) + "/")
  : new URL("../../../../supabase/migrations/", import.meta.url);
const pool = hostedPool(target, 1);
const run = promisify(execFile);

/**
 * The backup must be a custom-format archive that pg_restore reads end to end (a truncated
 * file fails), made within the last two hours, hold the definition and data of every table
 * now in public and zs_internal, and for an upgrade hold the migration ledger at the state
 * being upgraded. The dump cannot prove which project it came from; name it with the ref
 * and keep it next to the receipt.
 */
async function checkBackup(path: string, appliedBefore: string[], tables: string[]): Promise<{ bytes: number; sha256: string; createdAt: string; tables: number }> {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString("latin1") !== "PGDMP") throw new Error("Refusing to apply: the backup is not a pg_dump -Fc archive");
  const restore = process.env.PG_RESTORE ?? "pg_restore";
  await run(restore, ["--file=/dev/null", path], { maxBuffer: 1 << 20 });
  const { stdout: toc } = await run(restore, ["--list", path], { maxBuffer: 16 << 20 });
  const created = /^;\s+Archive created at (.+)$/m.exec(toc)?.[1]?.trim() ?? "";
  // pg_dump writes the client's local time and a zone name; run both on the same machine.
  const createdAt = new Date(created.replace(/ [A-Za-z]+$/, ""));
  const age = Date.now() - createdAt.getTime();
  if (Number.isNaN(age) || age < -60_000 || age > 2 * 3600_000)
    throw new Error(`Refusing to apply: the backup must be made within the last two hours (archive created at ${created || "unknown"})`);
  const missing = tables.filter((table) => !toc.includes(` TABLE ${table} `) || !toc.includes(` TABLE DATA ${table} `));
  if (missing.length > 0)
    throw new Error(`Refusing to apply: the backup lacks the definition or data of ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
  if (appliedBefore.length > 0) {
    // The archive's migration ledger must match this database's, name for name.
    const { stdout: data } = await run(restore, ["--data-only", "--schema=zs_internal", "--table=schema_migrations", "--file=-", path],
      { maxBuffer: 1 << 20 });
    const ledger = data.split("\n").filter((line) => /^\d{14}_[a-z0-9_]+\.sql\t/.test(line)).map((line) => line.split("\t")[0]).sort();
    if (JSON.stringify(ledger) !== JSON.stringify(appliedBefore))
      throw new Error("Refusing to apply: the backup's migration ledger does not match this database");
  }
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: createdAt.toISOString(), tables: tables.length };
}

/** Ordinary tables in the schemas the backup must cover, as "schema name" (pg_restore --list style). */
async function currentTables(): Promise<string[]> {
  return (await pool.query<{ table: string }>(
    `SELECT n.nspname || ' ' || c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'zs_internal') AND c.relkind = 'r' ORDER BY 1`)).rows.map((row) => row.table);
}

async function appliedMigrations(): Promise<{ name: string; checksum: string }[]> {
  const exists = (await pool.query<{ ok: boolean }>("SELECT to_regclass('zs_internal.schema_migrations') IS NOT NULL AS ok")).rows[0]?.ok;
  if (!exists) return [];
  return (await pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM zs_internal.schema_migrations ORDER BY name")).rows;
}

try {
  const login = (await pool.query<{
    session_user: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean;
    member_of: string[]; server_version: string;
  }>(
    `SELECT session_user::text, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
            coalesce((SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m
              JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '{}') AS member_of,
            current_setting('server_version') AS server_version
       FROM pg_roles r WHERE r.rolname = session_user`,
  )).rows[0];
  if (!login || login.session_user !== "zs_migrator" || login.rolsuper || login.rolbypassrls)
    throw new Error("Refusing to run: the migrator login must be zs_migrator without superuser or BYPASSRLS");
  if (login.member_of.some((role) => !["zs_dispatcher", "zs_function_owner"].includes(role)))
    throw new Error("Refusing to run: zs_migrator belongs to an unexpected role");

  const before = await appliedMigrations();
  const startedAt = new Date().toISOString();
  const dryRun = await migrate(pool, directory, { dryRun: true });
  const afterDryRun = await appliedMigrations();
  if (afterDryRun.length !== before.length) throw new Error("Dry run changed schema_migrations; stopping");
  const facts = { target: describeHosted(target), login, before: before.map((row) => row.name), pending: dryRun };

  if (values["dry-run"]) {
    console.log(JSON.stringify({ mode: "dry-run", startedAt, ...facts, result: "rolled back" }, null, 2));
  } else {
    const backupPath = resolve(values.backup!);
    const backup = await checkBackup(backupPath, before.map((row) => row.name), await currentTables());
    // Reserve the receipt before anything commits: an existing file or a missing folder
    // fails here. From then on the file always ends up holding what happened.
    const receiptPath = resolve(values.receipt!);
    const receiptFile = await open(receiptPath, "wx");
    const outcome: Record<string, unknown> = {};
    let failure: unknown;
    try {
      // migrate() rolls back unless it applies exactly what the dry run reported.
      outcome.applied = await migrate(pool, directory, { expect: dryRun });
      outcome.result = "committed";
    } catch (error) {
      failure = error;
      outcome.result = "failed";
      outcome.error = String(error);
    }
    // The ledger afterwards is the evidence, also when a COMMIT reply was lost: the
    // migrations run in one transaction, so it holds either none or all of them.
    const expected = [...before.map((row) => row.name), ...dryRun.map((row) => row.name)].sort();
    try {
      const after = (await appliedMigrations()).map((row) => row.name);
      outcome.after = after;
      const same = (names: string[]) => JSON.stringify(after) === JSON.stringify(names);
      outcome.committed = same(before.map((row) => row.name)) ? false : same(expected) ? true : "unknown";
    } catch (error) {
      outcome.after = `unreadable: ${String(error)}`;
      outcome.committed = failure ? "unknown" : true;
      failure ??= error;
    }
    const receipt = {
      kind: before.length === 0 ? "fresh-install" : "upgrade",
      mode: "apply",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...facts,
      dryRun: { result: "rolled back", migrations: dryRun.map((row) => row.name) },
      backup: { file: backupPath, ...backup },
      ...outcome,
    };
    try {
      await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    } catch (error) {
      // Print the receipt so the evidence is not lost.
      console.error(JSON.stringify({ receiptWriteFailed: String(error), receipt }, null, 2));
      failure ??= error;
    } finally {
      await receiptFile.close().catch(() => undefined);
    }
    if (failure) throw failure;
    console.log(JSON.stringify({ kind: receipt.kind, applied: dryRun.map((row) => row.name), receipt: receiptPath }, null, 2));
  }
} finally {
  await pool.end();
}
