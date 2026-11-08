import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { assertLocalDatabaseUrl, assertRuntimeLogin, createScopedDatabase, type Transaction } from "@zs/db";
import { readBackupManifest, type LedgerEntry } from "./hosted-backup.js";
import { resolvePgTool } from "./pg-tools.js";

/**
 * Recovery proof: restore one db:hosted-backup archive into a new, throwaway database on a
 * loopback cluster and prove it is usable. Never a hosted database: the admin URL must be
 * loopback (assertLocalDatabaseUrl), and the database is always a new zs_restore_proof_* name.
 * Checks: the archive matches its manifest, pg_restore exits 0 in one transaction, the restored
 * ledger equals the manifest's, every table holds exactly the rows the archive carries, every
 * tenant table forces RLS with its policies, the runtime login is unprivileged and reaches the
 * tenant tables, and two tenants cannot read or change each other's rows under the runtime role.
 */

export interface RunResult { code: number; stdout: string; stderr: string }
export type RunTool = (file: string, args: string[], env: Record<string, string>) => Promise<RunResult>;

const defaultRun: RunTool = async (file, args, env) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, { env, encoding: "utf8", maxBuffer: 512 << 20 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message ?? "" };
  }
};

/** Rows per table in a plain-SQL data dump (`pg_restore --data-only --file=-`): one line per row in each COPY block. */
export function countCopyRows(dataSql: string): Map<string, number> {
  const counts = new Map<string, number>();
  let current: string | null = null;
  for (const line of dataSql.split("\n")) {
    if (current === null) {
      const copy = /^COPY ((?:"[^"]+"|[a-z_][a-z0-9_$]*)\.(?:"[^"]+"|[a-z_][a-z0-9_$]*)) (?:\(.*\) )?FROM stdin;$/.exec(line);
      if (copy) {
        current = copy[1]!.replaceAll('"', "");
        counts.set(current, 0);
      }
    } else if (line === "\\.") {
      current = null;
    } else {
      counts.set(current, counts.get(current)! + 1);
    }
  }
  if (current !== null) throw new Error(`The data dump ends inside the COPY block of ${current}`);
  return counts;
}

const BUILT_IN = new Set(["public", "current_user", "session_user", "current_role", "pg_database_owner"]);
const roleList = (text: string) => text.split(",").map((name) => name.trim().replaceAll('"', ""))
  .filter((name) => name.length > 0 && !BUILT_IN.has(name.toLowerCase()) && !name.startsWith("pg_"));

/**
 * Roles a schema dump (`pg_restore --schema-only --file=-`) names as owner, grantee, default
 * privilege owner or policy target. pg_dump writes these statements in upper case at the start
 * of a line, which keeps lower-case GRANTs inside function bodies out.
 */
export function referencedRoles(schemaSql: string): string[] {
  const roles = new Set<string>();
  const patterns = [
    /^ALTER [A-Z ]+ .* OWNER TO ([^;]+);$/gm,
    /^GRANT .* TO ([^;]+?)(?: WITH GRANT OPTION| WITH ADMIN OPTION)?;$/gm,
    /^REVOKE .* FROM ([^;]+);$/gm,
    /^ALTER DEFAULT PRIVILEGES FOR ROLE ([^ ]+) /gm,
    /^CREATE POLICY .*? TO ((?:"[^"]+"|[a-z_][a-z0-9_]*)(?:, (?:"[^"]+"|[a-z_][a-z0-9_]*))*)(?: USING| WITH CHECK|;|$)/gm,
  ];
  for (const pattern of patterns) for (const match of schemaSql.matchAll(pattern)) for (const role of roleList(match[1]!)) roles.add(role);
  return [...roles].sort();
}

/** The major version of the pg_dump that wrote a plain-SQL dump, from its header; null when absent. */
export function archiveDumpMajor(sql: string): number | null {
  const match = /^-- Dumped by pg_dump version (\d+)/m.exec(sql);
  return match ? Number(match[1]) : null;
}

export const countPolicies = (schemaSql: string) => (schemaSql.match(/^CREATE POLICY /gm) ?? []).length;

