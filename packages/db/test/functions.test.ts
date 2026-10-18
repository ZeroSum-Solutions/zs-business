import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";
import type { Transaction } from "../src/scoped.js";

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
/** Every function our migrations own, outside system schemas and extensions. */
async function ourFunctions(tx: Transaction): Promise<FunctionRow[]> {
  return (await tx.query<FunctionRow>(`
    SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config, r.rolname AS owner, p.prosecdef AS definer,
      (r.rolcanlogin OR r.rolsuper OR r.rolbypassrls) AS owner_unsafe,
      EXISTS(SELECT 1 FROM pg_roles l WHERE l.rolcanlogin AND NOT l.rolsuper AND pg_has_role(l.oid, r.oid, 'MEMBER')
        AND (pg_has_role(l.oid, 'authenticated', 'MEMBER') OR pg_has_role(l.oid, 'service_role', 'MEMBER'))) AS runtime_can_assume
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY 1`)).rows;
}
const pinned = /^search_path=pg_catalog(, public)?, pg_temp$/;
const unpinned = (rows: FunctionRow[]) =>
  rows.filter((row) => !(row.config ?? []).some((setting) => pinned.test(setting))).map((row) => row.fn);

it("pins search_path, with pg_temp last, on every function in our schemas", async () => {
  const rows = await fixture.service(ourFunctions);
  expect(rows.map((row) => row.fn)).toEqual(expect.arrayContaining([
    "booking_overrides_valid(jsonb)", "booking_resources_time_zone_known()", "booking_weekly_valid(jsonb)",
    "booking_windows_valid(jsonb)", expect.stringMatching(/^record_action_and_event\(/),
  ]));
  expect(unpinned(rows)).toEqual([]);
});

it("the search_path check catches a function without a pinned path", async () => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE FUNCTION public.unpinned_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'");
    expect(unpinned(await ourFunctions(client))).toEqual(["unpinned_probe()"]);
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
      owner: row.definer ? "zs_dispatcher" : "zs_function_owner",
      owner_unsafe: false,
      runtime_can_assume: false,
    });
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
