// check:hosted's Data API (PostgREST) denial probe. As `anon` (the anon key) and as
// `authenticated` (a signed-in user claiming tenant A), every table the migrations create and
// every table the catalog holds in public and zs_internal must refuse SELECT, INSERT, UPDATE
// and DELETE through /rest/v1. The probes name the table's schema (Accept-Profile /
// Content-Profile), so a schema exposed later is probed too, not just the default one.
//
// No probe can change a row: INSERT sends only tenant_id (a random tenant B with no rows), which
// RLS, a NOT NULL column or the tenants foreign key refuses before anything lands; UPDATE sets
// tenant A's tenant_id to itself; DELETE matches only tenant B, which has no rows.
//
// A refusal only counts when the Data API accepted the caller's credentials: a bad or expired
// token gets 401 for every request and so proves nothing about authorization. Before the
// tables, each caller calls an RPC that does not exist; PostgREST checks the token first, so
// "no such function" (or "schema not exposed") shows the token was accepted. Both callers also
// call the action RPC record_action_and_event, which must refuse them.
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
  /**
   * refused: permission denied or not exposed; empty: 200 with no rows. Otherwise why it fails;
   * "credentials rejected" is a 401 or JWT error, which says nothing about authorization.
   */
  readonly reason: "refused" | "empty" | "rows returned" | "write accepted" | "credentials rejected" | "unexpected reply";
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

/** PostgREST's JWT errors: no secret, a bad or expired token, no anonymous role, failed claims. */
const CREDENTIAL_CODES = new Set(["PGRST300", "PGRST301", "PGRST302", "PGRST303"]);

/**
 * The denials that count, by code and the status PostgREST sends with it: 42501 permission
 * denied (401 for anon, 403 for a signed-in role, also RLS refusing a new row), PGRST106 schema
 * not exposed (406), and PGRST205 or 42P01 table not exposed (404).
 */
const REFUSALS: Readonly<Record<string, readonly number[]>> = {
  "42501": [401, 403],
  PGRST106: [406],
  PGRST205: [404],
  "42P01": [404],
};

/** A caller's credentials were refused: a JWT error code, or a 401 that is not permission denied. */
export function credentialsRejected(reply: DataApiReply): boolean {
  return CREDENTIAL_CODES.has(reply.code ?? "") || (reply.status === 401 && reply.code !== "42501");
}

/**
 * Only an explicit denial counts: one of REFUSALS, or, for reads, updates and deletes, 200
 * with an empty array (RLS left nothing visible). Rejected credentials fail, since they prove
 * nothing about authorization; so does any accepted insert or RPC call and any outage (5xx,
 * HTML, no code) or other error.
 */
export function evaluateDataApiReply(operation: DataApiOperation | "rpc", reply: DataApiReply): DataApiVerdict {
  if (credentialsRejected(reply)) return { denied: false, reason: "credentials rejected" };
  if (REFUSALS[reply.code ?? ""]?.includes(reply.status)) return { denied: true, reason: "refused" };
  if (reply.status >= 200 && reply.status < 300) {
    if (operation === "insert" || operation === "rpc") return { denied: false, reason: "write accepted" };
    if (reply.status === 200 && reply.rows === 0) return { denied: true, reason: "empty" };
    if (reply.rows !== null && reply.rows > 0) return { denied: false, reason: "rows returned" };
  }
  return { denied: false, reason: "unexpected reply" };
}

/** The action RPC; the probe names its schema and sends every argument, so only a refusal stops it. */
export function actionRpcRequest(bearer: string, context: DataApiContext, generateId: () => string): { url: string; init: RequestInit } {
  const { tenantA } = context;
  return { url: `${context.supabaseUrl}/rest/v1/rpc/record_action_and_event`, init: {
    method: "POST",
    headers: rpcHeaders(bearer, context),
    body: JSON.stringify({
      p_tenant: tenantA, p_id: generateId(), p_actor: generateId(), p_type: "x", p_target: { tenantId: tenantA, id: generateId() },
      p_payload: {}, p_approval: { tenantId: tenantA, id: generateId() }, p_key: generateId(), p_result: {},
      p_created_at: "2026-01-01T00:00:00.000Z", p_event_id: generateId(), p_event_type: "x", p_event_payload: {},
    }),
  } };
}

