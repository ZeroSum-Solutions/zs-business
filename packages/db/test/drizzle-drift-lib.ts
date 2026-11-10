import { getTableConfig, isPgEnum, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import * as schema from "../src/schema/index.js";

/**
 * Compares packages/db/src/schema/*.ts with a migrated database. The migrations are the source of
 * truth. Postgres normalises every expression: Drizzle's text is applied to a scratch copy of the
 * table (`LIKE public.<t>`: same columns, no constraints) in schema zs_drift and read back through
 * the same catalog functions as the real table, so only real differences show.
 * Compared both ways, per mirrored table: columns (type, not null, default, identity, generated),
 * enum labels, RLS and every policy, PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY constraints (name,
 * definition, validity, deferrability, match type, actions), standalone indexes (name, full
 * definition, storage options, validity), and that an index leads with each foreign key.
 * Drizzle cannot declare FORCE RLS or EXCLUDE constraints, so those are pinned instead: every mirrored
 * table must have FORCE RLS, and its EXCLUDE constraints must be exactly EXCLUSION_CONSTRAINTS.
 * Not compared: grants, triggers, generated-column expressions (only whether a column is generated).
 */
/** EXCLUDE constraints that exist on mirrored tables. Drizzle has no way to declare them, so the test pins name and definition. */
export const EXCLUSION_CONSTRAINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bookings: {
    bookings_resource_occupied_excl: "EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, tstzrange(occupied_starts_at, occupied_ends_at, '[)'::text) WITH &&) WHERE ((status = 'confirmed'::text))",
  },
};

/** Foreign keys whose child is mirrored but whose parent is not. The test pins each one in the database. */
export const UNMIRRORED_PARENT_FKS: Readonly<Record<string, Readonly<Record<string, { parent: string; columns: string }>>>> = {
  bookings: {
    bookings_intake_item_fk: { parent: "intake_items", columns: "(tenant_id, intake_item_id) REFERENCES intake_items(tenant_id, id)" },
  },
  booking_external_blocks: {
    booking_external_blocks_connection_fk: { parent: "calendar_connections", columns: "(tenant_id, connection_id) REFERENCES calendar_connections(tenant_id, id)" },
  },
};

const dialect = new PgDialect();
const render = (value: SQL) => dialect.sqlToQuery(value).sql;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const mirroredTables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));
const enums = (Object.values(schema) as unknown[]).filter(isPgEnum);

/**
 * Strips the table name and the schema qualifier from an index definition, outside string
 * literals only, so a predicate such as `scope = 'public.foo'` keeps its text. Applied to both
 * sides, so the two schemas normalise the same way.
 */
export function normaliseIndexDef(def: string): string {
  const body = def.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1ON ");
  return body.split(/('(?:[^']|'')*')/).map((part, n) => (n % 2 === 1 ? part : part.replace(/\b(?:public|zs_drift\w*)\./g, ""))).join("");
}

