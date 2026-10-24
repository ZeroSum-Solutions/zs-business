import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "@zs/db/testing";
import {
  dataApiRequest,
  evaluateDataApiReply,
  readMigrationTables,
  runDataApiProbes,
  tablesInMigrations,
  tablesToProbe,
  type DataApiTable,
} from "../src/data-api-probe.js";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
/** Created by the migration runner, not by a migration file. */
const RUNNER_TABLES = ["zs_internal.schema_migrations"];
const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const ANON_KEY = "anon-key-for-tests";
const USER_TOKEN = "user.token.for-tests";
const context = { supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY, tenantA: randomUUID(), tenantB: randomUUID() };

interface Seen { method: string; url: URL; headers: Record<string, string>; body: unknown }
type Answer = { status: number; body?: unknown; html?: boolean };

/** A fake PostgREST: `answer` decides each reply from the request; every request is recorded. */
function fakePostgrest(answer: (request: Seen) => Answer) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: Seen = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    };
    seen.push(request);
    const reply = answer(request);
    if (reply.html) return new Response("<html>Bad gateway</html>", { status: reply.status, headers: { "Content-Type": "text/html" } });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const tableOf = (request: Seen) => decodeURIComponent(request.url.pathname.split("/").at(-1)!);
const isRpc = (request: Seen) => request.url.pathname.startsWith("/rest/v1/rpc/");
const isControl = (request: Seen) => request.url.pathname.startsWith("/rest/v1/rpc/zs_probe_missing_");
const schemaOf = (request: Seen) => request.headers["Accept-Profile"] ?? request.headers["Content-Profile"];
const isUser = (request: Seen) => request.headers.Authorization === `Bearer ${USER_TOKEN}`;

const CATALOG_TABLES = `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','zs_internal') AND c.relkind IN ('r','p','v','m','f') ORDER BY 1,2`;

/** Tables the migrations name that the catalog lacks, and catalog tables the migrations do not name. */
async function coverageGaps(pool: Pool, fromMigrations: readonly DataApiTable[]): Promise<string[]> {
  const fromCatalog = (await pool.query<DataApiTable>(CATALOG_TABLES)).rows;
  const { tables, missingFromCatalog } = tablesToProbe(fromMigrations, fromCatalog);
  const parsed = new Set(fromMigrations.map((table) => `${table.schema}.${table.name}`));
  return [
    ...missingFromCatalog.map((name) => `migration table not in catalog: ${name}`),
    ...tables.map((table) => `${table.schema}.${table.name}`)
      .filter((name) => !parsed.has(name) && !RUNNER_TABLES.includes(name))
      .map((name) => `catalog table not in migrations: ${name}`),
  ];
}

/**
 * The catalog rule behind the probe: every public table has RLS enabled and forced, and no
 * table in public or zs_internal is granted (table or column) to PUBLIC or anon; zs_internal
 * is granted to no API role at all.
 */
async function exposureViolations(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ violation: string }>(`
    WITH t AS (
      SELECT c.oid, n.nspname AS schema, format('%s.%s', n.nspname, c.relname) AS name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','zs_internal') AND c.relkind IN ('r','p','v','m','f')
    ), grantees AS (
      SELECT DISTINCT t.name, CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee)::text END AS grantee
      FROM t, LATERAL (
        SELECT (aclexplode(c.relacl)).grantee FROM pg_class c WHERE c.oid=t.oid
        UNION ALL SELECT (aclexplode(a.attacl)).grantee FROM pg_attribute a WHERE a.attrelid=t.oid AND NOT a.attisdropped
      ) acl
      WHERE acl.grantee=0 OR pg_get_userbyid(acl.grantee) = 'anon'
        OR (t.schema='zs_internal' AND pg_get_userbyid(acl.grantee) IN ('authenticated','service_role'))
    )
    SELECT name || ': RLS not enabled' AS violation FROM t WHERE schema='public' AND NOT relrowsecurity
    UNION ALL SELECT name || ': RLS not forced' FROM t WHERE schema='public' AND NOT relforcerowsecurity
    UNION ALL SELECT name || ': granted to ' || grantee FROM grantees`);
  // Sorted here, not in SQL: ORDER BY follows the cluster's collation, which differs between machines.
  return rows.map((row) => row.violation).sort();
}