/** The positive control: an RPC that does not exist. Only a caller whose token PostgREST accepted gets past the JWT check. */
export function controlRequest(bearer: string, context: DataApiContext, generateId: () => string): { url: string; init: RequestInit } {
  const name = `zs_probe_missing_${generateId().replaceAll("-", "")}`;
  return { url: `${context.supabaseUrl}/rest/v1/rpc/${name}`, init: { method: "POST", headers: rpcHeaders(bearer, context), body: "{}" } };
}

function rpcHeaders(bearer: string, context: DataApiContext): Record<string, string> {
  return {
    apikey: context.anonKey, Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json",
    "Content-Profile": "public", "Accept-Profile": "public",
  };
}

/** The control passes on "no such function" (404 PGRST202) or "schema not exposed" (406 PGRST106), both sent after the token check. */
export function evaluateControlReply(reply: DataApiReply): { accepted: boolean; reason: string } {
  if (credentialsRejected(reply)) return { accepted: false, reason: "credentials rejected" };
  if ((reply.status === 404 && reply.code === "PGRST202") || (reply.status === 406 && reply.code === "PGRST106"))
    return { accepted: true, reason: "token accepted" };
  return { accepted: false, reason: "unexpected reply" };
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
  /** Ids for the RPC arguments and the control's function name. */
  readonly generateId: () => string;
}

type CallerResult = Record<DataApiOperation, string>;
type Caller = "anon" | "authenticated";

const describeReply = (reply: DataApiReply, reason: string) =>
  `${reply.status} ${reply.code ?? (reply.rows === null ? "-" : `${reply.rows} rows`)}: ${reason}`;

/**
 * Both callers: the positive control, the action RPC, then every table with all four
 * operations. `ok` only when both controls show the token accepted and every probe was denied.
 */
export async function runDataApiProbes(options: DataApiProbeOptions) {
  const callers: Record<Caller, string> = { anon: options.anonKey, authenticated: options.userToken };
  const failures: string[] = [];
  const send = (request: { url: string; init: RequestInit }) =>
    sendDataApiRequest(options.fetch, request).catch((): DataApiReply => ({ status: 0, rows: null, code: null }));
  const control = {} as Record<Caller, string>;
  const actionRpc = {} as Record<Caller, string>;
  for (const [caller, bearer] of Object.entries(callers) as [Caller, string][]) {
    const controlReply = await send(controlRequest(bearer, options, options.generateId));
    const controlVerdict = evaluateControlReply(controlReply);
    control[caller] = describeReply(controlReply, controlVerdict.reason);
    if (!controlVerdict.accepted) failures.push(`${caller} control: the Data API did not accept the token (${control[caller]})`);
    const rpcReply = await send(actionRpcRequest(bearer, options, options.generateId));
    const rpcVerdict = evaluateDataApiReply("rpc", rpcReply);
    actionRpc[caller] = describeReply(rpcReply, rpcVerdict.reason);
    if (!rpcVerdict.denied) failures.push(`${caller} rpc public.record_action_and_event (${actionRpc[caller]})`);
  }
  const tables: Record<string, Record<Caller, CallerResult>> = {};
  for (const table of options.tables) {
    const row = {} as Record<Caller, CallerResult>;
    for (const [caller, bearer] of Object.entries(callers) as [Caller, string][]) {
      const result = {} as CallerResult;
      for (const operation of DATA_API_OPERATIONS) {
        const reply = await send(dataApiRequest(table, operation, bearer, options));
        const verdict = evaluateDataApiReply(operation, reply);
        result[operation] = describeReply(reply, verdict.reason);
        if (!verdict.denied) failures.push(`${caller} ${operation} ${tableKey(table)} (${result[operation]})`);
      }
      row[caller] = result;
    }
    tables[tableKey(table)] = row;
  }
  const missing = options.missingFromCatalog ?? [];
  return {
    ok: options.tables.length > 0 && failures.length === 0 && missing.length === 0,
    detail: { probed: options.tables.length, failures, missingFromCatalog: missing, control, actionRpc, tables },
  };
}
