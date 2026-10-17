import { randomUUID } from "node:crypto";
import type { Transaction } from "../src/scoped.js";

interface TenantTable {
  name: string;
  rls: boolean;
  forced: boolean;
  policy: boolean;
  public_grants: boolean;
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export async function catalogTenantTables(tx: Transaction): Promise<TenantTable[]> {
  return (await tx.query<TenantTable>(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) AS policy,
      (EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl WHERE acl.grantee=0)
       OR EXISTS(SELECT 1 FROM pg_attribute col, LATERAL aclexplode(col.attacl) acl WHERE col.attrelid=c.oid AND acl.grantee=0)) AS public_grants
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
    ORDER BY c.relname
  `)).rows;
}

/** Catalog-generated fixtures make a new tenant table fail closed, never silently skip it.
 * Defaults and FK rows take precedence over synthetic scalar values. Unsupported constraints
 * surface as fixture errors, so migrations must keep test data constructible.
 */
export async function seedTenantTables(tx: Transaction, tenantId: string, tables: TenantTable[]): Promise<void> {
  const pending = new Map(tables.map((table) => [table.name, table]));
  while (pending.size) {
    let progress = false;
    for (const name of pending.keys()) {
      const table = `public.${quote(name)}`;
      if ((await tx.query(`select 1 from ${table} where tenant_id=$1 limit 1`, [tenantId])).rowCount) {
        pending.delete(name);
        progress = true;
        continue;
      }
      const fields = (await tx.query<{
        name: string; type: string; required: boolean; automatic: boolean; enum_value: string | null;
      }>(`SELECT a.attname AS name,t.typname AS type,a.attnotnull AS required,
          (a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'') AS automatic,
          (SELECT enumlabel FROM pg_enum WHERE enumtypid=t.oid ORDER BY enumsortorder LIMIT 1) AS enum_value
        FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
        WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [table])).rows;
      const row: Record<string, unknown> = { tenant_id: tenantId };
      for (const field of fields) {
        if (field.name === "tenant_id" || !field.required || field.automatic) continue;
        const values: Record<string, unknown> = {
          uuid: randomUUID(), text: "fixture", varchar: "fixture", bpchar: "fixture",
          int2: 1, int4: 1, int8: 1, numeric: 1, float4: 1, float8: 1, bool: false,
          json: {}, jsonb: {}, date: "2026-10-17", time: "12:00:00", interval: "1 hour",
          timestamp: /end|expires/.test(field.name) ? "2026-10-17T13:00:00" : "2026-10-17T12:00:00",
          timestamptz: /end|expires/.test(field.name) ? "2026-10-17T13:00:00Z" : "2026-10-17T12:00:00Z",
          tstzrange: "[2026-10-17T12:00:00Z,2026-10-17T13:00:00Z)",
        };
        if (field.enum_value !== null) row[field.name] = field.enum_value;
        else if (field.type in values) row[field.name] = values[field.type];
        else throw new Error(`Cannot construct ${name}.${field.name} (${field.type})`);
      }
      const keys = (await tx.query<{ columns: string[]; references: string[]; table: string }>(`
        SELECT array(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY key(num,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=key.num ORDER BY key.ord) AS columns,
          array(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY key(num,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=key.num ORDER BY key.ord) AS references,
          k.confrelid::regclass::text AS table
        FROM pg_constraint k WHERE k.conrelid=$1::regclass AND k.contype='f'`, [table])).rows;
      let ready = true;
      for (const key of keys) {
        // A nullable relationship need not be populated by a minimal fixture.
        if (!key.columns.some((column) => column in row)) continue;
        const referenced = tables.find((candidate) => `public.${quote(candidate.name)}` === key.table || candidate.name === key.table || quote(candidate.name) === key.table);
        const referenceTable = referenced ? `public.${quote(referenced.name)}` : key.table;
        const record = (await tx.query(`select ${key.references.map(quote).join(",")} from ${referenceTable} ${referenced ? "where tenant_id=$1" : ""} limit 1`, referenced ? [tenantId] : [])).rows[0] as Record<string, unknown> | undefined;
        if (!record) { ready = false; break; }
        key.columns.forEach((column, i) => { row[column] = record[key.references[i]!]; });
      }
      if (!ready) continue;
      const columns = Object.keys(row).map(quote);
      await tx.query(`insert into ${table}(${columns.join(",")}) select ${columns.join(",")} from jsonb_populate_record(NULL::${table},$1::jsonb)`, [JSON.stringify(row)]);
      pending.delete(name);
      progress = true;
    }
    if (!progress) throw new Error(`Cannot resolve fixture dependencies: ${[...pending.keys()].join(", ")}`);
  }
}