/** PostgREST with public exposed: no such function for the control, permission denied for the action RPC, `tables` for the rest. */
const withRpcs = (tables: (request: Seen) => Answer) => (request: Seen): Answer => {
  if (isControl(request)) return { status: 404, body: { code: "PGRST202", message: "Could not find the function" } };
  if (isRpc(request)) return { status: isUser(request) ? 403 : 401, body: { code: "42501", message: "permission denied" } };
  return tables(request);
};

describe("tables to probe", () => {
  it("reads every table the migrations create, tenant_members included: exactly the tables a migrated catalog holds", async () => {
    const tables = await readMigrationTables(migrations);
    expect(tables).toContainEqual({ schema: "public", name: "tenant_members" });
    await withTestDatabase(async (database) => {
      expect(await coverageGaps(database.pool, tables)).toEqual([]);
      // Negative case: a table the parser cannot see (SELECT INTO) is named as a gap.
      await database.pool.query("SELECT 1 AS id INTO public.zs_probe_unparsed");
      expect(await coverageGaps(database.pool, tables)).toEqual(["catalog table not in migrations: public.zs_probe_unparsed"]);
    });
  });

  it("every table the probe expects to be refused is refused by the catalog too: forced RLS, no PUBLIC or anon grant", async () => {
    await withTestDatabase(async (database) => {
      expect(await exposureViolations(database.pool)).toEqual([]);
      // Negative case: a table without RLS, granted to PUBLIC, fails the rule by name.
      await database.pool.query(`CREATE TABLE public.zs_probe_exposed (tenant_id uuid);
        GRANT SELECT ON public.zs_probe_exposed TO PUBLIC; GRANT SELECT ON zs_internal.schema_migrations TO authenticated`);
      expect(await exposureViolations(database.pool)).toEqual([
        "public.zs_probe_exposed: RLS not enabled", "public.zs_probe_exposed: RLS not forced", "public.zs_probe_exposed: granted to PUBLIC",
        "zs_internal.schema_migrations: granted to authenticated",
      ].sort());
    });
  });

  it("parses qualified, quoted and IF NOT EXISTS names, and skips comments and format() templates", () => {
    expect(tablesInMigrations([`
      -- CREATE TABLE public.commented_out (id int);
      /* CREATE TABLE ghost (id int); */
      CREATE TABLE IF NOT EXISTS zs_internal.ledger (id int);
      create table "Quoted" (id int);
      CREATE TABLE plain(id int);
      EXECUTE format($f$CREATE TABLE public.%I (id int)$f$, t);
      CREATE TABLE public.part_2026 PARTITION OF public.parent FOR VALUES IN (1);
    `])).toEqual([
      { schema: "public", name: "part_2026" }, { schema: "public", name: "plain" }, { schema: "public", name: "quoted" },
      { schema: "zs_internal", name: "ledger" },
    ]);
  });

  it("probes the union of migrations and catalog and names migration tables the catalog lacks", () => {
    const fromMigrations: DataApiTable[] = [{ schema: "public", name: "tenants" }, { schema: "public", name: "tenant_members" }];
    const fromCatalog: DataApiTable[] = [{ schema: "public", name: "tenants" }, { schema: "zs_internal", name: "schema_migrations" }];
    expect(tablesToProbe(fromMigrations, fromCatalog)).toEqual({
      tables: [{ schema: "public", name: "tenant_members" }, { schema: "public", name: "tenants" }, { schema: "zs_internal", name: "schema_migrations" }],
      missingFromCatalog: ["public.tenant_members"],
    });
  });
});

