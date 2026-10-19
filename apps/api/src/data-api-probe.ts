// check:hosted's Data API (PostgREST) denial probe. As `anon` (the anon key) and as
// `authenticated` (a signed-in user claiming tenant A), every table the migrations create and
// every table the catalog holds in public and zs_internal must refuse SELECT, INSERT, UPDATE
// and DELETE through /rest/v1. The probes name the table's schema (Accept-Profile /
// Content-Profile), so a schema exposed later is probed too, not just the default one.
//
// No probe can change a row: INSERT sends only tenant_id (a random tenant B with no rows), which
// RLS, a NOT NULL column or the tenants foreign key refuses before anything lands; UPDATE sets
// tenant A's tenant_id to itself; DELETE matches only tenant B, which has no rows.
import { readdir, readFile } from "node:fs/promises";

export interface DataApiTable {
  readonly schema: string;
  readonly name: string;
}

export const DATA_API_OPERATIONS = ["select", "insert", "update", "delete"] as const;
export type DataApiOperation = (typeof DATA_API_OPERATIONS)[number];

export interface DataApiReply {
  readonly status: number;
  /** Row count when the body is a JSON array, else null. */
  readonly rows: number | null;
  /** PostgREST or Postgres error code from the body, else null. */
  readonly code: string | null;
}

export interface DataApiVerdict {
  readonly denied: boolean;
  /** refused: an explicit PostgREST or privilege error; empty: 200 with no rows; otherwise why it fails. */
  readonly reason: "refused" | "empty" | "rows returned" | "write accepted" | "unexpected reply";
}

// The name must be followed by its column list (or PARTITION OF / AS), so a format() template
// such as `CREATE TABLE public.%I` is not read as a table named "public".
const TABLE = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?=\s*\(|\s+(?:PARTITION|AS|OF)\b)/gi;

/** The tables CREATE TABLE statements make, schema-qualified (unqualified means public). Comments are skipped. */
export function tablesInMigrations(sqlTexts: readonly string[]): DataApiTable[] {
  const found: DataApiTable[] = [];
  for (const sql of sqlTexts) {
    const code = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of code.matchAll(TABLE)) found.push({ schema: (match[1] ?? "public").toLowerCase(), name: match[2]!.toLowerCase() });
  }
  return uniqueTables(found);
}

/** tablesInMigrations over every .sql file in the directory. */
export async function readMigrationTables(directory: URL): Promise<DataApiTable[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return tablesInMigrations(await Promise.all(files.map((name) => readFile(new URL(name, directory), "utf8"))));
}

const tableKey = (table: DataApiTable) => `${table.schema}.${table.name}`;

function uniqueTables(tables: readonly DataApiTable[]): DataApiTable[] {
  const byKey = new Map(tables.map((table) => [tableKey(table), table]));
  return [...byKey.values()].sort((a, b) => tableKey(a).localeCompare(tableKey(b)));
}

/**
 * The probe list: every migration table and every catalog table. A migration table missing
 * from the catalog means the probe ran against the wrong or an unmigrated database.
 */
export function tablesToProbe(fromMigrations: readonly DataApiTable[], fromCatalog: readonly DataApiTable[]) {
  const catalog = new Set(fromCatalog.map(tableKey));
  return {
    tables: uniqueTables([...fromMigrations, ...fromCatalog]),
    missingFromCatalog: fromMigrations.filter((table) => !catalog.has(tableKey(table))).map(tableKey),
  };
}

export interface DataApiContext {
  /** https://<ref>.supabase.co */
  readonly supabaseUrl: string;
  /** Sent as `apikey` on every probe; PostgREST needs it even with a user token. */
  readonly anonKey: string;
  readonly tenantA: string;
  /** A random tenant with no rows. */
  readonly tenantB: string;
}

