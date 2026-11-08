import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import pg from "pg";
import type { PoolClient } from "pg";

const { Client } = pg;
type Client = InstanceType<typeof Client>;
import { createTwoTenantFixture, withTestDatabase } from "../src/testing.js";

/**
 * 20261108800000_merge_permissive_job_policies.sql replaces three permissive policies per job
 * table with one per command (the advisor's multiple_permissive_policies lint). This runs the
 * same probes as `authenticated` under every session shape, once with the merged policies and
 * once with the three old ones put back, and requires identical answers: same rows seen,
 * updated, moved, inserted and deleted, and the same refusals.
 */
const TENANT = "tenant_id = nullif((select current_setting('app.tenant_id', true)), '')::uuid";
const PLATFORM = "(select current_setting('app.platform', true)) = 'on'";
const OLD_POLICIES = (table: string) => `
  DROP POLICY tenant_or_platform_read ON public.${table};
  DROP POLICY tenant_or_platform_update ON public.${table};
  DROP POLICY tenant_scope_insert ON public.${table};
  DROP POLICY tenant_scope_delete ON public.${table};
  CREATE POLICY tenant_scope ON public.${table} FOR ALL TO authenticated USING (${TENANT}) WITH CHECK (${TENANT});
  CREATE POLICY platform_claim_read ON public.${table} FOR SELECT TO authenticated USING (${PLATFORM});
  CREATE POLICY platform_claim_lease ON public.${table} FOR UPDATE TO authenticated USING (${PLATFORM}) WITH CHECK (${PLATFORM});`;

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261108800000_merge_permissive_job_policies.sql", import.meta.url), "utf8");

const AT = "2026-11-08T08:00:00.000Z";
const TABLES = {
  transcription_jobs: {
    insert: `INSERT INTO transcription_jobs (tenant_id,id,source_kind,declared_bytes,next_attempt_at,created_at,updated_at)
      VALUES ($1,$2,'media_upload',10,$3,$3,$3)`,
    touch: "updated_at = updated_at",
  },
  document_intake_jobs: {
    insert: `INSERT INTO document_intake_jobs (tenant_id,id,filename,file_sha256,byte_length,status,created_by,created_at)
      VALUES ($1,$2,'list.pdf','${"c".repeat(64)}',100,'queued','${randomUUID()}',$3)`,
    touch: "filename = filename",
  },
} as const;
type Table = keyof typeof TABLES;

