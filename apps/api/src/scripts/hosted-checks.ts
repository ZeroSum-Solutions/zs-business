// Entry point, owner-run: negative checks against one hosted project and its deploys.
// Reads nothing but checks. Its only writes are temporary and removed at the end, each removal
// checked: two Supabase Auth users (synthetic example.com addresses, no email sent), one
// claiming tenant A and one claiming tenant B, and a staff tenant_members row binding the
// tenant-A user to tenant A, so that it signs in like a real member.
//   ZS_TARGET_REF, RUNTIME_DATABASE_URL, MIGRATOR_DATABASE_URL   as for hosted-migrate/seed
//   SERVICE_DATABASE_URL     postgres.<ref>, to add and remove the temporary member
//   SUPABASE_ACCESS_TOKEN    Management API, to read the project's API keys
//   API_URL                  the deployed API, for example https://api.zerosumsolutions.com
//   DASHBOARD_URL            the deployed dashboard
//   JWT_SECRET, JWT_ISSUER   the API's token settings, to mint the refused test tokens
//   ZS_TENANT_ID             the seeded tenant (tenant A); tenant B is random and empty
//   VERCEL_PROTECTION_BYPASS optional: passes Vercel Authentication on a protected preview
// Flags: --expect-transport=transaction|session names the runtime URL's Supavisor mode;
// default transaction (port 6543), as the API deploys. Any other port fails the run.
// --abandon-rounds=N reruns the abandoned-transaction probe with N rounds (default 10)
// after an inconclusive result.
// Prints one JSON report and exits 1 if any check fails.
import { randomUUID } from "node:crypto";
import process from "node:process";
import { assertRuntimeLogin, createScopedDatabase } from "@zs/db";
import { readMigrationTables, runDataApiProbes, tablesToProbe, type DataApiTable } from "../data-api-probe.js";
import { signDevToken } from "../dev-token.js";
import { temporaryMember } from "../hosted-check-member.js";
import {
  abandonedTransactionProbe, abandonGate, concurrentTenantProbe, hostedCheckArgs, poolerTransport, sessionContaminationProbe, transportGate,
} from "../hosted-probes.js";
import { assertHostedDatabaseUrl, hostedPool, redactSecrets } from "../hosted.js";
import { assertServiceKey, createSupabaseAuthAdmin, signInWithPassword } from "../supabase-auth-admin.js";

const env = process.env;
const { transport: expected, abandonRounds } = hostedCheckArgs(process.argv.slice(2));
const projectRef = env.ZS_TARGET_REF ?? "";
const runtimeTarget = assertHostedDatabaseUrl(env.RUNTIME_DATABASE_URL ?? "", { projectRef, role: "zs_runtime" });
const migratorTarget = assertHostedDatabaseUrl(env.MIGRATOR_DATABASE_URL ?? "", { projectRef, role: "zs_migrator" });
const serviceTarget = assertHostedDatabaseUrl(env.SERVICE_DATABASE_URL ?? "", { projectRef, role: "postgres" });
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
    results.push({ name, ok: false, detail: `threw: ${redactSecrets(error instanceof Error ? error.message : String(error))}` });
  }
}

const runtime = hostedPool(runtimeTarget, 10);
// The abandoned-transaction probe's observer: plain queries on the runtime URL, never the
// scoped path, whose cleanup would erase the state it looks for.
const observer = hostedPool(runtimeTarget, 2);
// Pooler mode of the runtime URL: 6543 is Supavisor transaction mode, as the API uses.
const transport = { ...poolerTransport(runtimeTarget.port), expected };
// Every scoped transaction here reports a failed session reset; any one fails the run.
const resetFailures: string[] = [];
const scopedOptions = { onResetFailure: (error: unknown) => { resetFailures.push(redactSecrets(String(error))); } };
const migrator = hostedPool(migratorTarget, 1);
const service = hostedPool(serviceTarget, 1);
// Minted tokens are always refused now: the API also requires a live Supabase session.
const mintedToken = (tenantId: string, actorId: string, issuer = env.JWT_ISSUER) =>
  signDevToken(env.JWT_SECRET ?? "", { tenantId, actorId, sessionId: randomUUID() }, clock, 300, issuer);
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
// Every table in the schemas the Data API could expose, for its denial probe.
const CATALOG_TABLES = (await runtime.query<DataApiTable>(
  `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','zs_internal') AND c.relkind IN ('r','p') ORDER BY 1, 2`)).rows;

