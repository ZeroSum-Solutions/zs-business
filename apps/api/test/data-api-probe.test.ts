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
const isRpc = (request: Seen) => request.url.pathname.startsWith("/rest/v1/rpc/");
const isControl = (request: Seen) => request.url.pathname.startsWith("/rest/v1/rpc/zs_probe_missing_");
const schemaOf = (request: Seen) => request.headers["Accept-Profile"] ?? request.headers["Content-Profile"];
const isUser = (request: Seen) => request.headers.Authorization === `Bearer ${USER_TOKEN}`;

/** PostgREST with public exposed: no such function for the control, permission denied for the action RPC, `tables` for the rest. */
const withRpcs = (tables: (request: Seen) => Answer) => (request: Seen): Answer => {
  if (isControl(request)) return { status: 404, body: { code: "PGRST202", message: "Could not find the function" } };
  if (isRpc(request)) return { status: isUser(request) ? 403 : 401, body: { code: "42501", message: "permission denied" } };
  return tables(request);
};

describe("tables to probe", () => {
  it("reads every table the migrations create, tenant_members included", async () => {
    const tables = await readMigrationTables(migrations);
    expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "public.actions", "public.agent_decisions", "public.agent_followups", "public.agent_global_switch", "public.agent_model_calls", "public.agent_runs", "public.agent_settings",
      "public.approvals", "public.automation_tokens", "public.booking_contacts", "public.booking_external_blocks", "public.booking_page_disclosures",
      "public.booking_page_resources",
      "public.booking_pages", "public.booking_resources", "public.bookings", "public.business_profiles",
      "public.calendar_connections", "public.calendar_push_notifications", "public.calendar_pushes",
      "public.crm_contact_consent", "public.crm_contacts", "public.crm_deals", "public.crm_pipelines", "public.crm_stages",
      "public.image_variants", "public.inbox_replies", "public.intake_item_consent", "public.intake_items", "public.media_assets", "public.message_deliveries",
      "public.message_delivery_attempts", "public.outbox", "public.rate_limit_buckets", "public.site_activations", "public.site_hosts",
      "public.site_pointers", "public.site_release_files", "public.site_releases", "public.sites", "public.sms_numbers", "public.sms_status_events", "public.source_records",
      "public.stripe_events", "public.suppressions", "public.tenant_members", "public.tenants", "public.transcription_jobs", "public.transcripts", "public.wallet_billing_events",
      "public.wallet_ledger", "public.wallet_reservations", "public.wallet_topups", "public.wallets", "public.webhook_deliveries",
      "public.webhook_delivery_attempts", "public.webhook_endpoints", "public.webhook_ingest_marks",
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
    expect(ok).toBe(true);
    expect(detail.probed).toBe(58);
    // Per caller: the control and the action RPC, then four operations on each table.
    expect(seen).toHaveLength(2 * 2 + 58 * 2 * 4);
    const tableProbes = seen.filter((request) => !isRpc(request));
    for (const operation of ["GET", "POST", "PATCH", "DELETE"])
      expect(tableProbes.filter((request) => request.method === operation)).toHaveLength(58 * 2);
    expect(seen.filter(isUser)).toHaveLength(2 + 58 * 4);
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
    expect(outage.detail.failures).toHaveLength(2 * 2 + 58 * 2 * 4);

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
