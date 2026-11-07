import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "../src/scoped.js";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// industry-templates.md IT-3 and the IT-4 grants, at the database, under the runtime role.

let database: TestDatabase;
let fixture: TwoTenantFixture;
interface Seeded { actionId: string; pipelineId: string; resourceId: string; pageId: string }
const seeded = new Map<string, Seeded>();

async function seedParents(tx: Transaction, tenantId: string): Promise<Seeded> {
  const ids = { actionId: randomUUID(), pipelineId: randomUUID(), resourceId: randomUUID(), pageId: randomUUID() };
  await tx.query(
    `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
     VALUES ($1,$2,$3,'tenant.template.apply','{}','{}',$4,'{}',now())`,
    [tenantId, ids.actionId, randomUUID(), `fixture:${ids.actionId}`]);
  await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Fixture')", [tenantId, ids.pipelineId]);
  await tx.query(
    `INSERT INTO booking_resources (tenant_id,id,name,slot_length_minutes,slot_step_minutes,buffer_before_minutes,
       buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes) VALUES ($1,$2,'Fixture',30,15,0,0,0,1440)`,
    [tenantId, ids.resourceId]);
  await tx.query("INSERT INTO booking_pages (tenant_id,id,title,created_at) VALUES ($1,$2,'Fixture',now())", [tenantId, ids.pageId]);
  return ids;
}
const insertSetup = (tx: Transaction, tenantId: string, ids: Seeded, templateId = "agency", version = 1) => tx.query(
  `INSERT INTO tenant_setups (tenant_id,template_id,template_version,action_id,pipeline_id,resource_id,booking_page_id,applied_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
  [tenantId, templateId, version, ids.actionId, ids.pipelineId, ids.resourceId, ids.pageId]);

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  await fixture.service(async (tx) => {
    seeded.set(fixture.a.tenantId, await seedParents(tx, fixture.a.tenantId));
    seeded.set(fixture.b.tenantId, await seedParents(tx, fixture.b.tenantId));
  });
});
afterAll(async () => { await database?.close(); });

describe("tenant_setups (IT-3)", () => {
  it("forces RLS and grants only SELECT and INSERT", async () => {
    const meta = await fixture.service(async (tx) => (await tx.query(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid='public.tenant_setups'::regclass`)).rows[0]);
    expect(meta).toEqual({ rls: true, forced: true });
    const grants = await fixture.service(async (tx) => (await tx.query<{ role: string; privilege: string }>(
      `SELECT CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE acl.grantee::regrole::text END AS role, acl.privilege_type AS privilege
         FROM pg_class c, LATERAL aclexplode(c.relacl) acl
        WHERE c.oid='public.tenant_setups'::regclass AND acl.grantee <> c.relowner
        ORDER BY 1,2`)).rows);
    expect(grants).toEqual([
      { role: "authenticated", privilege: "INSERT" }, { role: "authenticated", privilege: "SELECT" },
      { role: "service_role", privilege: "INSERT" }, { role: "service_role", privilege: "SELECT" },
    ]);
  });

  it("lets the runtime role insert and read its own tenant's row, and nobody else's", async () => {
    const a = seeded.get(fixture.a.tenantId)!;
    await fixture.a.run((tx) => insertSetup(tx, fixture.a.tenantId, a));
    expect((await fixture.a.run((tx) => tx.query("SELECT template_id FROM tenant_setups"))).rows).toEqual([{ template_id: "agency" }]);
    expect((await fixture.b.run((tx) => tx.query("SELECT * FROM tenant_setups"))).rowCount).toBe(0);
    expect((await fixture.b.run((tx) => tx.query("SELECT * FROM tenant_setups WHERE tenant_id=$1", [fixture.a.tenantId]))).rowCount).toBe(0);
  });

  it("refuses tenant B a row for tenant A, or one that references tenant A's records", async () => {
    const a = seeded.get(fixture.a.tenantId)!;
    const b = seeded.get(fixture.b.tenantId)!;
    await expect(fixture.b.run((tx) => insertSetup(tx, fixture.a.tenantId, a))).rejects.toMatchObject({ code: "42501" });
    for (const field of ["pipelineId", "resourceId", "pageId", "actionId"] as const) {
      await expect(fixture.b.run((tx) => insertSetup(tx, fixture.b.tenantId, { ...b, [field]: a[field] })), field)
        .rejects.toMatchObject({ code: "23503" });
    }
  });

  it("checks the action at commit, so the action row may follow the setup row", async () => {
    const tenantId = randomUUID();
    await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Deferred')", [tenantId]));
    const ids = await fixture.service((tx) => seedParents(tx, tenantId));
    const later = { ...ids, actionId: randomUUID() };
    await fixture.service(async (tx) => {
      await insertSetup(tx, tenantId, later);
      await tx.query(
        `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
         VALUES ($1,$2,$3,'tenant.template.apply','{}','{}','fixture:deferred','{}',now())`,
        [tenantId, later.actionId, randomUUID()]);
    });
    const other = randomUUID();
    await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Missing action')", [other]));
    const otherIds = await fixture.service((tx) => seedParents(tx, other));
    await expect(fixture.service((tx) => insertSetup(tx, other, { ...otherIds, actionId: randomUUID() })))
      .rejects.toMatchObject({ code: "23503", constraint: "tenant_setups_action_fk" });
  });

  it("refuses an unknown template id, a version below 1 and a second row for a tenant", async () => {
    const b = seeded.get(fixture.b.tenantId)!;
    await expect(fixture.b.run((tx) => insertSetup(tx, fixture.b.tenantId, b, "bakery"))).rejects.toMatchObject({ code: "23514" });
    await expect(fixture.b.run((tx) => insertSetup(tx, fixture.b.tenantId, b, "agency", 0))).rejects.toMatchObject({ code: "23514" });
    const a = seeded.get(fixture.a.tenantId)!;
    await expect(fixture.a.run((tx) => insertSetup(tx, fixture.a.tenantId, a, "fitness"))).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses UPDATE and DELETE to the runtime role and the service role", async () => {
    for (const run of [fixture.a.run, fixture.b.run, fixture.service]) {
      await expect(run((tx) => tx.query("UPDATE tenant_setups SET template_id='crafts'"))).rejects.toMatchObject({ code: "42501" });
      await expect(run((tx) => tx.query("DELETE FROM tenant_setups"))).rejects.toMatchObject({ code: "42501" });
    }
    expect((await fixture.service((tx) => tx.query("SELECT * FROM tenant_setups WHERE tenant_id=$1", [fixture.a.tenantId]))).rowCount).toBe(1);
  });
});

