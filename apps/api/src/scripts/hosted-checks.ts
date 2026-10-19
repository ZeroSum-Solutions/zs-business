// Entry point, owner-run: negative checks against one hosted project and its deploys.
// Reads nothing but checks; the only write is one temporary Supabase Auth user (a
// synthetic example.com address, no email sent) for the Data API check, deleted at the end.
//   ZS_TARGET_REF, RUNTIME_DATABASE_URL, MIGRATOR_DATABASE_URL   as for hosted-migrate/seed
//   SUPABASE_ACCESS_TOKEN    Management API, to read the project's API keys
//   API_URL                  the deployed API, for example https://api.zerosumsolutions.com
//   DASHBOARD_URL            the deployed dashboard
//   JWT_SECRET, JWT_ISSUER   the API's token settings, to mint five-minute test tokens
//   ZS_TENANT_ID             the seeded tenant (tenant A); tenant B is random and empty
//   VERCEL_PROTECTION_BYPASS optional: passes Vercel Authentication on a protected preview
// Prints one JSON report and exits 1 if any check fails.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { assertRuntimeLogin, createScopedDatabase } from "@zs/db";
import { signDevToken } from "../dev-token.js";
import { poolerTransport, sessionContaminationProbe } from "../hosted-probes.js";
import { assertHostedDatabaseUrl, hostedPool, redactSecrets } from "../hosted.js";

const env = process.env;
const projectRef = env.ZS_TARGET_REF ?? "";
const runtimeTarget = assertHostedDatabaseUrl(env.RUNTIME_DATABASE_URL ?? "", { projectRef, role: "zs_runtime" });
const migratorTarget = assertHostedDatabaseUrl(env.MIGRATOR_DATABASE_URL ?? "", { projectRef, role: "zs_migrator" });
const apiUrl = new URL(env.API_URL ?? "").origin;
const dashboardUrl = new URL(env.DASHBOARD_URL ?? "").origin;
const tenantA = env.ZS_TENANT_ID ?? "";
const tenantB = randomUUID();
const supabaseUrl = `https://${projectRef}.supabase.co`;
const clock = { now: () => new Date() };

