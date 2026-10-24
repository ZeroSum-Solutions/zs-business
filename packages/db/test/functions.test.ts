import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";
import type { Transaction } from "../src/scoped.js";
import { expectedOwner } from "./owners.js";
import { plantedLoginName, plantedLoginPattern } from "./planted-login.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

interface FunctionRow {
  fn: string;
  config: string[] | null;
  owner: string;
  definer: boolean;
  owner_unsafe: boolean;
  runtime_can_assume: boolean;
}
/**
 * Every function our migrations own, outside system schemas and extensions. Runtime roles
 * resolve through pg_roles: pg_has_role throws for a role name that does not exist. Logins
 * that other test files plant to prove a guard refuses them are not runtime logins.
 */
async function ourFunctions(tx: Transaction, runtimeRoles = ["authenticated", "service_role"]): Promise<FunctionRow[]> {
  return (await tx.query<FunctionRow>(`
    SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config, r.rolname AS owner, p.prosecdef AS definer,
      (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
        OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) AS owner_unsafe,
      EXISTS(SELECT 1 FROM pg_roles l WHERE l.rolcanlogin AND NOT l.rolsuper AND l.rolname !~ $2 AND pg_has_role(l.oid, r.oid, 'MEMBER')
        AND EXISTS(SELECT 1 FROM pg_roles s WHERE s.rolname = ANY($1::text[]) AND pg_has_role(l.oid, s.oid, 'MEMBER'))) AS runtime_can_assume
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','zs_local_auth') AND n.nspname !~ '^pg_(toast|temp)'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY 1`, [runtimeRoles, plantedLoginPattern])).rows;
}
/** Each function keeps the path it was created with, plus pg_temp last. */
const expectedPath: Record<string, string> = {
  // M6 revision 2 (20261022510000_agent_runs_guard.sql): runs only close, once.
  "agent_model_calls_guard()": "pg_catalog, pg_temp",
  "agent_runs_guard()": "pg_catalog, pg_temp",
  "approvals_transition()": "pg_catalog, pg_temp",
  // Booking customer link (20261023200000_booking_contacts.sql): the revision and owner-made guard, and the
  // trigger that clears a deleted contact's links (BC-7).
  "booking_contacts_contact_deleted()": "pg_catalog, pg_temp",
  "booking_contacts_guard()": "pg_catalog, pg_temp",
  "booking_overrides_valid(jsonb)": "pg_catalog, public, pg_temp",
  "booking_pages_disclosure_versioned()": "pg_catalog, pg_temp",
  "booking_page_disclosures_append_only()": "pg_catalog, pg_temp",
  "booking_resources_time_zone_known()": "pg_catalog, pg_temp",
  "booking_weekly_valid(jsonb)": "pg_catalog, public, pg_temp",
  "booking_windows_valid(jsonb)": "pg_catalog, pg_temp",
  // Business profile (20261023100000_business_profiles.sql): the row that comes with a tenant, the definer
  // that keeps tenants.name in step with the display name (BP-9), and the zone check.
  "business_profiles_create()": "pg_catalog, pg_temp",
  "business_profiles_sync_name()": "pg_catalog, pg_temp",
  "business_profiles_tenant_name()": "pg_catalog, pg_temp",
  "business_profiles_time_zone_known()": "pg_catalog, pg_temp",
  // M5 (20261020630000_google_calendar.sql): the runtime status guard on calendar connections.
  "calendar_connections_runtime_guard()": "pg_catalog, pg_temp",
  // M3c (20261020200000_inbox_home.sql): the won-date and reply-guard triggers.
  "crm_deals_won_at()": "pg_catalog, pg_temp",
  "inbox_replies_guard()": "pg_catalog, pg_temp",
  "site_history_append_only()": "pg_catalog, pg_temp",
  "voice_textback_append_only()": "pg_catalog, pg_temp",
  "rate_limit_take(timestamp with time zone,jsonb)": "pg_catalog, pg_temp",
  "record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamp with time zone,uuid,text,jsonb)":
    "pg_catalog, pg_temp",
};
const unpinned = (rows: FunctionRow[]) => rows.filter((row) => {
  const path = expectedPath[row.fn];
  return !path || !(row.config ?? []).includes(`search_path=${path}`);
}).map((row) => row.fn);

