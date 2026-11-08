import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { is, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";
import * as schema from "../src/schema/index.js";
import { withTestDatabase } from "../src/testing.js";

/**
 * Drift test: the SQL migrations are the source of truth, and packages/db/src/schema/*.ts mirrors
 * 12 of the tables. This test applies every migration to a scratch database and compares what
 * Drizzle defines with what Postgres holds, in both directions, for:
 *   - columns (name, type, nullability),
 *   - row level security (enabled, and every policy: command, roles, permissive, USING, WITH CHECK),
 *   - indexes (name and full definition, including primary keys and unique constraints; the index
 *     behind an EXCLUDE constraint is left out, because Drizzle has no way to declare it),
 *   - foreign keys between Drizzle tables, and that an index leads with each foreign key's columns.
 * Expressions are normalised by Postgres itself: the Drizzle text is applied to a scratch table of
 * the same name and read back through pg_policies / pg_get_indexdef, so only real differences fail.
 */
const dialect = new PgDialect();
const render = (value: SQL) => dialect.sqlToQuery(value).sql;
const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const SCRATCH = "zs_drift";

const FK_ACTIONS: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };

it("defines the 12 tables this test covers", () => {
  expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual([
    "actions", "booking_external_blocks", "booking_resources", "bookings", "crm_contact_consent", "crm_contacts",
    "crm_deals", "crm_pipelines", "crm_stages", "outbox", "tenant_members", "tenants",
  ]);
});

