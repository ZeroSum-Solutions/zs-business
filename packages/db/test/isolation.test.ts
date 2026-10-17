import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { catalogTenantTables, seedTenantTables } from "./tenant-tables.js";
import { migrate } from "../src/index.js";
import {
  createTestDatabase,
  createTwoTenantFixture,
  withTestDatabase,
  type TestDatabase,
  type TwoTenantFixture,
  testAdminUrl,
} from "../src/testing.js";

let harness: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  harness = await createTestDatabase();
  fixture = await createTwoTenantFixture(harness);
  // Proves discovery and fixture generation also cover an unfamiliar future table.
  await harness.pool.query(`CREATE TABLE public.test_catalog_discovery(tenant_id uuid NOT NULL REFERENCES tenants(tenant_id), id uuid DEFAULT gen_random_uuid(), name text NOT NULL);
    ALTER TABLE test_catalog_discovery ENABLE ROW LEVEL SECURITY;
    ALTER TABLE test_catalog_discovery FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_scope ON test_catalog_discovery TO authenticated USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
    GRANT SELECT,INSERT,UPDATE,DELETE ON test_catalog_discovery TO authenticated,service_role;`);
});
afterAll(async () => {
  await harness?.close();
});

describe("tenant isolation under actual runtime and privileged roles", () => {
  it("checks every public tenant table from the catalog, including future migrations", async () => {
    const tables = await fixture.service(catalogTenantTables);
    expect(tables.length).toBeGreaterThan(0);
    await fixture.service(async (tx) => {
      await seedTenantTables(tx, fixture.a.tenantId, tables);
      await seedTenantTables(tx, fixture.b.tenantId, tables);
    });
    for (const table of tables) {
      expect(table.rls, table.name).toBe(true);
      expect(table.forced, table.name).toBe(true);
      expect(table.policy, table.name).toBe(true);
      expect(table.public_grants, table.name).toBe(false);
      const name = 'public."' + table.name.replaceAll('"', '""') + '"';
      expect(await fixture.a.run(async (tx) => (await tx.query(`select * from ${name}`)).rowCount), table.name).toBeGreaterThan(0);
      expect(await fixture.b.run(async (tx) => (await tx.query(`select * from ${name} where tenant_id=$1`, [fixture.a.tenantId])).rowCount), table.name).toBe(0);
      expect(await fixture.service(async (tx) => (await tx.query(`select * from ${name} where tenant_id=$1`, [fixture.a.tenantId])).rowCount), table.name).toBeGreaterThan(0);
      // Read denial must be RLS, while write denial may be RLS or deliberately absent grants.
      for (const query of [
        `update ${name} set tenant_id=tenant_id where tenant_id=$1`,
        `delete from ${name} where tenant_id=$1`,
      ]) {
        try {
          const count = await fixture.b.run(async (tx) => (await tx.query(query, [fixture.a.tenantId])).rowCount);
          expect(count, table.name).toBe(0);
        } catch (error) { expect(error, table.name).toMatchObject({ code: "42501" }); }
      }
      try {
        const count = await fixture.b.run(async (tx) => (await tx.query(`update ${name} set tenant_id=$1 where tenant_id=$2`, [fixture.a.tenantId, fixture.b.tenantId])).rowCount);
        expect(count, table.name).toBe(0);
      } catch (error) { expect(error, table.name).toMatchObject({ code: "42501" }); }
    }
  });
  it("distinguishes the dedicated runtime and service logins", async () => {
    expect(await fixture.a.run(async (tx) => (await tx.query("select current_user, session_user, rolbypassrls, rolsuper from pg_roles where rolname=current_user")).rows[0])).toMatchObject({ current_user: "authenticated", session_user: "zs_runtime", rolbypassrls: false, rolsuper: false });
    expect(await fixture.service(async (tx) => (await tx.query("select current_user, session_user, rolbypassrls, rolsuper from pg_roles where rolname=current_user")).rows[0])).toMatchObject({ current_user: "service_role", session_user: "zs_service", rolbypassrls: true, rolsuper: false });
  });
  it("does not grant runtime mutation of action history or outbox events", async () => {
    for (const table of ["actions", "outbox"]) {
      await expect(
        fixture.b.run((tx) => tx.query(`delete from ${table}`)),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        fixture.b.run((tx) => tx.query(`update ${table} set payload='{}'`)),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("reapplies migrations without duplicating schema or roles", async () => {
    await migrate(harness.pool);
    expect(
      await fixture.a.run(
        async (tx) => (await tx.query("select * from tenants")).rowCount,
      ),
    ).toBe(1);
  });
  it.each([
    "postgres://postgres@127.0.0.1:5432/postgres",
    "postgres://postgres@127.0.0.1:54322/postgres",
    "postgres://postgres@remote.example:55432/postgres",
    "postgres://postgres@127.0.0.1:55432/production",
    "postgres://postgres@127.0.0.1:55432/postgres?host=remote.example",
  ])("rejects unsafe test cluster URLs before any connection: %s", (url) => {
    expect(() => testAdminUrl(url)).toThrow("dedicated");
  });
  it("strips inherited default grants during administrative migrations", async () => {
    await withTestDatabase(async (db) => {
      await db.pool.query(
        `drop schema public cascade; create schema public; drop schema zs_internal cascade; alter default privileges in schema public grant all on tables to authenticated;`,
      );
      await migrate(db.pool);
      expect(await db.db.tenant(fixture.a.tenantId, async (tx) => (await tx.query(
        "select has_table_privilege(current_user,'actions','TRUNCATE') as truncate, has_table_privilege(current_user,'actions','UPDATE') as update, has_table_privilege(current_user,'actions','INSERT') as insert",
      )).rows[0])).toEqual({ truncate: false, update: false, insert: false });
    });
  });
  it("does not leak tenant context through reused connections", async () => {
    await fixture.a.run(async (tx) =>
      expect((await tx.query("select tenant_id from tenants")).rows).toEqual([
        { tenant_id: fixture.a.tenantId },
      ]),
    );
    await fixture.b.run(async (tx) =>
      expect((await tx.query("select tenant_id from tenants")).rows).toEqual([
        { tenant_id: fixture.b.tenantId },
      ]),
    );
    const connection = await harness.runtimePool.connect();
    try {
      await connection.query("begin");
      await connection.query("set local role authenticated");
      expect((await connection.query("select * from tenants")).rowCount).toBe(
        0,
      );
    } finally {
      await connection.query("rollback");
      connection.release();
    }
  });
  it("cleans up a database even if the callback fails", async () => {
    let failedName = "";
    await expect(
      withTestDatabase(async (db) => {
        failedName = db.name;
        throw new Error("injected suite failure");
      }),
    ).rejects.toThrow("injected suite failure");
    expect(
      await fixture.service(
        async (tx) =>
          (
            await tx.query("select datname from pg_database where datname=$1", [
              failedName,
            ])
          ).rowCount,
      ),
    ).toBe(0);
  });
  it("gives simultaneous runs separate databases", async () => {
    await Promise.all([
      withTestDatabase(async (db) => expect(db.name).not.toBe(harness.name)),
      withTestDatabase(async (db) => expect(db.name).not.toBe(harness.name)),
    ]);
  });
});