/** The request for one probe; `bearer` is the anon key or the user's access token. */
export function dataApiRequest(table: DataApiTable, operation: DataApiOperation, bearer: string, context: DataApiContext): { url: string; init: RequestInit } {
  const base = `${context.supabaseUrl}/rest/v1/${encodeURIComponent(table.name)}`;
  const headers: Record<string, string> = { apikey: context.anonKey, Authorization: `Bearer ${bearer}`, Accept: "application/json" };
  if (operation === "select") return { url: `${base}?select=*&limit=5`, init: { method: "GET", headers: { ...headers, "Accept-Profile": table.schema } } };
  const write = { ...headers, "Content-Profile": table.schema, "Content-Type": "application/json", Prefer: "return=representation" };
  const tenant = (id: string) => `tenant_id=eq.${encodeURIComponent(id)}`;
  if (operation === "insert")
    return { url: base, init: { method: "POST", headers: write, body: JSON.stringify({ tenant_id: context.tenantB }) } };
  if (operation === "update")
    return { url: `${base}?${tenant(context.tenantA)}`, init: { method: "PATCH", headers: write, body: JSON.stringify({ tenant_id: context.tenantA }) } };
  return { url: `${base}?${tenant(context.tenantB)}`, init: { method: "DELETE", headers: write } };
}

const REFUSAL_STATUS = new Set([401, 403, 404, 406]);
const REFUSAL_CODE = /^(PGRST\d+|42501)$/;

/**
 * Only an explicit denial counts: 401/403/404/406 carrying a PostgREST (PGRST...) or Postgres
 * privilege (42501) code, or, for reads, updates and deletes, 200 with an empty array (RLS
 * left nothing visible). Any accepted insert fails, and so does an outage (5xx, HTML, no code).
 */
export function evaluateDataApiReply(operation: DataApiOperation | "rpc", reply: DataApiReply): DataApiVerdict {
  if (REFUSAL_STATUS.has(reply.status) && REFUSAL_CODE.test(reply.code ?? "")) return { denied: true, reason: "refused" };
  if (reply.status >= 200 && reply.status < 300) {
    if (operation === "insert" || operation === "rpc") return { denied: false, reason: "write accepted" };
    if (reply.status === 200 && reply.rows === 0) return { denied: true, reason: "empty" };
    if (reply.rows !== null && reply.rows > 0) return { denied: false, reason: "rows returned" };
  }
  return { denied: false, reason: "unexpected reply" };
}

/** Send one request and reduce the answer to status, row count and error code (never the rows). */
export async function sendDataApiRequest(doFetch: typeof fetch, request: { url: string; init: RequestInit }): Promise<DataApiReply> {
  const response = await doFetch(request.url, { ...request.init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  const body = await response.json().catch(() => null) as unknown;
  const code = (body as { code?: unknown } | null)?.code;
  return { status: response.status, rows: Array.isArray(body) ? body.length : null, code: typeof code === "string" ? code : null };
}

export interface DataApiProbeOptions extends DataApiContext {
  readonly fetch: typeof fetch;
  /** The signed-in tenant-A user's access token. */
  readonly userToken: string;
  readonly tables: readonly DataApiTable[];
  /** Migration tables the catalog lacks; any fails the probe. */
  readonly missingFromCatalog?: readonly string[];
}

type CallerResult = Record<DataApiOperation, string>;

/** Every table, both callers, all four operations. `ok` only when every probe was denied. */
export async function runDataApiProbes(options: DataApiProbeOptions) {
  const callers = { anon: options.anonKey, authenticated: options.userToken } as const;
  const failures: string[] = [];
  const tables: Record<string, Record<keyof typeof callers, CallerResult>> = {};
  for (const table of options.tables) {
    const row = {} as Record<keyof typeof callers, CallerResult>;
    for (const [caller, bearer] of Object.entries(callers) as [keyof typeof callers, string][]) {
      const result = {} as CallerResult;
      for (const operation of DATA_API_OPERATIONS) {
        let reply: DataApiReply;
        try {
          reply = await sendDataApiRequest(options.fetch, dataApiRequest(table, operation, bearer, options));
        } catch {
          reply = { status: 0, rows: null, code: null };
        }
        const verdict = evaluateDataApiReply(operation, reply);
        result[operation] = `${reply.status} ${reply.code ?? (reply.rows === null ? "-" : `${reply.rows} rows`)}: ${verdict.reason}`;
        if (!verdict.denied) failures.push(`${caller} ${operation} ${tableKey(table)} (${result[operation]})`);
      }
      row[caller] = result;
    }
    tables[tableKey(table)] = row;
  }
  const missing = options.missingFromCatalog ?? [];
  return {
    ok: options.tables.length > 0 && failures.length === 0 && missing.length === 0,
    detail: { probed: options.tables.length, failures, missingFromCatalog: missing, tables },
  };
}
