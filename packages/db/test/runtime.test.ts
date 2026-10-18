import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, createTwoTenantFixture, testAdminUrl, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";
import { createScopedDatabase } from "../src/scoped.js";

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

it("RESET ROLE cannot restore privileged access and service_role cannot be assumed", async () => {
  await fixture.a.run(async (tx) => {
    await tx.query("reset role");
    expect((await tx.query("select tenant_id from tenants")).rows).toEqual([{ tenant_id: fixture.a.tenantId }]);
    expect((await tx.query("select session_user")).rows[0]).toEqual({ session_user: "zs_runtime" });
  });
  await expect(fixture.a.run((tx) => tx.query("set role service_role"))).rejects.toMatchObject({ code: "42501" });
});

it("denies direct runtime inserts even for the current tenant", async () => {
  await expect(fixture.a.run((tx) => tx.query(
    "insert into actions(tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at) values($1,$2,$3,'forged','{}','{}',$4,'{}','2026-10-17')",
    [fixture.a.tenantId, randomUUID(), randomUUID(), randomUUID()],
  ))).rejects.toMatchObject({ code: "42501" });
  await expect(fixture.a.run((tx) => tx.query(
    "insert into outbox(tenant_id,id,action_id,event_type,payload,created_at) values($1,$2,$3,'forged','{}','2026-10-17')",
    [fixture.a.tenantId, randomUUID(), randomUUID()],
  ))).rejects.toMatchObject({ code: "42501" });
  await expect(fixture.a.run((tx) => tx.query("update tenants set name='forged'"))).rejects.toMatchObject({ code: "42501" });
});

it("rejects a privileged pool used as runtime and forbids assuming the function owner", async () => {
  await expect(createScopedDatabase(database.pool).tenant(fixture.a.tenantId, (tx) => tx.query("select 1"))).rejects.toThrow("unprivileged LOGIN");
  await expect(fixture.a.run((tx) => tx.query("set role zs_dispatcher"))).rejects.toMatchObject({ code: "42501" });
});

it("runs the narrow write function as a non-owner without BYPASSRLS and rejects a forged tenant", async () => {
  expect(await fixture.service(async (tx) => (await tx.query(`SELECT r.rolbypassrls,r.rolsuper,p.prosecdef,p.proconfig,
    r.oid<>c.relowner AS not_table_owner,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE grantee=0) AS public_execute
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    JOIN pg_class c ON c.oid='actions'::regclass WHERE p.proname='record_action_and_event'`)).rows[0])).toMatchObject({ rolbypassrls: false, rolsuper: false, prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"], not_table_owner: true, public_execute: false });
  await expect(fixture.a.run((tx) => tx.query(
    "select public.record_action_and_event($1,$2,$3,'forged',$4,'{}',$5,$6,'{}','2026-10-17',$7,'forged','{}')",
    [fixture.b.tenantId, randomUUID(), randomUUID(), JSON.stringify({ tenantId: fixture.b.tenantId }), JSON.stringify({ tenantId: fixture.b.tenantId, id: randomUUID() }), randomUUID(), randomUUID()],
  ))).rejects.toMatchObject({ code: "42501" });
});

it.each([
  "postgres://postgres:password@localhost:55433/postgres",
  "postgresql://postgres@[::1]:55434/postgres",
  "postgres://postgres@127.0.0.2:60000/postgres",
])("accepts safe loopback URL without connecting: %s", (value) => {
  expect(testAdminUrl(value).href).toBe(new URL(value).href);
});
