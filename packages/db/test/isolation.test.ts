import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
afterAll(async () => {
  await harness?.close();
});

describe("tenant isolation under actual runtime and privileged roles", () => {
  it("forces RLS on every tenant table and keeps the runtime unprivileged", async () => {
    const tables = await fixture.service(
      async (tx) =>
        (
          await tx.query<{
            relname: string;
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }>(
            "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname <> 'schema_migrations' order by relname",
          )
        ).rows,
    );
    expect(tables.map((t) => t.relname)).toEqual([
      "actions",
      "outbox",
      "tenants",
    ]);
    expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity)).toBe(
      true,
    );
    const role = await fixture.a.run(
      async (tx) =>
        (
          await tx.query(
            "select current_user, rolbypassrls, rolsuper from pg_roles where rolname = current_user",
          )
        ).rows[0],
    );
    expect(role).toMatchObject({
      current_user: "authenticated",
      rolbypassrls: false,
      rolsuper: false,
    });
    const serviceRole = await fixture.service(
      async (tx) =>
        (
          await tx.query(
            "select current_user, rolbypassrls, rolsuper from pg_roles where rolname=current_user",
          )
        ).rows[0],
    );
    expect(serviceRole).toMatchObject({
      current_user: "service_role",
      rolbypassrls: true,
      rolsuper: false,
    });
  });
  it.each(["tenants", "actions", "outbox"] as const)(
    "denies B reading or modifying A in %s while service can read A",
    async (table) => {
      const seed = await fixture.service(async (tx) => {
        const actionId = randomUUID();
        await tx.query(
          `insert into actions (tenant_id,id,actor_id,action_type,target,payload,approval_reference,idempotency_key,result,created_at) values ($1,$2,$3,'fixture','{}','{}',null,$4,'{}','2026-10-17T00:00:00Z')`,
          [fixture.a.tenantId, actionId, randomUUID(), randomUUID()],
        );
        await tx.query(
          `insert into outbox (tenant_id,id,action_id,event_type,payload,created_at) values ($1,$2,$3,'fixture','{}','2026-10-17T00:00:00Z')`,
          [fixture.a.tenantId, randomUUID(), actionId],
        );
        return actionId;
      });
      expect(seed).toBeTruthy();
      expect(
        await fixture.b.run(
          async (tx) =>
            (
              await tx.query(`select * from ${table} where tenant_id=$1`, [
                fixture.a.tenantId,
              ])
            ).rowCount,
        ),
      ).toBe(0);
      expect(
        await fixture.service(
          async (tx) =>
            (
              await tx.query(`select * from ${table} where tenant_id=$1`, [
                fixture.a.tenantId,
              ])
            ).rowCount,
        ),
      ).toBeGreaterThan(0);
      // Missing table grants must not masquerade as an RLS denial.
      if (table === "tenants") {
        expect(
          await fixture.b.run(
            async (tx) =>
              (
                await tx.query(
                  "update tenants set name=$1 where tenant_id=$2",
                  ["intrusion", fixture.a.tenantId],
                )
              ).rowCount,
          ),
        ).toBe(0);
        await expect(
          fixture.b.run((tx) =>
            tx.query("update tenants set tenant_id=$1 where tenant_id=$2", [
              fixture.a.tenantId,
              fixture.b.tenantId,
            ]),
          ),
        ).rejects.toThrow();
      } else {
        await expect(
          fixture.b.run((tx) =>
            table === "actions"
              ? tx.query(
                  `insert into actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at) values ($1,$2,$3,'intrusion','{}','{}',$4,'{}','2026-10-17T00:00:00Z')`,
                  [
                    fixture.a.tenantId,
                    randomUUID(),
                    randomUUID(),
                    randomUUID(),
                  ],
                )
              : tx.query(
                  `insert into outbox (tenant_id,id,action_id,event_type,payload,created_at) values ($1,$2,$3,'intrusion','{}','2026-10-17T00:00:00Z')`,
                  [fixture.a.tenantId, randomUUID(), seed],
                ),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
    },
  );
  it("allows own-tenant writes through the same runtime grants used in denial tests", async () => {
    await fixture.b.run(async (tx) => {
      const id = randomUUID();
      expect(
        (
          await tx.query("update tenants set name=$1 where tenant_id=$2", [
            "Tenant B updated",
            fixture.b.tenantId,
          ])
        ).rowCount,
      ).toBe(1);
      await tx.query(
        `insert into actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at) values ($1,$2,$3,'allowed','{}','{}',$4,'{}','2026-10-17T00:00:00Z')`,
        [fixture.b.tenantId, id, randomUUID(), randomUUID()],
      );
      await tx.query(
        `insert into outbox (tenant_id,id,action_id,event_type,payload,created_at) values ($1,$2,$3,'allowed','{}','2026-10-17T00:00:00Z')`,
        [fixture.b.tenantId, randomUUID(), id],
      );
    });
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
    const connection = await harness.pool.connect();
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
