import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { z } from "zod";

/** One row of zs_internal.schema_migrations. */
export interface LedgerEntry {
  readonly name: string;
  readonly checksum: string;
}
export interface BackupFacts {
  bytes: number;
  sha256: string;
  createdAt: string;
  tables: number;
  manifest: { projectRef: string; createdAt: string; ledger: number };
}
/** Runs a program with its own environment; the default wraps execFile. */
export type RunProgram = (file: string, args: string[], options: { env?: Record<string, string>; maxBuffer: number }) => Promise<{ stdout: string }>;

export const MANIFEST_FORMAT = "zs-backup-manifest/1";
/** A backup older than this cannot gate an apply. */
export const MAX_BACKUP_AGE_MS = 2 * 3600_000;
const FUTURE_SLACK_MS = 60_000;

const manifestSchema = z.strictObject({
  format: z.literal(MANIFEST_FORMAT),
  projectRef: z.string().regex(/^[a-z]{20}$/),
  archive: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  ledger: z.array(z.strictObject({ name: z.string(), checksum: z.string() })),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const defaultRun: RunProgram = async (file, args, options) => {
  const { stdout } = await promisify(execFile)(file, args, { ...options, encoding: "utf8" });
  return { stdout };
};

function refuse(reason: string): never {
  throw new Error(`Refusing to apply: ${reason}`);
}

export const manifestPathFor = (archivePath: string) => `${archivePath}.manifest.json`;
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sameLedger = (a: readonly LedgerEntry[], b: readonly LedgerEntry[]) => {
  const key = (rows: readonly LedgerEntry[]) => JSON.stringify([...rows].map(({ name, checksum }) => [name, checksum]).sort());
  return key(a) === key(b);
};

/** The migration ledger, empty before the first migration. */
export async function readLedger(pool: Pick<Pool, "query">): Promise<LedgerEntry[]> {
  const exists = (await pool.query<{ ok: boolean }>("SELECT to_regclass('zs_internal.schema_migrations') IS NOT NULL AS ok")).rows[0]?.ok;
  if (!exists) return [];
  return (await pool.query<LedgerEntry>("SELECT name, checksum FROM zs_internal.schema_migrations ORDER BY name")).rows;
}

/** Ordinary tables in the schemas the backup must cover, as "schema name" (pg_restore --list style). */
export async function currentTables(pool: Pick<Pool, "query">): Promise<string[]> {
  return (await pool.query<{ table: string }>(
    `SELECT n.nspname || ' ' || c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'zs_internal') AND c.relkind = 'r' ORDER BY 1`)).rows.map((row) => row.table);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export interface TakeBackupOptions {
  /** A pool on the same login and project as `connection`, to read the ledger. */
  readonly pool: Pick<Pool, "query">;
  readonly connection: { host: string; port: string; user: string; password: string; database: string };
  /** The pinned CA file for sslmode=verify-full; null only for a loopback rehearsal. */
  readonly rootCertFile: string | null;
  readonly projectRef: string;
  readonly out: string;
  readonly clock: { now(): Date };
  readonly pgDump?: string | undefined;
  /** PATH for finding pg_dump (and libpq's helpers); the only inherited variable. */
  readonly searchPath?: string | undefined;
  readonly run?: RunProgram;
}

/**
 * pg_dump -Fc of public, zs_internal and extensions into `out`, then `<out>.manifest.json`
 * binding the archive to the project it was read from: ref, size, sha256, start time and the
 * full migration ledger. The ledger is read before and after the dump and must not move.
 * Credentials reach pg_dump only through its own environment (PATH and PG* only, so no
 * ambient PGSERVICE or PGSSLMODE applies),
 * never argv; neither file may exist yet.
 */
export async function takeBackup(options: TakeBackupOptions): Promise<BackupManifest> {
  const manifestPath = manifestPathFor(options.out);
  if ((await exists(options.out)) || (await exists(manifestPath)))
    throw new Error("Refusing to back up: the archive or its manifest already exists; pick a new name");
  const createdAt = options.clock.now();
  const before = await readLedger(options.pool);
  const { host, port, user, password, database } = options.connection;
  const env: Record<string, string> = {
    ...(options.searchPath === undefined ? {} : { PATH: options.searchPath }),
    PGHOST: host, PGPORT: port, PGUSER: user, PGPASSWORD: password, PGDATABASE: database,
    ...(options.rootCertFile === null ? { PGSSLMODE: "disable" } : { PGSSLMODE: "verify-full", PGSSLROOTCERT: options.rootCertFile }),
  };
  await (options.run ?? defaultRun)(options.pgDump ?? "pg_dump", [
    "--format=custom", "--no-password", "--schema=public", "--schema=zs_internal", "--schema=extensions", `--file=${options.out}`,
  ], { env, maxBuffer: 1 << 20 });
  const after = await readLedger(options.pool);
  if (!sameLedger(before, after)) throw new Error("Refusing to back up: the migration ledger changed during the dump; take a new backup");
  const bytes = await readFile(options.out);
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    projectRef: options.projectRef,
    archive: basename(options.out),
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    createdAt: createdAt.toISOString(),
    ledger: before.map(({ name, checksum }) => ({ name, checksum })),
  };
  const file = await open(manifestPath, "wx");
  try {
    await file.writeFile(JSON.stringify(manifest, null, 2) + "\n");
  } finally {
    await file.close();
  }
  return manifest;
}

/**
 * The manifest next to the archive must name this project, this exact file (sha256 and
 * size), a start time within MAX_BACKUP_AGE_MS, and the live ledger, name and checksum.
 * A dump of another project with the same tables and ledger therefore never passes.
 */
export async function verifyBackupManifest(
  archivePath: string,
  archive: Buffer,
  expected: { projectRef: string; ledger: readonly LedgerEntry[]; now: Date },
): Promise<BackupManifest> {
  const manifestPath = manifestPathFor(archivePath);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    refuse(`the backup has no manifest (${basename(manifestPath)}); take it with db:hosted-backup`);
  }
  let parsed: ReturnType<typeof manifestSchema.safeParse>;
  try {
    parsed = manifestSchema.safeParse(JSON.parse(text));
  } catch {
    refuse("the backup manifest is not JSON");
  }
  if (!parsed.success) refuse("the backup manifest is malformed");
  const manifest = parsed.data;
  if (manifest.projectRef !== expected.projectRef)
    refuse(`the backup was taken from project ${manifest.projectRef}, not ZS_TARGET_REF ${expected.projectRef}`);
  if (manifest.archive !== basename(archivePath)) refuse("the backup manifest describes another archive file");
  if (manifest.bytes !== archive.length || manifest.sha256 !== sha256Hex(archive))
    refuse("the archive's sha256 does not match its manifest");
  const age = expected.now.getTime() - Date.parse(manifest.createdAt);
  if (age < -FUTURE_SLACK_MS || age > MAX_BACKUP_AGE_MS)
    refuse(`the backup must be made within the last two hours (manifest created at ${manifest.createdAt})`);
  if (!sameLedger(manifest.ledger, expected.ledger))
    refuse("the backup manifest's migration ledger does not match this database");
  return manifest;
}

export interface CheckBackupOptions {
  readonly projectRef: string;
  /** The live ledger before the apply. */
  readonly ledger: readonly LedgerEntry[];
  /** Ordinary tables now in public and zs_internal, as "schema name" (pg_restore --list style). */
  readonly tables: readonly string[];
  readonly now: Date;
  readonly pgRestore?: string | undefined;
  readonly run?: RunProgram;
}

/**
 * The backup must carry a manifest for this project (verifyBackupManifest), be a
 * custom-format archive that pg_restore reads end to end (a truncated file fails), hold the
 * definition and data of every table now in public and zs_internal, and for an upgrade hold
 * the migration ledger at the state being upgraded.
 */
export async function checkBackup(path: string, options: CheckBackupOptions): Promise<BackupFacts> {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString("latin1") !== "PGDMP") refuse("the backup is not a pg_dump -Fc archive");
  const manifest = await verifyBackupManifest(path, bytes, { projectRef: options.projectRef, ledger: options.ledger, now: options.now });
  const run = options.run ?? defaultRun;
  const restore = options.pgRestore ?? "pg_restore";
  await run(restore, ["--file=/dev/null", path], { maxBuffer: 1 << 20 });
  const { stdout: toc } = await run(restore, ["--list", path], { maxBuffer: 16 << 20 });
  const created = /^;\s+Archive created at (.+)$/m.exec(toc)?.[1]?.trim() ?? "";
  // pg_dump writes the client's local time and a zone name; run both on the same machine.
  const createdAt = new Date(created.replace(/ [A-Za-z]+$/, ""));
  const age = options.now.getTime() - createdAt.getTime();
  if (Number.isNaN(age) || age < -FUTURE_SLACK_MS || age > MAX_BACKUP_AGE_MS)
    refuse(`the backup must be made within the last two hours (archive created at ${created || "unknown"})`);
  const missing = options.tables.filter((table) => !toc.includes(` TABLE ${table} `) || !toc.includes(` TABLE DATA ${table} `));
  if (missing.length > 0)
    refuse(`the backup lacks the definition or data of ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", ..." : ""}`);
  if (options.ledger.length > 0) {
    // The archive's own ledger must match this database's too, name for name.
    const { stdout: data } = await run(restore, ["--data-only", "--schema=zs_internal", "--table=schema_migrations", "--file=-", path],
      { maxBuffer: 1 << 20 });
    const ledger = data.split("\n").filter((line) => /^\d{14}_[a-z0-9_]+\.sql\t/.test(line)).map((line) => line.split("\t")[0]).sort();
    if (JSON.stringify(ledger) !== JSON.stringify(options.ledger.map((row) => row.name).sort()))
      refuse("the backup's migration ledger does not match this database");
  }
  return {
    bytes: bytes.length, sha256: manifest.sha256, createdAt: createdAt.toISOString(), tables: options.tables.length,
    manifest: { projectRef: manifest.projectRef, createdAt: manifest.createdAt, ledger: manifest.ledger.length },
  };
}