// --- Temporary users -----------------------------------------------------------------
const keysReply = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`, {
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, redirect: "error",
});
const keys = await keysReply.json().catch(() => null) as { name?: string; api_key?: string }[] | null;
if (!keysReply.ok || !Array.isArray(keys)) throw new Error(`Management API refused to list the project's API keys: HTTP ${keysReply.status}`);
const anonKey = keys.find((key) => key.name === "anon")?.api_key ?? "";
if (anonKey === "") throw new Error("the project has no anon key");
const admin = createSupabaseAuthAdmin({ projectRef, serviceKey: assertServiceKey(keys.find((key) => key.name === "service_role")?.api_key, projectRef) });
const password = randomUUID() + randomUUID();
const signIn = (email: string) => signInWithPassword({ projectRef, anonKey }, email, password);
const emailA = `zs-check-a-${randomUUID()}@example.com`;
const emailB = `zs-check-b-${randomUUID()}@example.com`;
const created: string[] = [];
// Its id is fixed before the insert, so cleanup also covers an insert whose COMMIT reply was lost.
const memberA = temporaryMember(service, tenantA, randomUUID);
let tokenA = "";
let tokenB = "";
let userA = "";
try {
  userA = await admin.createUser({ email: emailA, password, appMetadata: { tenant_id: tenantA } });
  created.push(userA);
  created.push(await admin.createUser({ email: emailB, password, appMetadata: { tenant_id: tenantB } }));
  // Staff: the least role that reads. Inserted as service_role, like provisioning, and removed below.
  await memberA.add({ email: emailA, userId: userA });
  tokenA = await signIn(emailA);
  tokenB = await signIn(emailB);
} catch (error) {
  results.push({ name: "temporary users and member are set up", ok: false, detail: redactSecrets(error instanceof Error ? error.message : String(error)) });
}

