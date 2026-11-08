import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testAdminUrl, type TestDatabase } from "@zs/db/testing";
import { BACKUP_EXTENSIONS, MANIFEST_FORMAT, readLedger, takeBackup } from "../src/hosted-backup.js";
import { archiveDumpMajor, checkRestoredDatabase, countCopyRows, countPolicies, referencedRoles, restoreProof, scrubOutput, type RunTool } from "../src/restore-proof.js";
import { resolvePgTool } from "../src/pg-tools.js";

const REF = "prodprodprodprodprod";
const majorOfTool = (tool: "pg_dump" | "pg_restore") => {
  try {
    return Number(/(\d+)\./.exec(execFileSync(resolvePgTool(tool), ["--version"], { encoding: "utf8" }))?.[1] ?? NaN);
  } catch {
    return null;
  }
};
/** The majors of the pg_dump and pg_restore the code would use, or null when the client tools are missing. */
const dumpMajor = majorOfTool("pg_dump");
const restoreMajor = majorOfTool("pg_restore");
const toolsPresent = dumpMajor !== null && restoreMajor !== null;

describe("archive parsing", () => {
  it("counts COPY rows per table, empty tables included", () => {
    const sql = [
      "SET statement_timeout = 0;",
      "COPY public.crm_contacts (tenant_id, id) FROM stdin;", "a\t1", "a\t2", "\\.",
      "COPY zs_internal.schema_migrations (name, checksum) FROM stdin;", "\\.",
      'COPY public."Odd" (x) FROM stdin;', "v", "\\.",
    ].join("\n");
    expect(Object.fromEntries(countCopyRows(sql))).toEqual({ "public.crm_contacts": 2, "zs_internal.schema_migrations": 0, "public.Odd": 1 });
    expect(() => countCopyRows("COPY public.t (x) FROM stdin;\nrow")).toThrow(/ends inside/);
  });
  it("finds owners, grantees and policy roles, but not lower-case grants in function bodies", () => {
    const sql = [
      "ALTER TABLE public.t OWNER TO zs_migrator;",
      "ALTER FUNCTION extensions.f() OWNER TO supabase_admin;",
      "GRANT SELECT ON TABLE public.t TO authenticated;",
      "GRANT ALL ON SCHEMA public TO zs_migrator WITH GRANT OPTION;",
      "REVOKE ALL ON TABLE public.t FROM PUBLIC;",
      "REVOKE ALL ON FUNCTION public.f() FROM anon;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON TABLES TO postgres;",
      "CREATE POLICY p ON public.t FOR SELECT TO authenticated, \"Odd Role\" USING ((tenant_id = x));",
      "CREATE POLICY q ON public.t TO zs_dispatcher",
      "    grant usage on schema graphql to secret_body_role;",
    ].join("\n");
    expect(referencedRoles(sql)).toEqual(["Odd Role", "anon", "authenticated", "supabase_admin", "zs_dispatcher", "zs_migrator"].sort());
    expect(countPolicies(sql)).toBe(2);
  });
  it("reads the pg_dump major from the dump header", () => {
    expect(archiveDumpMajor("--\n-- Dumped from database version 17.11\n-- Dumped by pg_dump version 17.11 (Homebrew)\n")).toBe(17);
    expect(archiveDumpMajor("SET x = 1;")).toBeNull();
  });
  it("keeps secrets and quoted production rows out of tool output", () => {
    const text = [
      "pg_restore: error: could not execute query: ERROR:  null value in column \"x\" violates not-null constraint",
      "DETAIL:  Failing row contains (a1, jane@example.com).",
      "CONTEXT:  COPY crm_contacts, line 3: \"jane@example.com\"",
      "Command was: INSERT INTO public.t VALUES ('jane@example.com');",
      "connect postgres://u:secret@db.example.com/postgres failed",
    ].join("\n");
    const out = scrubOutput(text);
    expect(out).toContain("violates not-null constraint");
    expect(out).not.toMatch(/jane|secret|DETAIL|CONTEXT|Command was/);
  });
});

describe("every extension the migrations create is in the backup", () => {
  it("lists each CREATE EXTENSION of supabase/migrations in BACKUP_EXTENSIONS", async () => {
    const dir = new URL("../../../supabase/migrations/", import.meta.url);
    const names = new Set<string>();
    for (const file of await readdir(dir))
      for (const match of (await readFile(new URL(file, dir), "utf8")).matchAll(/CREATE EXTENSION(?: IF NOT EXISTS)? "?([a-z0-9_-]+)"?/gi)) names.add(match[1]!);
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((name) => !(BACKUP_EXTENSIONS as readonly string[]).includes(name))).toEqual([]);
  });
});

