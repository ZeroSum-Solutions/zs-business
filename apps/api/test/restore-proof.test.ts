import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, testAdminUrl, type TestDatabase } from "@zs/db/testing";
import { BACKUP_EXTENSIONS, readLedger, takeBackup } from "../src/hosted-backup.js";
import { archiveDumpMajor, checkRestoredDatabase, countCopyRows, countPolicies, referencedRoles, restoreProof } from "../src/restore-proof.js";
import { resolvePgTool } from "../src/pg-tools.js";

/** The newest pg_dump's major, or null when the client tools are missing. */
const toolMajor = (() => {
  try {
    execFileSync(resolvePgTool("pg_restore"), ["--version"]);
    return Number(/(\d+)\./.exec(execFileSync(resolvePgTool("pg_dump"), ["--version"], { encoding: "utf8" }))?.[1] ?? NaN);
  } catch {
    return null;
  }
})();

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
  // The round trip needs pg_dump and pg_restore no newer than the server (CI runs 15 and 16 servers
  // beside a newer client); a newer archive is refused, which the last case below checks.
  const serverMajor = async () => Math.floor(Number((await database.pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10000);
  const roundTrip = async () => toolMajor !== null && toolMajor <= await serverMajor();
  const backUp = async (out: string) => {
    const url = new URL(database.url);
    await takeBackup({
      pool: database.pool,
      connection: { host: url.hostname, port: url.port, user: decodeURIComponent(url.username), password: "", database: url.pathname.slice(1) },
      rootCertFile: null, projectRef: "prodprodprodprodprod", out, clock: { now: () => new Date() }, searchPath: process.env.PATH,
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
    const report = await restoreProof({ archivePath: out, adminUrl: testAdminUrl().href, clock: { now: () => new Date() }, searchPath: process.env.PATH });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toHaveLength(6);
    const denial = report.checks.at(-1)!.detail as { tenantA: { id: string }; tenantB: { id: string; synthetic: boolean } };
    expect([denial.tenantA.id, denial.tenantB.id]).toEqual([tenantA, tenantB]);
    expect(report.dropped).toBe(true);
    const left = await database.pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [report.database]);
    expect(left.rowCount).toBe(0);
  });

  it("refuses an archive whose manifest does not match it, and a non-loopback cluster", async (context) => {
    if (toolMajor === null) context.skip();
    const out = join(dir, "manifest.dump");
    await backUp(out);
    const copy = join(dir, "tampered.dump");
    await writeFile(copy, Buffer.concat([await readFile(out), Buffer.from("x")]));
    await writeFile(`${copy}.manifest.json`, (await readFile(`${out}.manifest.json`, "utf8")).replace("manifest.dump", "tampered.dump"));
    await expect(restoreProof({ archivePath: copy, adminUrl: testAdminUrl().href, clock: { now: () => new Date() } })).rejects.toThrow(/sha256/);
    await expect(restoreProof({ archivePath: out, adminUrl: "postgres://postgres@db.example.com:5432/postgres", clock: { now: () => new Date() } }))
      .rejects.toThrow(/127\.0\.0\.1 or localhost/);
  });

  it("refuses to restore an archive from a newer pg_dump into an older server", async (context) => {
    if (toolMajor === null || toolMajor <= await serverMajor()) context.skip();
    const out = join(dir, "newer.dump");
    await backUp(out);
    await expect(restoreProof({ archivePath: out, adminUrl: testAdminUrl().href, clock: { now: () => new Date() }, searchPath: process.env.PATH }))
      .rejects.toThrow(/written by pg_dump \d+; restore it into PostgreSQL/);
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
});
