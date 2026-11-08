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

/**
 * 20261108600000_fk_full_indexes.sql: a PARTIAL index (WHERE predicate) cannot serve the
 * foreign-key check from the parent (`WHERE tenant_id = $1 AND col = $2`) unless the predicate is
 * implied by it. `col IS NOT NULL` is implied (the `=` is strict); a status or kind test is not.
 */
// A foreign key whose only cover is a partial index on purpose, with the reason.
const PARTIAL_ONLY_ON_PURPOSE = new Map([
  ["wallet_ledger_reservation_fk",
    "append-only ledger, wallet_reservations has no DELETE grant for any runtime role, no read by reservation_id"],
]);

it("covers every public foreign key with an index that leads with its columns and has no predicate", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ rel: string; conname: string; cols: string[]; preds: (string | null)[] | null }>(`
      SELECT c.conrelid::regclass::text AS rel, c.conname,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS cols,
        (SELECT array_agg(pg_get_expr(i.indpred, i.indrelid) ORDER BY i.indexrelid) FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NOT NULL
            AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey) AS preds
      FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
            AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey)
      ORDER BY 1,2`);
    // No full index: every one must be a partial index on `col IS NOT NULL`, or listed on purpose.
    const offenders = rows.filter((row) => {
      if (PARTIAL_ONLY_ON_PURPOSE.has(row.conname)) return false;
      const notNull = new RegExp(`^\\(?(${row.cols.join("|")}) IS NOT NULL\\)?$`);
      return !(row.preds ?? []).some((pred) => pred !== null && notNull.test(pred));
    }).map((row) => `${row.rel}.${row.conname} (${row.cols.join(",")}): partial predicates ${JSON.stringify(row.preds)}`);
    expect(offenders).toEqual([]);
    // The allow-list is not stale: each entry still names a foreign key covered only by a partial index.
    expect(rows.map((row) => row.conname)).toEqual(expect.arrayContaining([...PARTIAL_ONLY_ON_PURPOSE.keys()]));
  });
});

it("has full indexes on the three foreign keys that only a status-filtered partial index covered", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ rel: string; cols: string[] }>(`
      SELECT i.indrelid::regclass::text AS rel,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum) AS cols
      FROM pg_index i
      WHERE i.indisvalid AND i.indpred IS NULL AND i.indrelid IN
        ('agent_followups'::regclass, 'calendar_connections'::regclass)`);
    const has = (rel: string, lead: string[]) => rows.some((row) => row.rel === rel && lead.every((col, n) => row.cols[n] === col));
    expect(has("agent_followups", ["tenant_id", "contact_id"])).toBe(true);
    expect(has("agent_followups", ["tenant_id", "intake_item_id"])).toBe(true);
    expect(has("calendar_connections", ["tenant_id", "resource_id"])).toBe(true);
  });
});