/** A file that passes the archive checks (header, manifest) but is not a real dump; the stub `run` answers pg_restore. */
async function fakeArchive(dir: string, name: string, projectRef = REF) {
  const bytes = Buffer.concat([Buffer.from("PGDMP"), Buffer.from(name)]);
  const path = join(dir, name);
  await writeFile(path, bytes);
  await writeFile(`${path}.manifest.json`, JSON.stringify({
    format: MANIFEST_FORMAT, projectRef, archive: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    createdAt: new Date().toISOString(), ledger: [{ name: "001_x.sql", checksum: "abc" }],
  }));
  return path;
}
const header = (major: number | null) => major === null ? "SET x = 1;\n" : `-- Dumped from database version 1.0\n-- Dumped by pg_dump version ${major}.0\n`;
/** A pg_restore that reports `version` and reads an archive written by pg_dump `dump`. */
const stubRestore = (version: string, dump: number | null): RunTool => async (_file, args) => {
  if (args.includes("--version")) return { code: 0, stdout: version, stderr: "" };
  if (args.includes("--schema-only")) return { code: 0, stdout: header(dump), stderr: "" };
  if (args.includes("--data-only")) return { code: 0, stdout: "", stderr: "" };
  throw new Error("the guards must refuse before pg_restore restores anything");
};