describe("apply and publish grants (IT-4, IT-11)", () => {
  it("lets the runtime role insert its own configuration rows and change only a page's published flag", async () => {
    const tenantId = fixture.b.tenantId;
    const pipelineId = randomUUID();
    const resourceId = randomUUID();
    const pageId = randomUUID();
    await fixture.b.run(async (tx) => {
      await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Runtime')", [tenantId, pipelineId]);
      await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,'Won',0,'won')",
        [tenantId, randomUUID(), pipelineId]);
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,name,time_zone,slot_length_minutes,slot_step_minutes,buffer_before_minutes,
           buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes) VALUES ($1,$2,'Runtime','UTC',30,15,0,0,0,1440)`,
        [tenantId, resourceId]);
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,created_at) VALUES ($1,$2,'Runtime',now())", [tenantId, pageId]);
      await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id) VALUES ($1,$2,$3)", [tenantId, pageId, resourceId]);
      await tx.query("UPDATE booking_pages SET published=true WHERE id=$1", [pageId]);
      await tx.query("UPDATE business_profiles SET time_zone='Europe/Berlin', revision=revision+1");
    });
    expect((await fixture.b.run((tx) => tx.query("SELECT count(*)::int AS n FROM booking_page_disclosures WHERE page_id=$1", [pageId]))).rows[0])
      .toEqual({ n: 1 });
    expect((await fixture.b.run((tx) => tx.query("SELECT published FROM booking_pages WHERE id=$1", [pageId]))).rows[0])
      .toEqual({ published: true });
    await expect(fixture.b.run((tx) => tx.query("UPDATE booking_pages SET title='Changed' WHERE id=$1", [pageId])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(fixture.b.run((tx) => tx.query("DELETE FROM booking_pages WHERE id=$1", [pageId])))
      .rejects.toMatchObject({ code: "42501" });
    // Tenant A's runtime role cannot see or publish tenant B's page.
    expect((await fixture.a.run((tx) => tx.query("UPDATE booking_pages SET published=false WHERE id=$1", [pageId]))).rowCount).toBe(0);
    await expect(fixture.a.run((tx) => tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Cross')", [tenantId, randomUUID()])))
      .rejects.toMatchObject({ code: "42501" });
  });
});