interface Result { name: string; ok: boolean; detail: unknown }
const results: Result[] = [];
async function check(name: string, run: () => Promise<{ ok: boolean; detail?: unknown }>) {
  try {
    const { ok, detail } = await run();
    results.push({ name, ok, detail: detail ?? null });
  } catch (error) {
    results.push({ name, ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
  }
}

const runtime = hostedPool(runtimeTarget, 10);
// Pooler mode of the runtime URL: 6543 is Supavisor transaction mode, as the API uses.
const transport = poolerTransport(runtimeTarget.port);
// Every scoped transaction here reports a failed session reset; any one fails the run.
const resetFailures: string[] = [];
const scopedOptions = { onResetFailure: (error: unknown) => { resetFailures.push(redactSecrets(String(error))); } };
const migrator = hostedPool(migratorTarget, 1);
const tokenFor = (tenantId: string, actorId: string, issuer = env.JWT_ISSUER) =>
  signDevToken(env.JWT_SECRET ?? "", { tenantId, actorId }, clock, 300, issuer);
const tokenA = await tokenFor(tenantA, randomUUID());
const tokenB = await tokenFor(tenantB, randomUUID());
const api = async (path: string, token: string | null, init: RequestInit = {}) => {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json", "Idempotency-Key": randomUUID() } : {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
};
const TENANT_TABLES = (await runtime.query<{ name: string }>(
  `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
   ORDER BY 1`)).rows.map((row) => row.name);

try {
  // --- Database roles -------------------------------------------------------------------
  await check("runtime login is unprivileged and a member of authenticated only", async () => {
    const row = (await runtime.query(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
              array(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname=session_user`)).rows[0];
    await assertRuntimeLogin(runtime);
    return { ok: !row.rolsuper && !row.rolbypassrls && !row.rolcreaterole && !row.rolcreatedb && !row.rolreplication
      && JSON.stringify(row.member_of) === '["authenticated"]', detail: row };
  });
  await check("API startup guard refuses the migrator login", async () => {
    const refused = await assertRuntimeLogin(migrator).then(() => false, () => true);
    return { ok: refused };
  });
  await check("scoped transactions refuse the migrator login", async () => {
    const refused = await createScopedDatabase(migrator, scopedOptions).tenant(tenantA, async () => true).then(() => false, () => true);
    return { ok: refused };
  });
  await check("runtime cannot SET ROLE to owners or privileged roles", async () => {
    const targets = ["zs_migrator", "zs_dispatcher", "zs_function_owner", "postgres", "service_role", "anon", "authenticator", "supabase_admin"];
    const outcome: Record<string, string> = {};
    const client = await runtime.connect();
    try {
      for (const role of targets) {
        await client.query("BEGIN");
        outcome[role] = await client.query(`SET LOCAL ROLE ${role}`).then(() => "ALLOWED", (error: { code?: string }) => `refused ${error.code}`);
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN");
      outcome["session authorization postgres"] = await client.query("SET LOCAL SESSION AUTHORIZATION postgres")
        .then(() => "ALLOWED", (error: { code?: string }) => `refused ${error.code}`);
      await client.query("ROLLBACK");
    } finally {
      client.release(true);
    }
    return { ok: Object.values(outcome).every((value) => value.startsWith("refused")), detail: outcome };
  });
  await check("every tenant table is owned by zs_migrator, forces RLS, and grants anon nothing", async () => {
    const rows = (await runtime.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon_any
         FROM pg_class c WHERE c.relname = ANY($1) AND c.relnamespace='public'::regnamespace`, [TENANT_TABLES])).rows;
    return { ok: rows.length === TENANT_TABLES.length && rows.length >= 10
      && rows.every((row) => row.owner === "zs_migrator" && row.rls && row.forced && !row.anon_any), detail: rows };
  });
  let contactsA = -1;
  await check("runtime sees tenant A rows only under tenant A, none under tenant B or no tenant", async () => {
    const counts = async (tenant: string | null) => {
      const client = await runtime.connect();
      try {
        await client.query("BEGIN; SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant ?? ""]);
        const out: Record<string, number> = {};
        for (const table of TENANT_TABLES)
          out[table] = (await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id=$1`, [tenantA])).rows[0].n;
        await client.query("ROLLBACK");
        return out;
      } finally {
        client.release();
      }
    };
    const a = await counts(tenantA);
    const b = await counts(tenantB);
    const none = await counts(null);
    // The seed makes 12 contacts; pilot use may add more. Later checks compare with this count.
    contactsA = a.crm_contacts ?? 0;
    return { ok: contactsA >= 12 && Object.values(b).every((n) => n === 0) && Object.values(none).every((n) => n === 0), detail: { a, b, none } };
  });
  await check("runtime cannot write history or tenants directly", async () => {
    // Each probe throws after its statement, so even an allowed write rolls back and never
    // touches tenant A's records.
    const rolledBack = new Error("probe rolled back");
    const attempt = (sql: string) => createScopedDatabase(runtime, scopedOptions).tenant(tenantA, async (tx) => {
      await tx.query(sql, [tenantA]);
      throw rolledBack;
    }).then(() => "ALLOWED", (error: { code?: string }) => error === rolledBack ? "ALLOWED (rolled back)" : `refused ${error.code}`);
    const outcome = {
      insertAction: await attempt(`INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
        VALUES ($1,gen_random_uuid(),gen_random_uuid(),'x','{}','{}','k','{}',now())`),
      deleteOutbox: await attempt("DELETE FROM outbox WHERE tenant_id=$1"),
      renameTenant: await attempt("UPDATE tenants SET name='x' WHERE tenant_id=$1"),
      deleteBooking: await attempt("DELETE FROM bookings WHERE tenant_id=$1"),
    };
    return { ok: Object.values(outcome).every((value) => value.startsWith("refused")), detail: outcome };
  });
  await check("pooled runtime connections keep tenants apart under 200 concurrent transactions", async () => {
    const scoped = createScopedDatabase(runtime, scopedOptions);
    const jobs = Array.from({ length: 200 }, (_, index) => {
      const tenant = index % 2 === 0 ? tenantA : tenantB;
      return scoped.tenant(tenant, async (tx) => {
        const row = (await tx.query<{ setting: string; contacts: number; foreign: number }>(
          `SELECT current_setting('app.tenant_id') AS setting, (SELECT count(*)::int FROM crm_contacts) AS contacts,
                  (SELECT count(*)::int FROM crm_contacts WHERE tenant_id <> $1) AS foreign, pg_sleep(random()*0.05)`, [tenant])).rows[0]!;
        return { tenant, ...row };
      });
    });
    const rows = await Promise.all(jobs);
    const bad = rows.filter((row) => row.setting !== row.tenant || row.foreign !== 0 || row.contacts !== (row.tenant === tenantA ? contactsA : 0));
    return { ok: bad.length === 0, detail: { transport, total: rows.length, bad: bad.slice(0, 5) } };
  });
  await check("pooled runtime sessions carry no session state into later transactions", async () => {
    // Tenant A and B alike: the probe reads only settings, never rows.
    const probe = await sessionContaminationProbe(createScopedDatabase(runtime, scopedOptions), tenantB);
    return { ok: probe.ok, detail: { transport, ...probe.detail } };
  });
  await check("no scoped transaction failed its session reset", async () =>
    ({ ok: resetFailures.length === 0, detail: { transport, failures: resetFailures.length, first: resetFailures.slice(0, 3) } }));

  // --- HTTP API -------------------------------------------------------------------------
  const resources = await api("/v1/booking/resources", tokenA);
  const resourceId = (resources.body?.items as { id: string }[] | undefined)?.[0]?.id ?? "";
  const deals = await api("/v1/crm/deals?limit=1", tokenA);
  const deal = (deals.body?.items as { id: string; pipelineId: string; stageId: string; revision: number }[] | undefined)?.[0];
  await check("API: tenant A reads its own records", async () => {
    // Page through every contact so the total compares with the SQL count.
    let total = 0;
    let statuses: number[] = [];
    for (let offset: number | null = 0, pages = 0; offset !== null && pages < 100; pages += 1) {
      const page = await api(`/v1/crm/contacts?limit=100&offset=${offset}`, tokenA);
      statuses = [...statuses, page.status];
      if (page.status !== 200) break;
      total += (page.body?.items as unknown[] | undefined)?.length ?? 0;
      offset = (page.body?.nextOffset as number | null | undefined) ?? null;
    }
    return { ok: statuses.every((status) => status === 200) && contactsA >= 12 && total === contactsA
      && resources.status === 200 && Boolean(resourceId) && Boolean(deal),
      detail: { contacts: total, pages: statuses.length, resources: resources.status, deals: deals.status } };
  });
  await check("API: tenant B sees nothing and is refused tenant A's ids", async () => {
    const from = new Date(Date.now() + 86400000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const to = new Date(Date.now() + 3 * 86400000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const outcome = {
      contacts: await api("/v1/crm/contacts", tokenB),
      bookings: await api("/v1/booking/bookings", tokenB),
      slots: await api(`/v1/booking/slots?resourceId=${resourceId}&from=${from}&to=${to}`, tokenB),
      book: await api("/v1/booking/bookings", tokenB, { method: "POST", body: JSON.stringify({ resourceId, startsAt: from }) }),
      moveDeal: await api(`/v1/crm/deals/${deal?.id}/stage`, tokenB, { method: "POST",
        body: JSON.stringify({ pipelineId: deal?.pipelineId, stageId: deal?.stageId, expectedRevision: deal?.revision }) }),
    };
    const summary = Object.fromEntries(Object.entries(outcome).map(([key, value]) =>
      [key, { status: value.status, items: (value.body?.items as unknown[] | undefined)?.length, code: (value.body?.error as { code?: string } | undefined)?.code }]));
    return { ok: outcome.contacts.status === 200 && summary.contacts!.items === 0 && summary.bookings!.items === 0
      && outcome.slots.status === 403 && outcome.book.status === 403 && outcome.moveDeal.status === 403, detail: summary };
  });
  await check("API: missing, wrong-issuer and forged tokens get 401", async () => {
    const wrongIssuer = await tokenFor(tenantA, randomUUID(), "https://evil.example/");
    const forged = await signDevToken("x".repeat(48), { tenantId: tenantA, actorId: randomUUID() }, clock, 300, env.JWT_ISSUER);
    const statuses = {
      none: (await api("/v1/crm/contacts", null)).status,
      wrongIssuer: (await api("/v1/crm/contacts", wrongIssuer)).status,
      forged: (await api("/v1/crm/contacts", forged)).status,
    };
    return { ok: Object.values(statuses).every((status) => status === 401), detail: statuses };
  });
  await check("API: 120 concurrent two-tenant requests never cross tenants", async () => {
    const rows = await Promise.all(Array.from({ length: 120 }, async (_, index) => {
      const a = index % 2 === 0;
      const response = await api(index % 4 < 2 ? "/v1/crm/contacts?limit=100" : "/v1/booking/bookings?limit=100", a ? tokenA : tokenB);
      const items = (response.body?.items as unknown[] | undefined)?.length ?? -1;
      return { a, status: response.status, items };
    }));
    const bad = rows.filter((row) => row.status !== 200 || (row.a ? row.items <= 0 : row.items !== 0));
    return { ok: bad.length === 0, detail: { total: rows.length, bad: bad.slice(0, 5) } };
  });

  // --- Dashboard proxy (pilot gate) -----------------------------------------------------
  await check("dashboard proxy refuses anonymous, forged-cookie and bearer callers", async () => {
    const bypass: Record<string, string> = env.VERCEL_PROTECTION_BYPASS ? { "x-vercel-protection-bypass": env.VERCEL_PROTECTION_BYPASS } : {};
    // Without a bypass a protected preview answers 401 itself; the sign-in page proves the app answered.
    const reached = (await fetch(`${dashboardUrl}/sign-in`, { headers: bypass })).status;
    const call = async (headers: Record<string, string>) => (await fetch(`${dashboardUrl}/api/v1/crm/contacts`, { headers: { ...bypass, ...headers } })).status;
    const statuses = {
      anonymous: await call({}),
      forgedCookie: await call({ Cookie: "zs_dashboard_session=9999999999.abcdef.forged" }),
      bearerB: await call({ Authorization: `Bearer ${tokenB}` }),
      bearerA: await call({ Authorization: `Bearer ${tokenA}` }),
      session: (await fetch(`${dashboardUrl}/api/session`, { headers: bypass })).status,
    };
    return { ok: reached === 200 && Object.values(statuses).every((status) => status === 401), detail: { reached, ...statuses } };
  });

  // --- Data API (PostgREST) -------------------------------------------------------------
  const keys = await (await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
  })).json() as { name: string; type: string; api_key: string }[];
  const anonKey = keys.find((key) => key.name === "anon")?.api_key ?? "";
  const serviceKey = keys.find((key) => key.name === "service_role")?.api_key ?? "";
  const email = `zs-check-${randomUUID()}@example.com`;
  const password = randomUUID() + randomUUID();
  const created = await (await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { tenant_id: tenantA } }),
  })).json() as { id?: string };
  try {
    const session = await (await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    })).json() as { access_token?: string };
    const rest = async (path: string, bearer: string, init: RequestInit = {}) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { apikey: anonKey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" } });
      const body = await response.json().catch(() => null) as unknown;
      return { status: response.status, rows: Array.isArray(body) ? body.length : null, code: (body as { code?: string } | null)?.code ?? null };
    };
    // Only an explicit denial counts: 200 with an empty array, or 401/403/404 carrying a
    // PostgREST (PGRST...) or Postgres privilege (42501) code. An outage (5xx, HTML, no
    // code) fails the check instead of passing it.
    const denied = (reply: { status: number; rows: number | null; code: string | null }) =>
      (reply.status === 200 && reply.rows === 0)
      || ([401, 403, 404].includes(reply.status) && /^(PGRST\d+|42501)$/.test(reply.code ?? ""));
    await check("Data API: anon and a signed-in user claiming tenant A read no tenant rows", async () => {
      const detail: Record<string, unknown> = { userCreated: Boolean(created.id), signedIn: Boolean(session.access_token) };
      let ok = Boolean(session.access_token);
      for (const table of TENANT_TABLES) {
        const anon = await rest(`${table}?select=*&limit=5`, anonKey);
        const user = await rest(`${table}?select=*&limit=5`, session.access_token ?? anonKey);
        detail[table] = { anon, user };
        ok &&= denied(anon) && denied(user);
      }
      const rpc = await rest("rpc/record_action_and_event", session.access_token ?? anonKey, { method: "POST", body: JSON.stringify({
        p_tenant: tenantA, p_id: randomUUID(), p_actor: randomUUID(), p_type: "x", p_target: { tenantId: tenantA, id: randomUUID() },
        p_payload: {}, p_approval: { tenantId: tenantA, id: randomUUID() }, p_key: randomUUID(), p_result: {}, p_created_at: new Date().toISOString(),
        p_event_id: randomUUID(), p_event_type: "x", p_event_payload: {} }) });
      detail.rpcRecordAction = rpc;
      ok &&= rpc.status !== 200 && denied(rpc);
      return { ok, detail };
    });
  } finally {
    if (created.id) {
      const removed = await fetch(`${supabaseUrl}/auth/v1/admin/users/${created.id}`, { method: "DELETE", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      results.push({ name: "cleanup: the temporary Auth user is deleted", ok: removed.ok, detail: { status: removed.status, userId: created.id } });
    }
  }
} finally {
  await Promise.all([runtime.end(), migrator.end()]);
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ projectRef, apiUrl, dashboardUrl, checkedAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