describe("restore proof refusals (no restore runs)", () => {
  let database: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "zs-restore-proof-guard-"));
  });
  afterAll(async () => {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = { adminUrl: testAdminUrl().href, expectedProjectRef: REF, clock: { now: () => new Date() }, allowSharedCluster: true };
  const serverMajor = async () => Math.floor(Number((await database.pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10000);

  it("refuses a cluster that holds other databases unless the caller says it is shared", async () => {
    const archivePath = await fakeArchive(dir, "shared.dump");
    // This suite's own zs_test_* database is on the cluster, so it is not a throwaway.
    await expect(restoreProof({ ...base, allowSharedCluster: false, archivePath, run: stubRestore("pg_restore (PostgreSQL) 1.0", 1) }))
      .rejects.toThrow(/cluster is not a throwaway; it also holds .*zs_test_/);
  });
  it("refuses a pg_restore newer than the server, and one whose version it cannot read", async () => {
    const archivePath = await fakeArchive(dir, "client.dump");
    const server = await serverMajor();
    await expect(restoreProof({ ...base, archivePath, run: stubRestore(`pg_restore (PostgreSQL) ${server + 1}.0`, server) }))
      .rejects.toThrow(new RegExp(`pg_restore ${server + 1} is newer than the PostgreSQL ${server} server`));
    await expect(restoreProof({ ...base, archivePath, run: stubRestore("garbage", server) })).rejects.toThrow(/version of pg_restore/);
  });
  it("refuses an archive from a newer pg_dump, and one that does not name its pg_dump", async () => {
    const archivePath = await fakeArchive(dir, "dumped.dump");
    const server = await serverMajor();
    await expect(restoreProof({ ...base, archivePath, run: stubRestore(`pg_restore (PostgreSQL) ${server}.0`, server + 1) }))
      .rejects.toThrow(new RegExp(`written by pg_dump ${server + 1}; restore it into PostgreSQL ${server + 1} or newer, not ${server}`));
    await expect(restoreProof({ ...base, archivePath, run: stubRestore(`pg_restore (PostgreSQL) ${server}.0`, null) }))
      .rejects.toThrow(/does not name the pg_dump version/);
  });
  it("refuses an archive from another project, and a missing expected ref", async () => {
    const archivePath = await fakeArchive(dir, "other.dump", "otherotherotherother");
    await expect(restoreProof({ ...base, archivePath, run: stubRestore("pg_restore (PostgreSQL) 1.0", 1) }))
      .rejects.toThrow(/taken from project otherotherotherother, not prodprodprodprodprod/);
    await expect(restoreProof({ ...base, expectedProjectRef: "", archivePath, run: stubRestore("pg_restore (PostgreSQL) 1.0", 1) }))
      .rejects.toThrow(/pass the project ref/);
  });
});

describe("restore proof on the local cluster", () => {
  let database: TestDatabase;
  let dir: string;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "zs-restore-proof-test-"));
    await database.pool.query("INSERT INTO tenants (tenant_id, name) VALUES ($1, 'A'), ($2, 'B')", [tenantA, tenantB]);
    for (const [tenant, n] of [[tenantA, 3], [tenantB, 2]] as const)
      for (let i = 0; i < n; i += 1)
        await database.pool.query("INSERT INTO crm_contacts (tenant_id, id, display_name, created_at, updated_at) VALUES ($1, $2, $3, now(), now())", [tenant, randomUUID(), `c${i}`]);
  });
  afterAll(async () => {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });
  // The round trip needs a pg_dump of the server's own major (an older one cannot dump a newer
  // server) and a pg_restore no newer than the server. CI runs 15 and 16 servers beside a newer
  // client, so the trip is skipped there; the guards are checked above with a stub pg_restore.
  const serverMajor = async () => Math.floor(Number((await database.pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10000);
  const roundTrip = async () => toolsPresent && dumpMajor === await serverMajor() && restoreMajor! <= dumpMajor;
  const proofOptions = { expectedProjectRef: REF, adminUrl: testAdminUrl().href, clock: { now: () => new Date() }, searchPath: process.env.PATH, allowSharedCluster: true };
  const backUp = async (out: string) => {
    const url = new URL(database.url);
    await takeBackup({
      pool: database.pool,
      connection: { host: url.hostname, port: url.port, user: decodeURIComponent(url.username), password: "", database: url.pathname.slice(1) },
      rootCertFile: null, projectRef: REF, out, clock: { now: () => new Date() }, searchPath: process.env.PATH,
    });
  };

  const archiveFacts = async () => {
    const rows = new Map<string, number>();
    for (const { table } of (await database.pool.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'zs_internal') AND c.relkind = 'r'`)).rows)
      rows.set(table, (await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ONLY ${table}`)).rows[0]!.n);
    const policies = (await database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN ('public'::regnamespace, 'zs_internal'::regnamespace)")).rows[0]!.n;
    return { ledger: await readLedger(database.pool), rows, policies };
  };

  it("backs up, restores into a throwaway database, passes every check and drops it", async (context) => {
    if (!(await roundTrip())) context.skip();
    const out = join(dir, "proof.dump");
    await backUp(out);
    const report = await restoreProof({ ...proofOptions, archivePath: out });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toHaveLength(6);
    const denial = report.checks.at(-1)!.detail as { tenantA: { id: string }; tenantB: { id: string; synthetic: boolean }; unproven: { tables: number; names: string[] }; foreignDeleteProbes: number };
    expect([denial.tenantA.id, denial.tenantB.id]).toEqual([tenantA, tenantB]);
    // Only crm_contacts holds rows here, so every other tenant table is reported as unproven (not failed).
    expect(denial.unproven.tables).toBeGreaterThan(0);
    expect(denial.unproven.names).not.toContain("crm_contacts");
    expect(denial.foreignDeleteProbes).toBeGreaterThan(0);
    expect(report.dropped).toBe(true);
    const left = await database.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [report.database]);
    expect(left.rowCount).toBe(0);
  });

  it("refuses an archive whose manifest does not match it, and a non-loopback cluster", async () => {
    const dumpFile = join(dir, "manifest.dump");
    await writeFile(dumpFile, "PGDMP-original");
    await writeFile(`${dumpFile}.manifest.json`, JSON.stringify({
      format: MANIFEST_FORMAT, projectRef: REF, archive: "manifest.dump", bytes: 14, sha256: createHash("sha256").update("PGDMP-original").digest("hex"),
      createdAt: new Date().toISOString(), ledger: [],
    }));
    const copy = join(dir, "tampered.dump");
    await writeFile(copy, "PGDMP-changed!!");
    await writeFile(`${copy}.manifest.json`, (await readFile(`${dumpFile}.manifest.json`, "utf8")).replace("manifest.dump", "tampered.dump"));
    await expect(restoreProof({ ...proofOptions, archivePath: copy })).rejects.toThrow(/sha256/);
    await expect(restoreProof({ ...proofOptions, archivePath: dumpFile, adminUrl: "postgres://postgres@db.example.com:5432/postgres" }))
      .rejects.toThrow(/127\.0\.0\.1 or localhost/);
  });

  it("reports a throwaway database it cannot drop, with its name and the reason, and fails", async (context) => {
    if (!(await roundTrip())) context.skip();
    const out = join(dir, "cleanup.dump");
    await backUp(out);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    let name = "";
    // After the real pg_restore, make the database a template: Postgres refuses to drop those.
    const run: RunTool = async (file, args, env) => {
      let result: Awaited<ReturnType<RunTool>>;
      try {
        const done = await promisify(execFile)(file, args, { env, encoding: "utf8", maxBuffer: 512 << 20 });
        result = { code: 0, stdout: done.stdout, stderr: done.stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        result = { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
      }
      const dbArg = args.find((arg) => arg.startsWith("--dbname="));
      if (dbArg && result.code === 0) {
        name = dbArg.slice("--dbname=".length);
        await database.pool.query(`ALTER DATABASE "${name}" IS_TEMPLATE true`);
      }
      return result;
    };
    const report = await restoreProof({ ...proofOptions, archivePath: out, run });
    try {
      expect(report.dropped).toBe(false);
      expect(report.ok).toBe(false);
      expect(report.database).toBe(name);
      expect(report.cleanupError).toMatch(/template/i);
      expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    } finally {
      await database.pool.query(`ALTER DATABASE "${name}" IS_TEMPLATE false`);
      await database.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });

  it("fails the checks when RLS is not forced, a policy is gone, rows are missing, or a tenant sees another's rows", async () => {
    const facts = await archiveFacts();
    const failing = async () => (await checkRestoredDatabase(database.pool, database.runtimePool, facts)).filter((check) => !check.ok).map((check) => check.name);
    expect(await failing()).toEqual([]);

    await database.pool.query("ALTER TABLE crm_contacts NO FORCE ROW LEVEL SECURITY");
    expect(await failing()).toEqual([expect.stringMatching(/forces RLS/)]);
    await database.pool.query("ALTER TABLE crm_contacts FORCE ROW LEVEL SECURITY");

    await database.pool.query("DELETE FROM crm_contacts WHERE tenant_id = $1 AND display_name = 'c0'", [tenantB]);
    expect(await failing()).toEqual([expect.stringMatching(/exactly the rows/)]);

    await database.pool.query("CREATE POLICY restore_proof_leak ON crm_contacts FOR SELECT TO authenticated USING (true)");
    try {
      const names = await failing();
      expect(names).toContain("two-tenant denial under the runtime role: neither tenant reads or updates the other's rows, no tenant reads nothing");
      expect(names).toContain("every tenant table enables and forces RLS and has a policy; every archived policy is restored");
    } finally {
      await database.pool.query("DROP POLICY restore_proof_leak ON crm_contacts");
    }
  });

  it("counts any error but insufficient_privilege as a failed check, and a foreign delete or write by no tenant as a leak", async () => {
    const facts = await archiveFacts();
    const denial = async () => (await checkRestoredDatabase(database.pool, database.runtimePool, facts)).find((check) => check.name.startsWith("two-tenant denial"))!;
    expect((await denial()).ok).toBe(true);

    // With writes granted and a policy that lets every row through, each foreign probe must show as a leak.
    await database.pool.query("GRANT UPDATE, DELETE ON crm_contacts TO authenticated");
    await database.pool.query("CREATE POLICY restore_proof_leak ON crm_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true)");
    try {
      const result = await denial();
      expect(result.ok).toBe(false);
      const leaks = (result.detail as { leaks: Record<string, [string, number][]> }).leaks;
      for (const key of ["aUpdatesB", "bUpdatesA", "aDeletesB", "bDeletesA", "noTenantUpdates", "noTenantDeletes"])
        expect(leaks[key], key).toEqual([["crm_contacts", expect.any(Number)]]);

      // A write that fails for another reason than a privilege refusal is no proof of a denial.
      await database.pool.query("CREATE FUNCTION restore_proof_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
      await database.pool.query("CREATE TRIGGER restore_proof_boom BEFORE UPDATE ON crm_contacts FOR EACH ROW EXECUTE FUNCTION restore_proof_boom()");
      try {
        const errored = (await denial()).detail as { leaks: Record<string, [string, string | number][]> };
        expect(errored.leaks.aUpdatesB).toEqual([["crm_contacts", "error P0001"]]);
      } finally {
        await database.pool.query("DROP TRIGGER restore_proof_boom ON crm_contacts");
        await database.pool.query("DROP FUNCTION restore_proof_boom()");
      }
    } finally {
      await database.pool.query("DROP POLICY restore_proof_leak ON crm_contacts");
      await database.pool.query("REVOKE UPDATE, DELETE ON crm_contacts FROM authenticated");
      await database.pool.query("GRANT UPDATE (display_name, normalized_email, e164_phone, updated_at) ON crm_contacts TO authenticated");
    }
  });
});
