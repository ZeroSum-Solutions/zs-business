import { expect, it } from "vitest";
import { withTestDatabase } from "../src/testing.js";

/**
 * Mirrors the Supabase advisor lints that 20261108300000_rls_initplan_fk_indexes.sql clears:
 * auth_rls_initplan (a session setting or auth.*() call in a policy that is not read through a
 * scalar subselect is re-evaluated for every row) and unindexed_foreign_keys.
 */
it("reads every session setting in a public policy through a scalar subselect", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      "SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,2");
    expect(rows.length).toBeGreaterThan(80);
    // Pull every `SELECT current_setting(` / `SELECT auth.x(` out of the text; any call left is bare.
    const wrapped = /\(\s*SELECT\s+(?:current_setting|auth\.[a-z_]+)\(/gi;
    const call = /(?:current_setting|auth\.[a-z_]+)\(/i;
    const offenders = rows.flatMap((row) => [row.qual, row.with_check]
      .filter((text): text is string => text !== null && call.test(text.replace(wrapped, "(")))
      .map(() => `${row.tablename}.${row.policyname}`));
    expect(offenders).toEqual([]);
    // Still a real predicate: the tenant policies compare the column with the setting.
    const tenants = rows.find((row) => row.tablename === "actions" && row.policyname === "tenant_scope");
    expect(tenants?.qual).toMatch(/SELECT current_setting\('app\.tenant_id'::text, true\)/);
  });
});

it("covers every public foreign key with an index that starts with its columns, as the advisor checks", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ rel: string; conname: string }>(`
      SELECT c.conrelid::regclass::text AS rel, c.conname FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid
            AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] @> c.conkey
            AND c.conkey @> (i.indkey::int2[])[0:cardinality(c.conkey)-1])
      ORDER BY 1,2`);
    expect(rows).toEqual([]);
  });
});
