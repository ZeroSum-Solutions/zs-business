import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    // Key columns only (indnkeyatts): an INCLUDE column is stored in the index but cannot be searched.
    const { rows } = await database.pool.query<{ rel: string; conname: string }>(`
      SELECT c.conrelid::regclass::text AS rel, c.conname FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indnkeyatts >= cardinality(c.conkey)
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
it("covers every public foreign key with an index that leads with its columns and has no predicate", async () => {
  await withTestDatabase(async (database) => {
    const { rows } = await database.pool.query<{ rel: string; conname: string; cols: string[]; preds: (string | null)[] | null }>(`
      SELECT c.conrelid::regclass::text AS rel, c.conname,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS cols,
        (SELECT array_agg(pg_get_expr(i.indpred, i.indrelid) ORDER BY i.indexrelid) FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NOT NULL
            AND i.indnkeyatts >= cardinality(c.conkey)
            AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey) AS preds
      FROM pg_constraint c
      WHERE c.contype='f' AND c.connamespace='public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL
            AND i.indnkeyatts >= cardinality(c.conkey)
            AND (i.indkey::int2[])[0:cardinality(c.conkey)-1] = c.conkey)
      ORDER BY 1,2`);
    // No full index: every one must be a partial index on `col IS NOT NULL` (any of its columns).
    const offenders = rows.filter((row) => {
      const notNull = new RegExp(`^\\(?(${row.cols.join("|")}) IS NOT NULL\\)?$`);
      return !(row.preds ?? []).some((pred) => pred !== null && notNull.test(pred));
    }).map((row) => `${row.rel}.${row.conname} (${row.cols.join(",")}): partial predicates ${JSON.stringify(row.preds)}`);
    expect(offenders).toEqual([]);
  });
});

// The four foreign keys that only a status- or kind-filtered partial index covered, and the full
// index 20261108600000_fk_full_indexes.sql gives each. `IF NOT EXISTS` skips a name that is
// already taken, even by a partial or differently ordered index, so the full definition is checked.
const FULL_FK_INDEXES = [
  { table: "agent_followups", name: "agent_followups_tenant_id_contact_id_idx", cols: ["tenant_id", "contact_id"],
    parent: "crm_contacts", def: "CREATE INDEX agent_followups_tenant_id_contact_id_idx ON public.agent_followups USING btree (tenant_id, contact_id)" },
  { table: "agent_followups", name: "agent_followups_tenant_id_intake_item_id_idx", cols: ["tenant_id", "intake_item_id"],
    parent: "intake_items", def: "CREATE INDEX agent_followups_tenant_id_intake_item_id_idx ON public.agent_followups USING btree (tenant_id, intake_item_id, created_at)" },
  { table: "calendar_connections", name: "calendar_connections_tenant_id_resource_id_idx", cols: ["tenant_id", "resource_id"],
    parent: "booking_resources", def: "CREATE INDEX calendar_connections_tenant_id_resource_id_idx ON public.calendar_connections USING btree (tenant_id, resource_id)" },
  { table: "wallet_ledger", name: "wallet_ledger_tenant_id_reservation_id_idx", cols: ["tenant_id", "reservation_id"],
    parent: "wallet_reservations", def: "CREATE INDEX wallet_ledger_tenant_id_reservation_id_idx ON public.wallet_ledger USING btree (tenant_id, reservation_id)" },
] as const;

it("has the exact full definition, valid and with no predicate, for the four new foreign-key indexes", async () => {
  await withTestDatabase(async (database) => {
    for (const want of FULL_FK_INDEXES) {
      const { rows } = await database.pool.query<{ indexdef: string; indisvalid: boolean; indpred: string | null }>(`
        SELECT x.indexdef, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS indpred
        FROM pg_indexes x
        JOIN pg_class ic ON ic.relname = x.indexname AND ic.relnamespace = 'public'::regnamespace
        JOIN pg_index i ON i.indexrelid = ic.oid
        WHERE x.schemaname='public' AND x.tablename=$1 AND x.indexname=$2`, [want.table, want.name]);
      expect(rows, want.name).toHaveLength(1);
      expect(rows[0]?.indexdef, want.name).toBe(want.def);
      expect(rows[0]?.indisvalid, want.name).toBe(true);
      expect(rows[0]?.indpred, want.name).toBeNull();
    }
    // The partial unique indexes stay: they enforce one-per rules and serve the app's status lookups.
    const kept = await database.pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [["wallet_ledger_one_capture", "agent_followups_contact_drafted", "calendar_connections_one_per_resource"]]);
    expect(kept.rows.map((row) => row.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON public\.\S+ USING btree /, "$1 ")))
      .toEqual([
        " (tenant_id, contact_id, created_at) WHERE (outcome = 'drafted'::text)",
        "UNIQUE  (tenant_id, resource_id) WHERE (status = ANY (ARRAY['active'::calendar_connection_status, 'reauthorize'::calendar_connection_status]))",
        "UNIQUE  (tenant_id, reservation_id) WHERE (kind = 'capture'::text)",
      ]);
  });
});

it("still has the foreign keys those four indexes serve, and no earlier migration uses their names", async () => {
  await withTestDatabase(async (database) => {
    for (const want of FULL_FK_INDEXES) {
      const { rows } = await database.pool.query<{ cols: string[] }>(`
        SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS cols
        FROM pg_constraint c
        WHERE c.contype='f' AND c.conrelid = format('public.%I', $1::text)::regclass
          AND c.confrelid = format('public.%I', $2::text)::regclass`, [want.table, want.parent]);
      expect(rows.some((row) => want.cols.every((col, n) => row.cols[n] === col)), `${want.table} -> ${want.parent}`).toBe(true);
    }
    // The new file is the only one that creates these names (20261108300000 made the earlier set).
    const dir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql") && name !== "20261108600000_fk_full_indexes.sql");
    for (const file of files) {
      const text = readFileSync(`${dir}${file}`, "utf8");
      for (const want of FULL_FK_INDEXES) expect(text.includes(want.name), `${file} uses ${want.name}`).toBe(false);
    }
  });
});