export interface CheckResult { name: string; ok: boolean; detail: unknown }
export interface ArchiveFacts {
  readonly ledger: readonly LedgerEntry[];
  /** "schema.table" -> rows in the archive. */
  readonly rows: ReadonlyMap<string, number>;
  readonly policies: number;
}

type ProbeOut = Record<"ownVisible" | "foreignVisible" | "foreignWrites", Record<string, number | string>>;
class RolledBack extends Error {
  constructor(readonly out: ProbeOut) {
    super("restore proof probe rolled back");
  }
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const qualified = (table: string) => table.split(".").map(ident).join(".");

/** Every check on a restored database. `admin` is a superuser pool on it, `runtime` the zs_runtime login. */
export async function checkRestoredDatabase(admin: Pool, runtime: Pool, archive: ArchiveFacts, now: () => number = Date.now): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail?: unknown }>) => {
    try {
      const { ok, detail } = await run();
      results.push({ name, ok, detail: detail ?? null });
    } catch (error) {
      results.push({ name, ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  await check("restored migration ledger equals the manifest's", async () => {
    const restored = (await admin.query<LedgerEntry>("SELECT name, checksum FROM zs_internal.schema_migrations ORDER BY name")).rows;
    const key = (rows: readonly LedgerEntry[]) => JSON.stringify([...rows].map((row) => [row.name, row.checksum]).sort());
    return { ok: archive.ledger.length > 0 && key(restored) === key(archive.ledger), detail: { manifest: archive.ledger.length, restored: restored.length } };
  });

  await check("every table holds exactly the rows the archive carries", async () => {
    const tables = (await admin.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'zs_internal') AND c.relkind = 'r' ORDER BY 1`)).rows.map((row) => row.table);
    const mismatches: { table: string; archive: number | null; restored: number | null }[] = [];
    let rows = 0;
    for (const table of tables) {
      const restored = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ONLY ${qualified(table)}`)).rows[0]!.n;
      rows += restored;
      const expected = archive.rows.get(table);
      if (expected !== restored) mismatches.push({ table, archive: expected ?? null, restored });
    }
    for (const table of archive.rows.keys())
      if (!tables.includes(table) && table.split(".")[0] !== "extensions") mismatches.push({ table, archive: archive.rows.get(table)!, restored: null });
    return { ok: mismatches.length === 0 && tables.length > 0, detail: { tables: tables.length, rows, mismatches } };
  });

  const tenantTables = (await admin.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 1`)).rows.map((row) => row.name);

  await check("every tenant table enables and forces RLS and has a policy; every archived policy is restored", async () => {
    const rows = (await admin.query<{ name: string; owner: string; rls: boolean; forced: boolean; policies: number }>(
      `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) ORDER BY 1`, [tenantTables])).rows;
    const restoredPolicies = (await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace IN ('public'::regnamespace, coalesce(to_regnamespace('zs_internal'), 'public'::regnamespace))`)).rows[0]!.n;
    const failing = rows.filter((row) => !row.rls || !row.forced || row.policies === 0);
    return {
      ok: rows.length === tenantTables.length && rows.length > 0 && failing.length === 0 && restoredPolicies === archive.policies,
      detail: { tenantTables: rows.length, owners: [...new Set(rows.map((row) => row.owner))], failing, policies: { archive: archive.policies, restored: restoredPolicies } },
    };
  });

  await check("runtime login is unprivileged, a member of authenticated only, and reaches the tenant tables", async () => {
    await assertRuntimeLogin(runtime);
    const row = (await runtime.query<{ member_of: string[]; usage: boolean; readable: number }>(
      `SELECT array(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid ORDER BY 1) AS member_of,
              has_schema_privilege('authenticated', 'public', 'USAGE') AS usage,
              (SELECT count(*)::int FROM unnest($1::text[]) t WHERE has_table_privilege('authenticated', 'public.' || quote_ident(t), 'SELECT')) AS readable
         FROM pg_roles r WHERE r.rolname = session_user`, [tenantTables])).rows[0]!;
    return { ok: JSON.stringify(row.member_of) === '["authenticated"]' && row.usage && row.readable > 0, detail: { ...row, tenantTables: tenantTables.length } };
  });

  // The two tenants with the most rows; a random empty tenant stands in when only one exists.
  const perTenant = new Map<string, Map<string, number>>();
  for (const table of tenantTables) {
    for (const row of (await admin.query<{ tenant_id: string; n: number }>(
      `SELECT tenant_id::text, count(*)::int AS n FROM public.${ident(table)} GROUP BY 1`)).rows) {
      if (!perTenant.has(row.tenant_id)) perTenant.set(row.tenant_id, new Map());
      perTenant.get(row.tenant_id)!.set(table, row.n);
    }
  }
  const ranked = [...perTenant.entries()].map(([id, tables]) => ({ id, rows: [...tables.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.rows - a.rows);
  const tenantA = ranked[0]?.id ?? randomUUID();
  const tenantB = ranked[1]?.id ?? randomUUID();
  const owned = (tenant: string, table: string) => perTenant.get(tenant)?.get(table) ?? 0;
  const db = createScopedDatabase(runtime);

  /** Under `self`, what the runtime sees of its own rows, and of everyone else's (must be nothing). */
  const probe = async (self: string | null, other: string): Promise<ProbeOut> => {
    const work = async (tx: Transaction): Promise<never> => {
      const out: ProbeOut = { ownVisible: {}, foreignVisible: {}, foreignWrites: {} };
      for (const table of tenantTables) {
        const attempt = async (sql: string, params: unknown[]) => {
          await tx.query("SAVEPOINT restore_probe");
          try {
            const result = await tx.query<{ n?: number }>(sql, params);
            await tx.query("RELEASE SAVEPOINT restore_probe");
            return result.rows[0]?.n ?? result.rowCount ?? 0;
          } catch (error) {
            await tx.query("ROLLBACK TO SAVEPOINT restore_probe");
            return `refused ${(error as { code?: string }).code ?? "?"}`;
          }
        };
        const t = `public.${ident(table)}`;
        if (self !== null) out.ownVisible[table] = await attempt(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [self]);
        out.foreignVisible[table] = await attempt(
          self === null ? `SELECT count(*)::int AS n FROM ${t}` : `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> $1`, self === null ? [] : [self]);
        if (owned(other, table) > 0) out.foreignWrites[table] = await attempt(`UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [other]);
      }
      // Every probe rolls back, so even a write the policies wrongly allowed changes nothing.
      throw new RolledBack(out);
    };
    try {
      await (self === null ? db.withoutTenant(work) : db.tenant(self, work));
    } catch (error) {
      if (error instanceof RolledBack) return error.out;
      throw error;
    }
    throw new Error("the probe transaction did not roll back");
  };
  const zeroOrRefused = (values: Record<string, number | string>) => Object.values(values).every((value) => value === 0 || String(value).startsWith("refused"));

  await check("two-tenant denial under the runtime role: neither tenant reads or updates the other's rows, no tenant reads nothing", async () => {
    const started = now();
    const a = await probe(tenantA, tenantB);
    const b = await probe(tenantB, tenantA);
    const none = await probe(null, tenantA);
    const ownMatches = (tenant: string, visible: Record<string, number | string>) =>
      Object.entries(visible).filter(([table, value]) => owned(tenant, table) > 0 && value === owned(tenant, table)).map(([table]) => table);
    const aOwn = ownMatches(tenantA, a.ownVisible);
    const bOwn = ownMatches(tenantB, b.ownVisible);
    // Own rows the runtime cannot read in full: tables it has no SELECT on, or whose policy is narrower than the tenant.
    const ownHidden = (tenant: string, visible: Record<string, number | string>) => Object.entries(visible)
      .filter(([table, value]) => owned(tenant, table) > 0 && value !== owned(tenant, table)).map(([table, value]) => ({ table, owned: owned(tenant, table), visible: value }));
    const denied = zeroOrRefused(a.foreignVisible) && zeroOrRefused(b.foreignVisible) && zeroOrRefused(none.foreignVisible)
      && zeroOrRefused(a.foreignWrites) && zeroOrRefused(b.foreignWrites);
    // The runtime must also see its own rows, or the denial proves nothing.
    const sees = aOwn.length > 0 && (ranked.length < 2 || bOwn.length > 0);
    const leaks = (values: Record<string, number | string>) => Object.entries(values).filter(([, value]) => value !== 0 && !String(value).startsWith("refused"));
    return {
      ok: denied && sees,
      detail: {
        tenantA: { id: tenantA, rows: ranked[0]?.rows ?? 0, ownTablesReadInFull: aOwn.length, ownNotReadInFull: ownHidden(tenantA, a.ownVisible) },
        tenantB: { id: tenantB, rows: ranked[1]?.rows ?? 0, ownTablesReadInFull: bOwn.length, ownNotReadInFull: ownHidden(tenantB, b.ownVisible), synthetic: ranked.length < 2 },
        tablesProbed: tenantTables.length,
        foreignWriteProbes: Object.keys(a.foreignWrites).length + Object.keys(b.foreignWrites).length,
        leaks: { aSeesOthers: leaks(a.foreignVisible), bSeesOthers: leaks(b.foreignVisible), noTenantSees: leaks(none.foreignVisible),
          aUpdatesB: leaks(a.foreignWrites), bUpdatesA: leaks(b.foreignWrites) },
        ms: now() - started,
      },
    };
  });
  return results;
}

export interface RestoreProofOptions {
  readonly archivePath: string;
  /** Superuser URL of the loopback cluster's maintenance database, for example postgres://postgres@127.0.0.1:55433/postgres. */
  readonly adminUrl: string;
  readonly clock: { now(): Date };
  readonly pgRestore?: string | undefined;
  readonly searchPath?: string | undefined;
  /** Leave the restored database in place for inspection. */
  readonly keep?: boolean;
  readonly run?: RunTool;
}
export interface RestoreProofReport {
  ok: boolean;
  archive: string;
  bytes: number;
  sha256: string;
  manifest: { projectRef: string; createdAt: string; ledger: number };
  database: string;
  roles: { referenced: string[]; created: string[] };
  restore: { tool: string; exitCode: number; stderr: string };
  checks: CheckResult[];
  dropped: boolean;
}

/** Restore `archivePath` into a new zs_restore_proof_* database, check it, then drop it. */
export async function restoreProof(options: RestoreProofOptions): Promise<RestoreProofReport> {
  const target = assertLocalDatabaseUrl(options.adminUrl);
  if (target.database !== "postgres") throw new Error("Refusing to run: the admin URL must name the cluster's postgres database");
  const run = options.run ?? defaultRun;
  const tool = options.pgRestore ?? resolvePgTool("pg_restore");
  const bytes = await readFile(options.archivePath);
  if (bytes.subarray(0, 5).toString("latin1") !== "PGDMP") throw new Error("Refusing to restore: not a pg_dump -Fc archive");
  const manifest = await readBackupManifest(options.archivePath, bytes);
  const toolEnv = { ...(options.searchPath === undefined ? {} : { PATH: options.searchPath }) };

  const read = async (args: string[]) => {
    const result = await run(tool, [...args, options.archivePath], toolEnv);
    if (result.code !== 0) throw new Error(`pg_restore ${args.join(" ")} failed: ${result.stderr.trim().slice(0, 2000)}`);
    return result.stdout;
  };
  const schemaSql = await read(["--schema-only", "--file=-"]);
  const rows = countCopyRows(await read(["--data-only", "--file=-"]));
  const archive: ArchiveFacts = { ledger: manifest.ledger, rows, policies: countPolicies(schemaSql) };
  const referenced = referencedRoles(schemaSql);

  const stamp = options.clock.now().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const database = `zs_restore_proof_${stamp}_${randomUUID().slice(0, 8)}`;
  const admin = new Pool({ connectionString: target.connectionString, max: 1 });
  const dbUrl = new URL(target.connectionString);
  dbUrl.pathname = `/${database}`;
  const runtimeUrl = new URL(dbUrl);
  runtimeUrl.username = "zs_runtime";
  runtimeUrl.password = "";
  const created: string[] = [];
  let createdDb = false;
  let dropped = false;
  const report: Omit<RestoreProofReport, "ok" | "checks" | "dropped" | "restore"> = {
    archive: basename(options.archivePath), bytes: bytes.length, sha256: manifest.sha256,
    manifest: { projectRef: manifest.projectRef, createdAt: manifest.createdAt, ledger: manifest.ledger.length },
    database, roles: { referenced, created },
  };
  try {
    const superuser = (await admin.query<{ su: boolean }>("SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user")).rows[0]?.su;
    if (!superuser) throw new Error("Refusing to run: the admin URL must log in as a superuser of the throwaway cluster");
    // An archive written by a newer pg_dump carries settings an older server rejects
    // (pg_dump 17 writes SET transaction_timeout), so restore only into the same major or newer.
    const serverMajor = Math.floor(Number((await admin.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10000);
    const dumpMajor = archiveDumpMajor(schemaSql);
    if (dumpMajor !== null && dumpMajor > serverMajor)
      throw new Error(`Refusing to restore: the archive was written by pg_dump ${dumpMajor}; restore it into PostgreSQL ${dumpMajor} or newer, not ${serverMajor}`);
    const client = await admin.connect();
    try {
      // Cluster roles are shared; serialize with other runs, as the test harness does.
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zs-business:test-logins',0))");
      for (const role of referenced) {
        const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
        if (exists) continue;
        await client.query(`CREATE ROLE ${ident(role)} NOLOGIN`);
        created.push(role);
      }
      // bootstrap-roles.sql: zs_runtime is a LOGIN member of authenticated only.
      if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'zs_runtime'")).rowCount) {
        await client.query("CREATE ROLE zs_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
        created.push("zs_runtime");
      }
      await client.query("GRANT authenticated TO zs_runtime");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await admin.query(`CREATE DATABASE ${ident(database)} TEMPLATE template0`);
    createdDb = true;
    // pg_dump --schema=public writes CREATE SCHEMA public (with its owner and ACL), which fails
    // on the empty public schema every new database has. The database is new, so drop it first.
    const fresh = new Pool({ connectionString: dbUrl.href, max: 1 });
    try {
      await fresh.query("DROP SCHEMA public");
    } finally {
      await fresh.end();
    }

    const restore = await run(tool, [
      "--exit-on-error", "--single-transaction", "--no-password", `--dbname=${database}`, options.archivePath,
    ], { ...toolEnv, PGHOST: target.host, PGPORT: target.port, PGUSER: target.user, PGPASSWORD: dbUrl.password ? decodeURIComponent(dbUrl.password) : "", PGSSLMODE: "disable" });
    const restoreFacts = { tool, exitCode: restore.code, stderr: restore.stderr.trim().slice(0, 4000) };
    let checks: CheckResult[] = [{ name: "pg_restore exits 0 in one transaction", ok: restore.code === 0, detail: restoreFacts.stderr || null }];
    if (restore.code === 0) {
      const dbPool = new Pool({ connectionString: dbUrl.href, max: 2 });
      const runtimePool = new Pool({ connectionString: runtimeUrl.href, max: 2 });
      // DROP DATABASE ... WITH (FORCE) can reach a backend whose ended client is still closing;
      // pg-pool re-emits that 57P01 on the pool, and an unhandled pool error crashes the run.
      for (const pool of [dbPool, runtimePool]) pool.on("error", (error: Error & { code?: string }) => {
        if (error.code !== "57P01") throw error;
      });
      try {
        checks = checks.concat(await checkRestoredDatabase(dbPool, runtimePool, archive, () => options.clock.now().getTime()));
      } finally {
        await Promise.all([dbPool.end(), runtimePool.end()]);
      }
    }
    if (!options.keep) {
      // Let the ended pools' backends exit before forcing the drop.
      for (let i = 0; i < 100; i += 1) {
        const left = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [database])).rows[0]!.n;
        if (left === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await admin.query(`DROP DATABASE ${ident(database)} WITH (FORCE)`);
      dropped = true;
    }
    return { ...report, ok: checks.every((item) => item.ok), restore: restoreFacts, checks, dropped };
  } catch (error) {
    if (createdDb && !options.keep && !dropped) await admin.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`).catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
}