describe("dataApiRequest", () => {
  const table = { schema: "public", name: "tenant_members" };

  it("names the schema and sends the anon key as apikey with the caller's bearer", () => {
    const select = dataApiRequest(table, "select", USER_TOKEN, context);
    expect(select.url).toBe(`${SUPABASE_URL}/rest/v1/tenant_members?select=*&limit=5`);
    expect(select.init).toMatchObject({ method: "GET",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${USER_TOKEN}`, "Accept-Profile": "public" } });
  });

  it("writes can change no row: insert names tenant B, update sets tenant A's id to itself, delete matches tenant B", () => {
    const insert = dataApiRequest(table, "insert", ANON_KEY, context);
    expect(insert.init).toMatchObject({ method: "POST", headers: { "Content-Profile": "public", Prefer: "return=representation" } });
    expect(JSON.parse(String(insert.init.body))).toEqual({ tenant_id: context.tenantB });
    const update = dataApiRequest(table, "update", ANON_KEY, context);
    expect(update.url).toBe(`${SUPABASE_URL}/rest/v1/tenant_members?tenant_id=eq.${context.tenantA}`);
    expect(update.init.method).toBe("PATCH");
    expect(JSON.parse(String(update.init.body))).toEqual({ tenant_id: context.tenantA });
    const remove = dataApiRequest(table, "delete", ANON_KEY, context);
    expect(remove.url).toBe(`${SUPABASE_URL}/rest/v1/tenant_members?tenant_id=eq.${context.tenantB}`);
    expect(remove.init).toMatchObject({ method: "DELETE" });
    expect(remove.init.body).toBeUndefined();
  });
});

describe("evaluateDataApiReply", () => {
  it.each([
    ["select", { status: 404, rows: null, code: "PGRST205" }, true, "refused"],
    ["insert", { status: 406, rows: null, code: "PGRST106" }, true, "refused"],
    ["update", { status: 401, rows: null, code: "42501" }, true, "refused"],
    ["delete", { status: 403, rows: null, code: "42501" }, true, "refused"],
    ["select", { status: 404, rows: null, code: "42P01" }, true, "refused"],
    ["rpc", { status: 403, rows: null, code: "42501" }, true, "refused"],
    ["rpc", { status: 406, rows: null, code: "PGRST106" }, true, "refused"],
    // A bad, expired or missing token proves nothing about authorization.
    ["select", { status: 401, rows: null, code: "PGRST301" }, false, "credentials rejected"],
    ["insert", { status: 401, rows: null, code: "PGRST302" }, false, "credentials rejected"],
    ["delete", { status: 401, rows: null, code: "PGRST303" }, false, "credentials rejected"],
    ["update", { status: 500, rows: null, code: "PGRST300" }, false, "credentials rejected"],
    ["rpc", { status: 401, rows: null, code: "PGRST301" }, false, "credentials rejected"],
    ["select", { status: 401, rows: null, code: null }, false, "credentials rejected"],
    // Only the listed denials, with the status PostgREST sends for each.
    ["select", { status: 404, rows: null, code: "PGRST202" }, false, "unexpected reply"],
    ["rpc", { status: 404, rows: null, code: "PGRST202" }, false, "unexpected reply"],
    ["select", { status: 400, rows: null, code: "PGRST100" }, false, "unexpected reply"],
    ["select", { status: 403, rows: null, code: "PGRST106" }, false, "unexpected reply"],
    ["update", { status: 406, rows: null, code: "PGRST116" }, false, "unexpected reply"],
    ["select", { status: 200, rows: 0, code: null }, true, "empty"],
    ["update", { status: 200, rows: 0, code: null }, true, "empty"],
    ["delete", { status: 200, rows: 0, code: null }, true, "empty"],
    ["select", { status: 200, rows: 3, code: null }, false, "rows returned"],
    ["delete", { status: 200, rows: 1, code: null }, false, "rows returned"],
    ["insert", { status: 201, rows: 1, code: null }, false, "write accepted"],
    ["insert", { status: 201, rows: 0, code: null }, false, "write accepted"],
    ["rpc", { status: 200, rows: null, code: null }, false, "write accepted"],
    ["update", { status: 204, rows: null, code: null }, false, "unexpected reply"],
    ["select", { status: 503, rows: null, code: null }, false, "unexpected reply"],
    ["select", { status: 404, rows: null, code: null }, false, "unexpected reply"],
    ["insert", { status: 400, rows: null, code: "23502" }, false, "unexpected reply"],
    ["select", { status: 0, rows: null, code: null }, false, "unexpected reply"],
  ] as const)("%s %j: denied %s (%s)", (operation, reply, denied, reason) => {
    expect(evaluateDataApiReply(operation, reply)).toEqual({ denied, reason });
  });
});

describe("runDataApiProbes against a fake PostgREST", () => {
  const tablesPromise = readMigrationTables(migrations);
  const run = async (answer: (request: Seen) => Answer, extra: { missingFromCatalog?: string[]; tables?: DataApiTable[] } = {}) => {
    const postgrest = fakePostgrest(answer);
    const result = await runDataApiProbes({ ...context, fetch: postgrest.fetch, userToken: USER_TOKEN, generateId: randomUUID,
      tables: extra.tables ?? await tablesPromise, ...(extra.missingFromCatalog ? { missingFromCatalog: extra.missingFromCatalog } : {}) });
    return { ...result, seen: postgrest.seen };
  };

  it("passes when only graphql_public is exposed: every table, both callers, all four operations refused", async () => {
    const { ok, detail, seen } = await run(() => ({ status: 406, body: { code: "PGRST106", message: "Invalid schema" } }));
    const tables = (await tablesPromise).length;
    expect(ok).toBe(true);
    expect(tables).toBeGreaterThan(0);
    expect(detail.probed).toBe(tables);
    // Per caller: the control and the action RPC, then four operations on each table.
    expect(seen).toHaveLength(2 * 2 + tables * 2 * 4);
    const tableProbes = seen.filter((request) => !isRpc(request));
    for (const operation of ["GET", "POST", "PATCH", "DELETE"])
      expect(tableProbes.filter((request) => request.method === operation)).toHaveLength(tables * 2);
    expect(seen.filter(isUser)).toHaveLength(2 + tables * 4);
    expect(detail.control).toEqual({ anon: "406 PGRST106: token accepted", authenticated: "406 PGRST106: token accepted" });
    expect(seen.every((request) => request.headers.apikey === ANON_KEY && schemaOf(request) === "public")).toBe(true);
    expect(detail.tables["public.tenant_members"]!.authenticated.select).toBe("406 PGRST106: refused");
  });

  it("passes when public is exposed but RLS hides every row and refuses every insert", async () => {
    const { ok, detail } = await run(withRpcs((request) => request.method === "POST"
      ? { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } }
      : { status: 200, body: [] }));
    expect(ok).toBe(true);
    expect(detail.control).toEqual({ anon: "404 PGRST202: token accepted", authenticated: "404 PGRST202: token accepted" });
    expect(detail.actionRpc).toEqual({ anon: "401 42501: refused", authenticated: "403 42501: refused" });
  });

  it("fails when the signed-in user can read tenant_members, naming the table, caller and operation", async () => {
    const { ok, detail } = await run(withRpcs((request) =>
      isUser(request) && request.method === "GET" && tableOf(request) === "tenant_members"
        ? { status: 200, body: [{ tenant_id: context.tenantA, email: "owner@example.com" }] }
        : { status: 404, body: { code: "PGRST205" } }));
    expect(ok).toBe(false);
    expect(detail.failures).toEqual(["authenticated select public.tenant_members (200 1 rows: rows returned)"]);
  });

  it("fails on an accepted write, an outage, an unreachable API, missing catalog tables, or nothing to probe", async () => {
    const insertAccepted = await run(withRpcs((request) => request.method === "POST" && tableOf(request) === "crm_contacts" && !isUser(request)
      ? { status: 201, body: [{}] } : { status: 401, body: { code: "42501" } }));
    expect(insertAccepted.ok).toBe(false);
    expect(insertAccepted.detail.failures).toEqual(["anon insert public.crm_contacts (201 1 rows: write accepted)"]);

    const outage = await run(() => ({ status: 502, html: true }));
    expect(outage.ok).toBe(false);
    expect(outage.detail.failures).toHaveLength(2 * 2 + (await tablesPromise).length * 2 * 4);

    const unreachable = fakePostgrest(() => ({ status: 200 }));
    const thrown = await runDataApiProbes({ ...context, userToken: USER_TOKEN, generateId: randomUUID, tables: [{ schema: "public", name: "tenants" }],
      fetch: (async (...args: Parameters<typeof fetch>) => {
        await unreachable.fetch(...args);
        throw new TypeError("fetch failed");
      }) as typeof fetch });
    expect(thrown.ok).toBe(false);
    expect(thrown.detail.failures).toContain("anon select public.tenants (0 -: unexpected reply)");

    const refused = withRpcs(() => ({ status: 404, body: { code: "PGRST205" } }));
    expect((await run(refused, { missingFromCatalog: ["public.tenant_members"] })).ok).toBe(false);
    expect((await run(refused, { tables: [] })).ok).toBe(false);
  });

  it("fails when the Data API rejects the signed-in token, even though every request is 'refused'", async () => {
    // An expired or forged user token: PostgREST answers 401 PGRST301 before any authorization.
    const { ok, detail } = await run((request) => isUser(request)
      ? { status: 401, body: { code: "PGRST301", message: "JWT expired" } }
      : withRpcs(() => ({ status: 404, body: { code: "PGRST205" } }))(request));
    expect(ok).toBe(false);
    expect(detail.control.authenticated).toBe("401 PGRST301: credentials rejected");
    expect(detail.failures[0]).toBe("authenticated control: the Data API did not accept the token (401 PGRST301: credentials rejected)");
    expect(detail.failures).toContain("authenticated select public.tenant_members (401 PGRST301: credentials rejected)");
    expect(detail.failures.filter((failure) => failure.startsWith("anon"))).toEqual([]);
  });

  it("fails the control on anything but 'no such function' or 'schema not exposed'", async () => {
    const { ok, detail } = await run((request) => isControl(request) && !isUser(request)
      ? { status: 200, body: [] }
      : withRpcs(() => ({ status: 404, body: { code: "PGRST205" } }))(request));
    expect(ok).toBe(false);
    expect(detail.failures).toEqual(["anon control: the Data API did not accept the token (200 0 rows: unexpected reply)"]);
  });

  it("calls the action RPC in the public schema with every argument, as both callers, and fails when it runs", async () => {
    const { ok, detail, seen } = await run((request) => tableOf(request) === "record_action_and_event" && isUser(request)
      ? { status: 200, body: { id: "x" } }
      : withRpcs(() => ({ status: 404, body: { code: "PGRST205" } }))(request));
    expect(ok).toBe(false);
    expect(detail.failures).toEqual(["authenticated rpc public.record_action_and_event (200 -: write accepted)"]);
    const calls = seen.filter((request) => tableOf(request) === "record_action_and_event");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("POST");
      expect(call.headers).toMatchObject({ apikey: ANON_KEY, "Content-Profile": "public", "Accept-Profile": "public" });
      expect(Object.keys(call.body as object).sort()).toEqual([
        "p_actor", "p_approval", "p_created_at", "p_event_id", "p_event_payload", "p_event_type", "p_id", "p_key",
        "p_payload", "p_result", "p_target", "p_tenant", "p_type",
      ]);
      expect(call.body).toMatchObject({ p_tenant: context.tenantA, p_target: { tenantId: context.tenantA }, p_approval: { tenantId: context.tenantA } });
    }
    expect(calls.map(isUser).sort()).toEqual([false, true]);
    expect(seen.filter(isControl).every((request) => request.headers["Content-Profile"] === "public")).toBe(true);
  });
});