it("pins each function's search_path to its original path with pg_temp last", async () => {
  const rows = await fixture.service(ourFunctions);
  expect(rows.map((row) => row.fn)).toEqual(Object.keys(expectedPath).sort());
  expect(unpinned(rows)).toEqual([]);
});

it("resolves runtime roles that do not exist as no membership", async () => {
  const rows = await fixture.service((tx) => ourFunctions(tx, ["authenticated", "service_role", "zs_no_such_role"]));
  expect(rows.length).toBe(Object.keys(expectedPath).length);
});

it("the search_path check catches a function without its pinned path", async () => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE FUNCTION public.unpinned_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'");
    // A rewritten path is caught too, not only a missing one.
    await client.query("ALTER FUNCTION public.booking_windows_valid(jsonb) SET search_path = pg_catalog, public, pg_temp");
    expect(unpinned(await ourFunctions(client))).toEqual(["booking_windows_valid(jsonb)", "unpinned_probe()"]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

it("owns every function by a NOLOGIN role no runtime login can assume", async () => {
  const rows = await fixture.service(ourFunctions);
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const row of rows) {
    expect(row).toMatchObject({
      owner: expectedOwner(row),
      owner_unsafe: false,
      runtime_can_assume: false,
    });
  }
});

it("skips only planted logins: any other login that can reach an owner is caught", async () => {
  // Rolled back, so concurrent test files never see these logins.
  const client = await database.pool.connect();
  const assumable = async () => (await ourFunctions(client)).filter((row) => row.runtime_can_assume).map((row) => row.fn);
  try {
    await client.query("BEGIN");
    const planted = plantedLoginName();
    await client.query(`CREATE ROLE ${planted} LOGIN; GRANT authenticated, zs_dispatcher TO ${planted}`);
    expect(await assumable()).toEqual([]);
    await client.query("CREATE ROLE zs_probe_login LOGIN; GRANT authenticated, zs_dispatcher TO zs_probe_login");
    // The two functions that run as zs_dispatcher.
    expect(await assumable()).toEqual([
      expect.stringMatching(/^business_profiles_sync_name\(/), expect.stringMatching(/^record_action_and_event\(/),
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

const insertResource = (tenantId: string, timeZone: string) => fixture.service((tx) => tx.query(
  `INSERT INTO booking_resources (tenant_id,id,time_zone,slot_length_minutes,slot_step_minutes,
     buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
   VALUES ($1,$2,$3,30,30,0,0,0,60)`, [tenantId, randomUUID(), timeZone]));

it("rejects time-zone names Postgres does not know, on insert and update", async () => {
  await expect(insertResource(fixture.b.tenantId, "Foo/Bar")).rejects.toMatchObject({
    code: "23514", constraint: "booking_resources_time_zone_known",
  });
  await insertResource(fixture.a.tenantId, "America/New_York");
  await expect(fixture.service((tx) => tx.query(
    "UPDATE booking_resources SET time_zone='Foo/Bar' WHERE tenant_id=$1", [fixture.a.tenantId],
  ))).rejects.toMatchObject({ code: "23514", constraint: "booking_resources_time_zone_known" });
  expect((await fixture.service((tx) => tx.query(
    "SELECT time_zone FROM booking_resources WHERE tenant_id=$1", [fixture.a.tenantId],
  ))).rows).toEqual([{ time_zone: "America/New_York" }]);
});

it("accepts a lowercase IANA name on insert and update and keeps its spelling (B-4)", async () => {
  await insertResource(fixture.b.tenantId, "america/new_york");
  await fixture.service((tx) => tx.query(
    "UPDATE booking_resources SET time_zone='europe/london' WHERE tenant_id=$1", [fixture.b.tenantId],
  ));
  expect((await fixture.service((tx) => tx.query(
    "SELECT time_zone FROM booking_resources WHERE tenant_id=$1", [fixture.b.tenantId],
  ))).rows).toEqual([{ time_zone: "europe/london" }]);
});