it("matches the migrated database: columns, RLS, policies, indexes and foreign keys", async () => {
  await withTestDatabase(async (database) => {
    const db = database.pool;
    const problems: string[] = [];
    const names = new Set(tables.map((table) => getTableConfig(table).name));
    await db.query(`CREATE SCHEMA ${SCRATCH}`);
    try {
      for (const table of tables) {
        const config = getTableConfig(table);
        const t = config.name;
        const at = (what: string) => `${t}: ${what}`;

        // --- columns
        const dbColumns = new Map((await db.query<{ name: string; type: string; notnull: boolean }>(
          `SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS notnull FROM pg_attribute
            WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [`public.${quote(t)}`])).rows.map((row) => [row.name, row]));
        const drizzleColumns = new Map(config.columns.map((column) => [column.name, column]));
        for (const [name, column] of drizzleColumns) {
          const row = dbColumns.get(name);
          if (!row) { problems.push(at(`column ${name} is in Drizzle, not in the database`)); continue; }
          if (row.type !== column.getSQLType()) problems.push(at(`column ${name} type: Drizzle ${column.getSQLType()}, database ${row.type}`));
          if (row.notnull !== (column.notNull || column.primary)) problems.push(at(`column ${name} not null: Drizzle ${column.notNull}, database ${row.notnull}`));
        }
        for (const name of dbColumns.keys()) if (!drizzleColumns.has(name)) problems.push(at(`column ${name} is in the database, not in Drizzle`));

        // --- row level security and policies
        const rls = (await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass", [`public.${quote(t)}`])).rows[0]!.on;
        if (rls !== config.enableRLS) problems.push(at(`RLS enabled: Drizzle ${config.enableRLS}, database ${rls}`));
        await db.query(`CREATE TABLE ${SCRATCH}.${quote(t)} (LIKE public.${quote(t)})`);
        const dbPolicies = (await db.query<{ policyname: string; permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }>(
          "SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname", [t])).rows;
        const scratchPolicies = new Map<string, { permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }>();
        for (const policy of config.policies) {
          const to = policy.to as unknown;
          const roles = (Array.isArray(to) ? to : to ? [to] : ["public"])
            .map((role: string | { name: string }) => (typeof role === "string" ? role : role.name));
          const as = (policy.as ?? "permissive").toUpperCase();
          const cmd = (policy.for ?? "all").toUpperCase();
          await db.query(`CREATE POLICY ${quote(policy.name)} ON ${SCRATCH}.${quote(t)} AS ${as} FOR ${cmd} TO ${roles.map(quote).join(", ")}
            ${policy.using ? `USING (${render(policy.using)})` : ""} ${policy.withCheck ? `WITH CHECK (${render(policy.withCheck)})` : ""}`);
        }
        for (const row of (await db.query<{ policyname: string; permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }>(
          "SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = $2 AND tablename = $1", [t, SCRATCH])).rows)
          scratchPolicies.set(row.policyname, row);
        const dbByName = new Map(dbPolicies.map((row) => [row.policyname, row]));
        for (const [name, mine] of scratchPolicies) {
          const real = dbByName.get(name);
          if (!real) { problems.push(at(`policy ${name} is in Drizzle, not in the database`)); continue; }
          for (const key of ["permissive", "cmd", "qual", "with_check"] as const)
            if (mine[key] !== real[key]) problems.push(at(`policy ${name} ${key}:\n    Drizzle  ${mine[key]}\n    database ${real[key]}`));
          if ([...mine.roles].sort().join() !== [...real.roles].sort().join())
            problems.push(at(`policy ${name} roles: Drizzle {${mine.roles}}, database {${real.roles}}`));
        }
        for (const name of dbByName.keys()) if (!scratchPolicies.has(name)) problems.push(at(`policy ${name} is in the database, not in Drizzle`));

        // --- indexes: every Drizzle index, unique constraint and primary key, built on a scratch copy
        const defOf = async (schemaName: string) => (await db.query<{ indexname: string; def: string }>(
          `SELECT indexname, indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'x' AND c.conindid = format('%I.%I', schemaname, indexname)::regclass)`,
          [schemaName, t])).rows;
        const normalise = (def: string, schemaName: string) =>
          def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1ON ").replaceAll(`${schemaName}.`, "");
        const columnList = (columns: { name: string }[]) => columns.map((column) => quote(column.name)).join(", ");
        const primary = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
        const key = (name: string | null, def: string, schemaName: string) => `${name ?? "(pkey)"} :: ${normalise(def, schemaName)}`;
        const mineIndexes = new Map<string, string>();
        const build = async (name: string, ddl: string, labelName: string | null) => {
          await db.query(ddl);
          const row = (await defOf(SCRATCH)).find((entry) => entry.indexname === name)!;
          mineIndexes.set(key(labelName, row.def, SCRATCH), name);
        };
        if (primary.length) await build(`${t}_pkey_scratch`, `CREATE UNIQUE INDEX ${quote(`${t}_pkey_scratch`)} ON ${SCRATCH}.${quote(t)} (${columnList(primary)})`, null);
        for (const unique of config.uniqueConstraints) {
          const name = unique.name ?? unique.getName() ?? `${t}_${unique.columns.map((c) => c.name).join("_")}_unique`;
          await build(name, `CREATE UNIQUE INDEX ${quote(name)} ON ${SCRATCH}.${quote(t)} (${columnList(unique.columns)})${unique.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""}`, name);
        }
        for (const index of config.indexes) {
          const { columns, unique, where, method } = index.config;
          const name = index.config.name!;
          const parts = columns.map((column) => {
            if ("indexConfig" in (column as object)) {
              const c = column as unknown as { name: string; indexConfig: { order?: string; nulls?: string; opClass?: string } };
              const desc = c.indexConfig.order === "desc";
              // NULLS options exist only for btree; the default is LAST ascending and FIRST descending.
              const nulls = c.indexConfig.nulls && (method ?? "btree") === "btree" && c.indexConfig.nulls !== (desc ? "first" : "last")
                ? ` NULLS ${c.indexConfig.nulls.toUpperCase()}` : "";
              return `${quote(c.name)}${c.indexConfig.opClass ? ` ${c.indexConfig.opClass}` : ""}${desc ? " DESC" : ""}${nulls}`;
            }
            return `(${render(column as SQL)})`;
          });
          await build(name, `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${SCRATCH}.${quote(t)} USING ${method ?? "btree"} (${parts.join(", ")})${where ? ` WHERE ${render(where)}` : ""}`, name);
        }
        // Expected primary key and unique-constraint indexes in the database carry their own names.
        const dbIndexes = new Map((await defOf("public")).map((row) => {
          const isPkey = row.indexname === `${t}_pkey`;
          return [key(isPkey ? null : row.indexname, row.def, "public"), row.indexname] as const;
        }));
        for (const k of mineIndexes.keys()) if (!dbIndexes.has(k)) problems.push(at(`index in Drizzle, not matched in the database: ${k}`));
        for (const k of dbIndexes.keys()) if (!mineIndexes.has(k)) problems.push(at(`index in the database, not in Drizzle: ${k}`));
      }

      // --- foreign keys between Drizzle tables
      const dbForeignKeys = (await db.query<{ t: string; cols: string[]; ref: string; refcols: string[]; del: string; upd: string }>(`
        SELECT c.conrelid::regclass::text AS t, c.confrelid::regclass::text AS ref, c.confdeltype AS del, c.confupdtype AS upd,
          (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
          (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
        FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`)).rows;
      const fkText = (t: string, cols: string[], ref: string, refcols: string[], del: string, upd: string) =>
        `${t}(${cols}) -> ${ref}(${refcols}) on delete ${del} on update ${upd}`;
      const dbFks = new Set(dbForeignKeys.filter((row) => names.has(row.t) && names.has(row.ref))
        .map((row) => fkText(row.t, row.cols, row.ref, row.refcols, FK_ACTIONS[row.del]!, FK_ACTIONS[row.upd]!)));
      const mineFks = new Set<string>();
      for (const table of tables) {
        const config = getTableConfig(table);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          mineFks.add(fkText(config.name, ref.columns.map((c) => c.name), getTableConfig(ref.foreignTable).name,
            ref.foreignColumns.map((c) => c.name), fk.onDelete ?? "no action", fk.onUpdate ?? "no action"));
        }
      }
      for (const fk of mineFks) if (!dbFks.has(fk)) problems.push(`foreign key in Drizzle, not in the database: ${fk}`);
      for (const fk of dbFks) if (!mineFks.has(fk)) problems.push(`foreign key in the database, not in Drizzle: ${fk}`);

      // --- every Drizzle foreign key has a Drizzle index that leads with its columns (the advisor's rule)
      for (const table of tables) {
        const config = getTableConfig(table);
        const leads: string[][] = [
          (config.primaryKeys[0]?.columns ?? config.columns.filter((c) => c.primary)).map((c) => c.name),
          ...config.uniqueConstraints.map((u) => u.columns.map((c) => c.name)),
          ...config.indexes.filter((i) => !i.config.where).map((i) => i.config.columns.map((c) => ("name" in c ? (c as { name: string }).name : "(expression)"))),
        ];
        for (const fk of config.foreignKeys) {
          const cols = fk.reference().columns.map((c) => c.name);
          if (!leads.some((lead) => cols.every((col, n) => lead[n] === col)))
            problems.push(`${config.name}: Drizzle foreign key (${cols}) has no index that leads with it`);
        }
      }
    } finally {
      await db.query(`DROP SCHEMA ${SCRATCH} CASCADE`);
    }
    expect(problems).toEqual([]);
  });
});
