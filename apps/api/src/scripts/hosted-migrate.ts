// Entry point, owner-run: apply supabase/migrations to one hosted Supabase project as the
// restricted zs_migrator login (supabase/hosted/bootstrap-roles.sql creates it).
//   ZS_TARGET_REF            the project ref; the URL must name it
//   MIGRATOR_DATABASE_URL    zs_migrator.<ref> on the session pooler (port 5432), no query string
// Modes:
//   --dry-run                                   run every pending migration, then roll back
//   --apply --backup <file> --receipt <file>    dry run, then apply; <file> is a pg_dump taken
//                                               just before, recorded by size and sha256
//   --migrations <dir>                          another directory (staged upgrade rehearsal)
// Output and the receipt hold names, checksums and role facts only, never credentials.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
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
    const backupBytes = (await stat(backupPath)).size;
    if (backupBytes === 0) throw new Error("Refusing to apply: the backup file is empty");
    const backupSha256 = createHash("sha256").update(await readFile(backupPath)).digest("hex");
    const applied = await migrate(pool, directory);
    const after = await appliedMigrations();
    if (JSON.stringify(applied) !== JSON.stringify(dryRun))
      throw new Error("Applied set differs from the dry run; inspect zs_internal.schema_migrations");
    const receipt = {
      kind: before.length === 0 ? "fresh-install" : "upgrade",
      mode: "apply",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...facts,
      dryRun: { result: "rolled back", migrations: dryRun.map((row) => row.name) },
      backup: { file: backupPath, bytes: backupBytes, sha256: backupSha256 },
      applied,
      after: after.map((row) => row.name),
    };
    await writeFile(resolve(values.receipt!), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ kind: receipt.kind, applied: applied.map((row) => row.name), receipt: resolve(values.receipt!) }, null, 2));
  }
} finally {
  await pool.end();
}