try {
  // --- Database roles -------------------------------------------------------------------
  await check("runtime URL uses the transport the deployment uses", async () => transportGate(runtimeTarget.port, expected));
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
    // A load probe, not an admission test: room in the queue for all 200, so that on a pool
    // of 10 none is refused "busy" by the default bound of 50 waiting.
    const probe = await concurrentTenantProbe(createScopedDatabase(runtime, { ...scopedOptions, maxWaiting: 256 }),
      [{ tenantId: tenantA, contacts: contactsA }, { tenantId: tenantB, contacts: 0 }]);
    return { ok: probe.ok, detail: { transport, ...probe.detail } };
  });
  await check("pooled runtime sessions carry no session state into later transactions", async () => {
    // Tenant B: the probe reads only session state, never rows. Committed and throwing
    // transactions dirty their backend; it fails unless readers reuse those backends.
    const probe = await sessionContaminationProbe(createScopedDatabase(runtime, scopedOptions), tenantB);
    return { ok: probe.ok, detail: { transport, ...probe.detail } };
  });
  await check("abandoned in-flight transactions leave no session state on reused backends", async () => {
    // Tenant B, session state only. Each abandoned transaction is reported through
    // onResetFailure by design, so it counts here instead of failing the next check.
    let reported = 0;
    const probe = await abandonedTransactionProbe(createScopedDatabase(runtime, { onResetFailure: () => { reported += 1; } }), observer, tenantB,
      abandonRounds === undefined ? {} : { rounds: abandonRounds });
    const gate = abandonGate(probe, expected);
    const unreported = reported === probe.detail.abandoned ? [] : [`${probe.detail.abandoned} abandoned, ${reported} reported through onResetFailure`];
    return { ok: gate.ok && unreported.length === 0, detail: { transport, verdict: gate.verdict, unreported, reported, ...probe.detail } };
  });
  await check("no scoped transaction failed its session reset", async () =>
    ({ ok: resetFailures.length === 0, detail: { transport, failures: resetFailures.length, first: resetFailures.slice(0, 3) } }));

  // --- HTTP API -------------------------------------------------------------------------
  const resources = await api("/v1/booking/resources", tokenA);
  const resourceId = (resources.body?.items as { id: string }[] | undefined)?.[0]?.id ?? "";
  const deals = await api("/v1/crm/deals?limit=1", tokenA);
  const deal = (deals.body?.items as { id: string; pipelineId: string; stageId: string; revision: number }[] | undefined)?.[0];
  const me = await api("/v1/me", tokenA);
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
      && resources.status === 200 && Boolean(resourceId) && Boolean(deal)
      && me.status === 200 && me.body?.tenantId === tenantA && me.body?.userId === userA && me.body?.role === "staff",
      detail: { me: me.status, role: me.body?.role ?? null, contacts: total, pages: statuses.length, resources: resources.status, deals: deals.status } };
  });
  // Tenant B's user is signed in with a valid session but is a member of nothing: every call,
  // including those naming tenant A's ids, is refused before any read.
  await check("API: a signed-in user who is no member of the claimed tenant is refused, also for tenant A's ids", async () => {
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
    return { ok: Object.values(outcome).every((value) => value.status === 403), detail: summary };
  });
  await check("API: missing, wrong-issuer, forged, sessionless and signed-out tokens get 401", async () => {
    const wrongIssuer = await mintedToken(tenantA, userA, "https://evil.example/");
    const forged = await signDevToken("x".repeat(48), { tenantId: tenantA, actorId: userA, sessionId: randomUUID() }, clock, 300, env.JWT_ISSUER);
    // Signed with the real secret for tenant A's member, but naming no live session.
    const noSession = await mintedToken(tenantA, userA);
    // A real session, ended the way the dashboard's sign-out ends it.
    const ended = await signIn(emailA);
    const logout = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST", headers: { apikey: anonKey, Authorization: `Bearer ${ended}` },
    });
    const statuses = {
      none: (await api("/v1/crm/contacts", null)).status,
      wrongIssuer: (await api("/v1/crm/contacts", wrongIssuer)).status,
      forged: (await api("/v1/crm/contacts", forged)).status,
      noSession: (await api("/v1/crm/contacts", noSession)).status,
      signedOut: (await api("/v1/crm/contacts", ended)).status,
    };
    return { ok: logout.status === 204 && Object.values(statuses).every((status) => status === 401), detail: { logout: logout.status, ...statuses } };
  });
  await check("API: 120 concurrent requests from tenant A's member and a non-member never cross", async () => {
    const rows = await Promise.all(Array.from({ length: 120 }, async (_, index) => {
      const a = index % 2 === 0;
      const response = await api(index % 4 < 2 ? "/v1/crm/contacts?limit=100" : "/v1/booking/bookings?limit=100", a ? tokenA : tokenB);
      const items = (response.body?.items as unknown[] | undefined)?.length ?? -1;
      return { a, status: response.status, items };
    }));
    const bad = rows.filter((row) => (row.a ? row.status !== 200 || row.items <= 0 : row.status !== 403));
    return { ok: bad.length === 0, detail: { total: rows.length, bad: bad.slice(0, 5) } };
  });

  // --- Dashboard proxy (Supabase cookie session only; a bearer is ignored) ---------------
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
  // As anon and as tenant A's signed-in member: a positive control shows the Data API accepts
  // each token, the action RPC refuses both, and every table from the migrations and the
  // catalog refuses SELECT, INSERT, UPDATE and DELETE (src/data-api-probe.ts).
  await check("Data API: accepts both tokens, and refuses anon and tenant A's member the action RPC and every table, every operation", async () => {
    const { tables, missingFromCatalog } = tablesToProbe(await readMigrationTables(new URL("../../../../supabase/migrations/", import.meta.url)), CATALOG_TABLES);
    const probe = await runDataApiProbes({ fetch, supabaseUrl, anonKey, userToken: tokenA, tenantA, tenantB, tables, missingFromCatalog, generateId: randomUUID });
    return { ok: Boolean(tokenA) && probe.ok, detail: { signedIn: Boolean(tokenA), ...probe.detail } };
  });
} finally {
  const removal = await memberA.remove();
  if (removal) results.push({ name: "cleanup: the temporary member is removed", ok: removal.ok, detail: removal.detail });
  for (const userId of created) {
    const removed = await admin.deleteUser(userId).then(() => null, (error: Error) => redactSecrets(error.message));
    results.push({ name: "cleanup: a temporary Auth user is deleted", ok: removed === null, detail: { userId, error: removed } });
  }
  await Promise.all([runtime.end(), observer.end(), migrator.end(), service.end()]);
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ projectRef, apiUrl, dashboardUrl, checkedAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
