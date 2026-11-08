import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Pool } from "pg";
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
    const sessions = {
      tenantA: { tenant: a.tenantId, platform: "" },
      tenantB: { tenant: b.tenantId, platform: "" },
      none: { tenant: "", platform: "" },
      platform: { tenant: "", platform: "on" },
      tenantAndPlatform: { tenant: a.tenantId, platform: "on" },
    };

    // One probe per transaction, always rolled back, so every probe starts from the same rows.
    const probe = async (pool: Pool, session: { tenant: string; platform: string }, sql: string, params: unknown[] = []) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('role','authenticated',true), set_config('app.tenant_id',$1,true), set_config('app.platform',$2,true)",
          [session.tenant, session.platform]);
        const result = await client.query<{ id: string }>(sql, params);
        return result.rows.map((row) => name(row.id)).sort().join(",") || "none";
      } catch (error) {
        return `error ${(error as { code?: string }).code}`;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };

    const matrix = async () => {
      const out: Record<string, string> = {};
      for (const table of Object.keys(TABLES) as Table[]) {
        const t = TABLES[table];
        for (const [label, session] of Object.entries(sessions)) {
          const key = `${table} ${label}`;
          out[`${key} select`] = await probe(database.pool, session, `SELECT id FROM ${table}`);
          out[`${key} update`] = await probe(database.pool, session, `UPDATE ${table} SET ${t.touch} RETURNING id`);
          out[`${key} move A to B`] = await probe(database.pool, session, `UPDATE ${table} SET tenant_id=$1 WHERE id=$2 RETURNING id`, [b.tenantId, rows[table].a]);
          out[`${key} move B to A`] = await probe(database.pool, session, `UPDATE ${table} SET tenant_id=$1 WHERE id=$2 RETURNING id`, [a.tenantId, rows[table].b]);
          out[`${key} insert A`] = await probe(database.pool, session, `${t.insert} RETURNING id`, [a.tenantId, randomUUID(), AT]);
          out[`${key} insert B`] = await probe(database.pool, session, `${t.insert} RETURNING id`, [b.tenantId, randomUUID(), AT]);
          out[`${key} delete`] = await probe(database.pool, session, `DELETE FROM ${table} RETURNING id`);
        }
      }
      return out;
    };

    // Pass 1 uses the real grants, which refuse some probes before any policy runs. Pass 2 grants
    // every privilege, so the policies alone decide. Both must match between old and new.
    const merged = await matrix();
    // The lint is gone: one permissive policy per role and command on each table.
    const { rows: doubles } = await database.pool.query(`
      SELECT tablename, cmd, count(*)::int AS n FROM pg_policies
      WHERE schemaname='public' AND tablename = ANY($1) AND permissive='PERMISSIVE'
      GROUP BY 1,2 HAVING count(*) > 1`, [Object.keys(TABLES)]);
    expect(doubles).toEqual([]);

    for (const table of Object.keys(TABLES)) await database.pool.query(OLD_POLICIES(table));
    expect(await matrix()).toEqual(merged);

    for (const table of Object.keys(TABLES)) await database.pool.query(`GRANT ALL ON public.${table} TO authenticated`);
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
    }
  });
});
