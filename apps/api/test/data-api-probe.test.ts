import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
const schemaOf = (request: Seen) => request.headers["Accept-Profile"] ?? request.headers["Content-Profile"];
const isUser = (request: Seen) => request.headers.Authorization === `Bearer ${USER_TOKEN}`;

describe("tables to probe", () => {
  it("reads every table the migrations create, tenant_members included", async () => {
    const tables = await readMigrationTables(migrations);
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "public.actions", "public.booking_external_blocks", "public.booking_resources", "public.bookings",
      "public.crm_contact_consent", "public.crm_contacts", "public.crm_deals", "public.crm_pipelines", "public.crm_stages",
      "public.outbox", "public.tenant_members", "public.tenants",
    ]);
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
    const result = await runDataApiProbes({ ...context, fetch: postgrest.fetch, userToken: USER_TOKEN,
      tables: extra.tables ?? await tablesPromise, ...(extra.missingFromCatalog ? { missingFromCatalog: extra.missingFromCatalog } : {}) });
    return { ...result, seen: postgrest.seen };
  };

  it("passes when only graphql_public is exposed: every table, both callers, all four operations refused", async () => {
    const { ok, detail, seen } = await run(() => ({ status: 406, body: { code: "PGRST106", message: "Invalid schema" } }));
    expect(ok).toBe(true);
    expect(detail.probed).toBe(12);
    expect(seen).toHaveLength(12 * 2 * 4);
    for (const operation of ["GET", "POST", "PATCH", "DELETE"])
      expect(seen.filter((request) => request.method === operation)).toHaveLength(24);
    expect(seen.filter(isUser)).toHaveLength(48);
    expect(seen.every((request) => request.headers.apikey === ANON_KEY && schemaOf(request) === "public")).toBe(true);
    expect(detail.tables["public.tenant_members"]!.authenticated.select).toBe("406 PGRST106: refused");
  });

  it("passes when public is exposed but RLS hides every row and refuses every insert", async () => {
    const { ok } = await run((request) => request.method === "POST"
      ? { status: 403, body: { code: "42501", message: "new row violates row-level security policy" } }
      : { status: 200, body: [] });
    expect(ok).toBe(true);
  });

  it("fails when the signed-in user can read tenant_members, naming the table, caller and operation", async () => {
    const { ok, detail } = await run((request) =>
      isUser(request) && request.method === "GET" && tableOf(request) === "tenant_members"
        ? { status: 200, body: [{ tenant_id: context.tenantA, email: "owner@example.com" }] }
        : { status: 404, body: { code: "PGRST205" } });
    expect(ok).toBe(false);
    expect(detail.failures).toEqual(["authenticated select public.tenant_members (200 1 rows: rows returned)"]);
  });

  it("fails on an accepted write, an outage, an unreachable API, missing catalog tables, or nothing to probe", async () => {
    const insertAccepted = await run((request) => request.method === "POST" && tableOf(request) === "crm_contacts" && !isUser(request)
      ? { status: 201, body: [{}] } : { status: 401, body: { code: "42501" } });
    expect(insertAccepted.ok).toBe(false);
    expect(insertAccepted.detail.failures).toEqual(["anon insert public.crm_contacts (201 1 rows: write accepted)"]);

    const outage = await run(() => ({ status: 502, html: true }));
    expect(outage.ok).toBe(false);
    expect(outage.detail.failures).toHaveLength(96);

    const unreachable = fakePostgrest(() => ({ status: 200 }));
    const thrown = await runDataApiProbes({ ...context, userToken: USER_TOKEN, tables: [{ schema: "public", name: "tenants" }],
      fetch: (async (...args: Parameters<typeof fetch>) => {
        await unreachable.fetch(...args);
        throw new TypeError("fetch failed");
      }) as typeof fetch });
    expect(thrown.ok).toBe(false);
    expect(thrown.detail.failures[0]).toMatch(/^anon select public.tenants \(0 -: unexpected reply\)$/);

    const refused = () => ({ status: 404, body: { code: "PGRST205" } });
    expect((await run(refused, { missingFromCatalog: ["public.tenant_members"] })).ok).toBe(false);
    expect((await run(refused, { tables: [] })).ok).toBe(false);
  });
});