const renderDefault = (value: unknown): string => {
  if (is(value, SQL)) return render(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
};

interface ConstraintRow { conname: string; contype: string; def: string; convalidated: boolean }
const columnNames = (columns: { name: string }[]) => columns.map((column) => quote(column.name)).join(", ");

export async function collectDrift(db: Pool): Promise<string[]> {
  const problems: string[] = [];
  // A name of its own per run, so two runs on one database cannot drop each other's tables. The test
  // pool runs each statement on its own (autocommit), so a failed statement leaves no aborted
  // transaction behind, and DROP SCHEMA IF EXISTS in `finally` always runs.
  const SCRATCH = `zs_drift_${randomBytes(4).toString("hex")}`;
  try {
    await db.query(`CREATE SCHEMA ${SCRATCH}`);
    // --- enum labels
    for (const en of enums) {
      const rows = (await db.query<{ label: string }>(
        "SELECT enumlabel AS label FROM pg_enum WHERE enumtypid = to_regtype($1) ORDER BY enumsortorder", [`public.${quote(en.enumName)}`])).rows;
      if (rows.map((row) => row.label).join() !== en.enumValues.join())
        problems.push(`enum ${en.enumName}: Drizzle {${en.enumValues}}, database {${rows.map((row) => row.label)}}`);
    }

    const constraintsOf = async (schemaName: string, t: string, types: string[]) => new Map((await db.query<ConstraintRow>(
      `SELECT conname, contype, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = ANY($2::"char"[])`, [`${schemaName}.${quote(t)}`, types])).rows.map((row) => [row.conname, row] as const));
    const compareConstraints = (t: string, mine: Map<string, ConstraintRow>, real: Map<string, ConstraintRow>, what: string, allow: (name: string) => boolean = () => false) => {
      for (const [name, row] of mine) {
        const other = real.get(name);
        if (!other) problems.push(`${t}: ${what} ${name} is in Drizzle, not in the database`);
        else if (other.def !== row.def || other.convalidated !== row.convalidated)
          problems.push(`${t}: ${what} ${name}:\n    Drizzle  ${row.def}\n    database ${other.def}${other.convalidated ? "" : " (not validated)"}`);
      }
      for (const name of real.keys()) if (!mine.has(name) && !allow(name)) problems.push(`${t}: ${what} ${name} is in the database, not in Drizzle`);
    };

    for (const table of mirroredTables) {
      const config = getTableConfig(table);
      const t = config.name;
      const at = (what: string) => `${t}: ${what}`;
      const real = `public.${quote(t)}`;
      const scratch = `${SCRATCH}.${quote(t)}`;
      await db.query(`CREATE TABLE ${scratch} (LIKE ${real} INCLUDING GENERATED)`);

      // --- columns
      const dbColumns = new Map((await db.query<{ name: string; type: string; notnull: boolean; identity: string; generated: string; def: string | null }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.attidentity AS identity,
           a.attgenerated AS generated, pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [real])).rows.map((row) => [row.name, row]));
      const drizzleColumns = new Map(config.columns.map((column) => [column.name, column]));
      for (const [name, column] of drizzleColumns) {
        const row = dbColumns.get(name);
        if (!row) { problems.push(at(`column ${name} is in Drizzle, not in the database`)); continue; }
        if (row.type !== column.getSQLType()) problems.push(at(`column ${name} type: Drizzle ${column.getSQLType()}, database ${row.type}`));
        if (row.notnull !== (column.notNull || column.primary)) problems.push(at(`column ${name} not null: Drizzle ${column.notNull || column.primary} (${column.primary ? "primary key" : column.notNull ? "notNull()" : "nullable"}), database ${row.notnull}`));
        const identity = column.generatedIdentity?.type === "always" ? "a" : column.generatedIdentity?.type === "byDefault" ? "d" : "";
        if (row.identity !== identity) problems.push(at(`column ${name} identity: Drizzle '${identity}', database '${row.identity}'`));
        if ((row.generated !== "") !== (column.generated !== undefined)) problems.push(at(`column ${name} generated: Drizzle ${column.generated !== undefined}, database ${row.generated !== ""}`));
        let mineDefault: string | null = null;
        if (column.hasDefault && column.default !== undefined) {
          await db.query(`ALTER TABLE ${scratch} ALTER COLUMN ${quote(name)} SET DEFAULT ${renderDefault(column.default)}`);
          mineDefault = (await db.query<{ def: string }>(
            "SELECT pg_get_expr(adbin, adrelid) AS def FROM pg_attrdef WHERE adrelid = $1::regclass AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2)", [scratch, name])).rows[0]!.def;
        }
        if (row.identity === "" && row.def !== mineDefault) problems.push(at(`column ${name} default: Drizzle ${mineDefault}, database ${row.def}`));
      }
      // Same order as the database, so an order-sensitive tool cannot rebuild a table.
      const ordinal = (await db.query<{ name: string }>("SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum", [real])).rows.map((row) => row.name);
      if (ordinal.join() !== config.columns.map((column) => column.name).join()) problems.push(at(`column order: Drizzle ${config.columns.map((c) => c.name)}, database ${ordinal}`));
      for (const name of dbColumns.keys()) if (!drizzleColumns.has(name)) problems.push(at(`column ${name} is in the database, not in Drizzle`));

      // --- row level security and policies
      const rls = (await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass", [real])).rows[0]!.on;
      if (rls !== config.enableRLS) problems.push(at(`RLS enabled: Drizzle ${config.enableRLS}, database ${rls}`));
      const forced = (await db.query<{ on: boolean }>("SELECT relforcerowsecurity AS on FROM pg_class WHERE oid = $1::regclass", [real])).rows[0]!.on;
      if (config.enableRLS && !forced) problems.push(at("FORCE ROW LEVEL SECURITY is off in the database (Drizzle cannot declare it; every mirrored table must have it)"));
      type PolicyRow = { policyname: string; permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null };
      const policiesOf = async (schemaName: string) => new Map((await db.query<PolicyRow>(
        "SELECT policyname, permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = $1 AND tablename = $2", [schemaName, t]))
        .rows.map((row) => [row.policyname, row] as const));
      for (const policy of config.policies) {
        const to = policy.to as unknown;
        const roles = (Array.isArray(to) ? to : to ? [to] : ["public"]).map((role: string | { name: string }) => (typeof role === "string" ? role : role.name));
        await db.query(`CREATE POLICY ${quote(policy.name)} ON ${scratch} AS ${(policy.as ?? "permissive").toUpperCase()} FOR ${(policy.for ?? "all").toUpperCase()}
          TO ${roles.map(quote).join(", ")} ${policy.using ? `USING (${render(policy.using)})` : ""} ${policy.withCheck ? `WITH CHECK (${render(policy.withCheck)})` : ""}`);
      }
      const mineP = await policiesOf(SCRATCH);
      const realP = await policiesOf("public");
      for (const [name, mine] of mineP) {
        const other = realP.get(name);
        if (!other) { problems.push(at(`policy ${name} is in Drizzle, not in the database`)); continue; }
        for (const key of ["permissive", "cmd", "qual", "with_check"] as const)
          if (mine[key] !== other[key]) problems.push(at(`policy ${name} ${key}:\n    Drizzle  ${mine[key]}\n    database ${other[key]}`));
        if ([...mine.roles].sort().join() !== [...other.roles].sort().join()) problems.push(at(`policy ${name} roles: Drizzle {${mine.roles}}, database {${other.roles}}`));
      }
      for (const name of realP.keys()) if (!mineP.has(name)) problems.push(at(`policy ${name} is in the database, not in Drizzle`));

      // --- PRIMARY KEY, UNIQUE and CHECK constraints, as constraints (not just their indexes)
      const primary = config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
      if (primary.length) await db.query(`ALTER TABLE ${scratch} ADD PRIMARY KEY (${columnNames(primary)})`);
      for (const unique of config.uniqueConstraints) {
        const name = unique.name ?? unique.getName() ?? `${t}_${unique.columns.map((c) => c.name).join("_")}_key`;
        await db.query(`ALTER TABLE ${scratch} ADD CONSTRAINT ${quote(name)} UNIQUE ${unique.nullsNotDistinct ? "NULLS NOT DISTINCT " : ""}(${columnNames(unique.columns)})`);
      }
      for (const c of config.checks) await db.query(`ALTER TABLE ${scratch} ADD CONSTRAINT ${quote(c.name)} CHECK (${render(c.value)})`);
      compareConstraints(t, await constraintsOf(SCRATCH, t, ["p", "u", "c"]), await constraintsOf("public", t, ["p", "u", "c"]), "constraint");

      // --- foreign keys: every foreign key whose child is mirrored, by name
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const parent = getTableConfig(ref.foreignTable).name;
        await db.query(`ALTER TABLE ${scratch} ADD CONSTRAINT ${quote(fk.getName())} FOREIGN KEY (${columnNames(ref.columns)})
          REFERENCES public.${quote(parent)} (${columnNames(ref.foreignColumns)})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""}${fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : ""}`);
      }
      const realFks = await constraintsOf("public", t, ["f"]);
      compareConstraints(t, await constraintsOf(SCRATCH, t, ["f"]), realFks, "foreign key", (name) => {
        const known = UNMIRRORED_PARENT_FKS[t]?.[name];
        if (!known) return false;
        const row = realFks.get(name)!;
        if (!row.def.includes(known.columns) || !row.convalidated || /DEFERRABLE|MATCH FULL/.test(row.def))
          problems.push(at(`foreign key ${name} to unmirrored ${known.parent} changed: ${row.def}`));
        return true;
      });
      for (const [name, known] of Object.entries(UNMIRRORED_PARENT_FKS[t] ?? {}))
        if (!realFks.has(name))
          problems.push(at(`foreign key ${name} to unmirrored ${known.parent} is missing from the database`));

      // --- EXCLUDE constraints: Drizzle cannot declare them, so pin name and definition
      const excl = await constraintsOf("public", t, ["x"]);
      const wantExcl = EXCLUSION_CONSTRAINTS[t] ?? {};
      for (const [name, def] of Object.entries(wantExcl)) {
        const row = excl.get(name);
        if (!row) problems.push(at(`EXCLUDE constraint ${name} is missing from the database`));
        else if (row.def !== def) problems.push(at(`EXCLUDE constraint ${name}:\n    expected ${def}\n    database ${row.def}`));
      }
      for (const name of excl.keys()) if (!(name in wantExcl)) problems.push(at(`EXCLUDE constraint ${name} is in the database, not in EXCLUSION_CONSTRAINTS`));

      // --- standalone indexes (constraint-backed ones are compared as constraints above)
      const indexesOf = async (schemaName: string) => (await db.query<{ indexname: string; def: string; valid: boolean }>(
        `SELECT ic.relname AS indexname, pg_get_indexdef(x.indexrelid) AS def, x.indisvalid AND x.indisready AS valid
           FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_class tc ON tc.oid = x.indrelid JOIN pg_namespace n ON n.oid = tc.relnamespace
          WHERE n.nspname = $1 AND tc.relname = $2
            AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid AND c.conrelid = x.indrelid AND c.contype IN ('p', 'u', 'x'))`, [schemaName, t])).rows;
      for (const index of config.indexes) {
        const { columns, unique, where, method, with: withOptions } = index.config;
        const name = index.config.name!;
        // `config.only` is set by Drizzle's own builders (true after .using()); it does not mean ON ONLY, so it is not rendered.
        const parts = columns.map((column) => {
          if ("indexConfig" in (column as object)) {
            const c = column as unknown as { name: string; indexConfig: { order?: string; nulls?: string; opClass?: string } };
            const desc = c.indexConfig.order === "desc";
            // NULLS options exist only for btree; the default is LAST ascending and FIRST descending.
            const nulls = c.indexConfig.nulls && (method ?? "btree") === "btree" && c.indexConfig.nulls !== (desc ? "first" : "last") ? ` NULLS ${c.indexConfig.nulls.toUpperCase()}` : "";
            return `${quote(c.name)}${c.indexConfig.opClass ? ` ${c.indexConfig.opClass}` : ""}${desc ? " DESC" : ""}${nulls}`;
          }
          return `(${render(column as SQL)})`;
        });
        const options = withOptions && Object.keys(withOptions).length ? ` WITH (${Object.entries(withOptions).map(([k, v]) => `${k} = ${v}`).join(", ")})` : "";
        await db.query(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${scratch} USING ${method ?? "btree"} (${parts.join(", ")})${options}${where ? ` WHERE ${render(where)}` : ""}`);
      }
      const mineI = new Map((await indexesOf(SCRATCH)).map((row) => [row.indexname, row]));
      const realI = new Map((await indexesOf("public")).map((row) => [row.indexname, row]));
      for (const [name, row] of mineI) {
        const other = realI.get(name);
        if (!other) problems.push(at(`index ${name} is in Drizzle, not in the database`));
        else if (normaliseIndexDef(row.def) !== normaliseIndexDef(other.def))
          problems.push(at(`index ${name}:\n    Drizzle  ${normaliseIndexDef(row.def)}\n    database ${normaliseIndexDef(other.def)}`));
      }
      for (const [name, row] of realI) {
        if (!mineI.has(name)) problems.push(at(`index ${name} is in the database, not in Drizzle: ${normaliseIndexDef(row.def)}`));
        if (!row.valid) problems.push(at(`index ${name} is not valid and ready`));
      }
      const badIndexes = (await db.query<{ name: string }>(
        "SELECT ic.relname AS name FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid WHERE x.indrelid = $1::regclass AND NOT (x.indisvalid AND x.indisready)", [real])).rows;
      for (const row of badIndexes) if (!realI.has(row.name)) problems.push(at(`index ${row.name} is not valid and ready`));
    }

    // --- every foreign key has an index leading with its columns: a full index, or a partial one on `col IS NOT NULL`
    for (const table of mirroredTables) {
      const config = getTableConfig(table);
      const leads = [
        (config.primaryKeys[0]?.columns ?? config.columns.filter((c) => c.primary)).map((c) => c.name),
        ...config.uniqueConstraints.map((u) => u.columns.map((c) => c.name)),
        ...config.indexes.filter((i) => {
          if (!i.config.where) return true;
          const fkCols = config.foreignKeys.flatMap((fk) => fk.reference().columns.map((c) => c.name));
          return fkCols.some((col) => new RegExp(`^"?${config.name}"?\\."?${col}"? IS NOT NULL$`).test(render(i.config.where!)));
        }).map((i) => i.config.columns.map((c) => ("name" in c ? (c as { name: string }).name : "(expression)"))),
      ];
      for (const fk of config.foreignKeys) {
        const cols = fk.reference().columns.map((c) => c.name);
        if (!leads.some((lead) => cols.every((col, n) => lead[n] === col))) problems.push(`${config.name}: Drizzle foreign key (${cols}) has no index that leads with it`);
      }
    }
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${SCRATCH} CASCADE`);
  }
  return problems;
}