it("merged job policies grant exactly what the three old policies granted", async () => {
  await withTestDatabase(async (database) => {
    const { a, b } = await createTwoTenantFixture(database);
    const rows: Record<Table, { a: string; b: string }> = {
      transcription_jobs: { a: randomUUID(), b: randomUUID() },
      document_intake_jobs: { a: randomUUID(), b: randomUUID() },
    };
    for (const table of Object.keys(TABLES) as Table[]) {
      await database.pool.query(TABLES[table].insert, [a.tenantId, rows[table].a, AT]);
      await database.pool.query(TABLES[table].insert, [b.tenantId, rows[table].b, AT]);
    }
    const name = (id: string) => Object.values(rows).flatMap((r) => [[r.a, "A"], [r.b, "B"]]).find(([x]) => x === id)?.[1] ?? "new";
    // A setting left undefined is never set: that probe runs on a fresh connection, where
    // current_setting(..., true) is NULL rather than ''. Other roles hold no policy on these
    // tables; they are probed so a policy that leaks to them shows up.
    type Session = { role: string; tenant?: string; platform?: string };
    const sessions: Record<string, Session> = {
      tenantA: { role: "authenticated", tenant: a.tenantId, platform: "" },
      tenantB: { role: "authenticated", tenant: b.tenantId, platform: "" },
      none: { role: "authenticated", tenant: "", platform: "" },
      unset: { role: "authenticated" },
      tenantAPlatformUnset: { role: "authenticated", tenant: a.tenantId },
      malformedTenant: { role: "authenticated", tenant: "not-a-uuid", platform: "" },
      platform: { role: "authenticated", tenant: "", platform: "on" },
      platformUnsetTenant: { role: "authenticated", platform: "on" },
      platformUpperCase: { role: "authenticated", tenant: "", platform: "ON" },
      platformTrue: { role: "authenticated", tenant: "", platform: "true" },
      tenantAndPlatform: { role: "authenticated", tenant: a.tenantId, platform: "on" },
      dispatcherTenantA: { role: "zs_dispatcher", tenant: a.tenantId, platform: "on" },
      serviceRole: { role: "service_role", tenant: a.tenantId, platform: "on" },
    };

    // One probe per transaction, always rolled back, so every probe starts from the same rows.
    // `rows` reports which rows came back (RETURNING); `count` reports the affected row count of a
    // statement that reads no column, so only the command's own policy applies (no SELECT policy).
    const probe = async (session: Session, sql: string, params: unknown[] = [], report: "rows" | "count" = "rows") => {
      const fresh = session.tenant === undefined || session.platform === undefined;
      const client = fresh ? new Client(database.pool.options) : await database.pool.connect();
      if (fresh) await (client as Client).connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role',$1,true)", [session.role]);
        if (session.tenant !== undefined) await client.query("SELECT set_config('app.tenant_id',$1,true)", [session.tenant]);
        if (session.platform !== undefined) await client.query("SELECT set_config('app.platform',$1,true)", [session.platform]);
        const result = await client.query<{ id: string }>(sql, params);
        if (report === "count") return `count ${result.rowCount}`;
        return result.rows.map((row) => name(row.id)).sort().join(",") || "none";
      } catch (error) {
        return `error ${(error as { code?: string }).code}`;
      } finally {
        await client.query("ROLLBACK");
        if (fresh) await (client as Client).end(); else (client as PoolClient).release();
      }
    };

    const matrix = async () => {
      const out: Record<string, string> = {};
      for (const table of Object.keys(TABLES) as Table[]) {
        const t = TABLES[table];
        for (const [label, session] of Object.entries(sessions)) {
          const key = `${table} ${label}`;
          const run = (probeName: string, sql: string, params: unknown[] = [], report: "rows" | "count" = "rows") =>
            probe(session, sql, params, report).then((value) => { out[`${key} ${probeName}`] = value; });
          await run("select", `SELECT id FROM ${table}`);
          await run("update", `UPDATE ${table} SET ${t.touch} RETURNING id`);
          await run("blind update", `UPDATE ${table} SET created_at = $1`, [AT], "count");
          await run("move A to B", `UPDATE ${table} SET tenant_id=$1 WHERE id=$2 RETURNING id`, [b.tenantId, rows[table].a]);
          await run("move B to A", `UPDATE ${table} SET tenant_id=$1 WHERE id=$2 RETURNING id`, [a.tenantId, rows[table].b]);
          await run("blind move to B", `UPDATE ${table} SET tenant_id = $1`, [b.tenantId], "count");
          await run("insert A", `${t.insert} RETURNING id`, [a.tenantId, randomUUID(), AT]);
          await run("insert B", `${t.insert} RETURNING id`, [b.tenantId, randomUUID(), AT]);
          await run("blind insert A", t.insert, [a.tenantId, randomUUID(), AT], "count");
          await run("upsert A", `${t.insert} ON CONFLICT (tenant_id, id) DO UPDATE SET created_at = $3 RETURNING id`, [a.tenantId, rows[table].a, AT]);
          await run("blind upsert B", `${t.insert} ON CONFLICT (tenant_id, id) DO UPDATE SET created_at = $3`, [b.tenantId, rows[table].b, AT], "count");
          await run("delete", `DELETE FROM ${table} RETURNING id`);
          await run("blind delete", `DELETE FROM ${table}`, [], "count");
        }
      }
      return out;
    };

    // Pass 1 uses the real grants, which refuse some probes before any policy runs. Pass 2 grants
    // every privilege, so the policies alone decide. Both must match between old and new.
    const merged = await matrix();
    // The lint is gone: exactly one permissive policy per command, each for `authenticated` only.
    const { rows: policySet } = await database.pool.query(`
      SELECT tablename, policyname, permissive, roles::text AS roles, cmd FROM pg_policies
      WHERE schemaname='public' AND tablename = ANY($1) ORDER BY 1,2`, [Object.keys(TABLES)]);
    expect(policySet).toEqual((Object.keys(TABLES) as Table[]).sort().flatMap((tablename) => [
      { tablename, policyname: "tenant_or_platform_read", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "SELECT" },
      { tablename, policyname: "tenant_or_platform_update", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "UPDATE" },
      { tablename, policyname: "tenant_scope_delete", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "DELETE" },
      { tablename, policyname: "tenant_scope_insert", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "INSERT" },
    ]));

    for (const table of Object.keys(TABLES)) await database.pool.query(OLD_POLICIES(table));
    expect(await matrix()).toEqual(merged);

    for (const table of Object.keys(TABLES)) await database.pool.query(`GRANT ALL ON public.${table} TO authenticated, zs_dispatcher, service_role`);
    const oldPolicyOnly = await matrix();
    await database.pool.query(MIGRATION);
    const mergedPolicyOnly = await matrix();
    expect(mergedPolicyOnly).toEqual(oldPolicyOnly);

    // The policy-only pass reaches every branch: each tenant sees and changes only its own row,
    // a row cannot move to another tenant, the platform reads and leases any row (and may move
    // one, as platform_claim_lease allowed), and the platform never inserts or deletes.
    for (const table of Object.keys(TABLES)) {
      const at = (probe: string) => mergedPolicyOnly[`${table} ${probe}`];
      expect(at("tenantA select")).toBe("A");
      expect(at("tenantA update")).toBe("A");
      expect(at("tenantA delete")).toBe("A");
      expect(at("tenantA move A to B")).toBe("error 42501");
      expect(at("tenantA move B to A")).toBe("none");
      expect(at("tenantA insert B")).toBe("error 42501");
      expect(at("none select")).toBe("none");
      expect(at("none insert A")).toBe("error 42501");
      expect(at("platform select")).toBe("A,B");
      expect(at("platform update")).toBe("A,B");
      expect(at("platform move A to B")).toBe("A");
      expect(at("platform insert A")).toBe("error 42501");
      expect(at("platform delete")).toBe("none");
      expect(at("tenantAndPlatform delete")).toBe("A");
      expect(at("tenantAndPlatform insert A")).toBe("new");
      expect(at("tenantA blind update")).toBe("count 1");
      expect(at("platform blind update")).toBe("count 2");
      expect(at("none blind update")).toBe("count 0");
      expect(at("tenantA blind move to B")).toBe("error 42501");
      expect(at("platform blind move to B")).toBe("count 2");
      expect(at("tenantA upsert A")).toBe("A");
      expect(at("tenantA blind upsert B")).toBe("error 42501");
      expect(at("platform blind delete")).toBe("count 0");
      expect(at("tenantA blind delete")).toBe("count 1");
      expect(at("unset select")).toBe("none");
      expect(at("tenantAPlatformUnset select")).toBe("A");
      expect(at("platformUnsetTenant select")).toBe("A,B");
      expect(at("malformedTenant select")).toBe("error 22P02");
      expect(at("platformUpperCase select")).toBe("none");
      expect(at("platformTrue update")).toBe("none");
      expect(at("dispatcherTenantA select")).toBe("none");
    }
  });
});
