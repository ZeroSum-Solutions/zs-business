// Enrichment storage rules (20261023600000_enrichment.sql; enrichment.md E-7, E-13): the runtime role
// cannot change request state or touch results, the service role cannot update a result, and a
// change to a contact's email or phone clears the owner's region mark.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

const T0 = "2026-10-23T09:00:00.000Z";
let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let contactId: string;
let requestId: string;
let resultId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  contactId = randomUUID();
  requestId = randomUUID();
  resultId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,'Sam','sam@acme.example','+14155550101',$3,$3)`, [tenantId, contactId, T0]);
    await tx.query(
      `INSERT INTO enrichment_requests (tenant_id,id,contact_id,domain,price_cents,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,'acme.example',5,$4,$4,$4)`, [tenantId, requestId, contactId, T0]);
    await tx.query(
      `INSERT INTO enrichment_results (tenant_id,id,request_id,contact_id,field,value,provider,treg_call_id,fetched_at,expires_at)
       VALUES ($1,$2,$3,$4,'name','Acme','fake','c1',$5,'2026-11-23T09:00:00.000Z')`, [tenantId, resultId, requestId, contactId, T0]);
  });
});
afterAll(async () => { await database?.close(); });

const denied = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

describe("enrichment grants", () => {
  it("lets the runtime role read its own rows and insert a request, but never move one or touch a result", async () => {
    expect(await fixture.a.run(async (tx) => (await tx.query("SELECT 1 FROM enrichment_results")).rowCount)).toBe(1);
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "UPDATE enrichment_requests SET status='succeeded' WHERE tenant_id=$1 AND id=$2", [tenantId, requestId])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      "DELETE FROM enrichment_results WHERE tenant_id=$1", [tenantId])))).toMatchObject({ code: "42501" });
    expect(await denied(() => fixture.a.run((tx) => tx.query(
      `INSERT INTO enrichment_requests (tenant_id,id,contact_id,domain,price_cents,status,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,'acme.example',5,'succeeded',$4,$4,$4)`, [tenantId, randomUUID(), contactId, T0])))).toMatchObject({ code: "42501" });
    await fixture.a.run((tx) => tx.query(
      `INSERT INTO enrichment_requests (tenant_id,id,contact_id,domain,price_cents,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,'acme.example',5,$4,$4,$4)`, [tenantId, randomUUID(), contactId, T0]));
  });

  it("does not let the service role update a result", async () => {
    expect(await denied(() => fixture.service((tx) => tx.query(
      "UPDATE enrichment_results SET value='Other' WHERE tenant_id=$1", [tenantId])))).toMatchObject({ code: "42501" });
  });

  it("does not show tenant B a row, and refuses it a row for tenant A", async () => {
    expect(await fixture.b.run(async (tx) => (await tx.query("SELECT 1 FROM enrichment_requests")).rowCount)).toBe(0);
    expect(await denied(() => fixture.b.run((tx) => tx.query(
      `INSERT INTO enrichment_requests (tenant_id,id,contact_id,domain,price_cents,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,'acme.example',5,$4,$4,$4)`, [tenantId, randomUUID(), contactId, T0])))).toMatchObject({ code: "42501" });
  });
});

describe("the region mark", () => {
  const attested = () => fixture.service(async (tx) => (await tx.query<{ at: Date | null; revision: number }>(
    "SELECT outside_eu_uk_attested_at AS at, revision FROM crm_contact_profile WHERE tenant_id=$1 AND contact_id=$2",
    [tenantId, contactId])).rows[0]!);

  it("survives a name change and is cleared by an email or phone change", async () => {
    await fixture.service((tx) => tx.query(
      `INSERT INTO crm_contact_profile (tenant_id,contact_id,outside_eu_uk_attested_by,outside_eu_uk_attested_at,updated_at)
       VALUES ($1,$2,$3,$4,$4)`, [tenantId, contactId, randomUUID(), T0]));
    await fixture.service((tx) => tx.query("UPDATE crm_contacts SET display_name='Samuel' WHERE tenant_id=$1 AND id=$2", [tenantId, contactId]));
    expect((await attested()).at).not.toBeNull();
    await fixture.service((tx) => tx.query("UPDATE crm_contacts SET normalized_email='sam@other.example' WHERE tenant_id=$1 AND id=$2", [tenantId, contactId]));
    expect(await attested()).toMatchObject({ at: null, revision: 2 });
    await fixture.service((tx) => tx.query(
      "UPDATE crm_contact_profile SET outside_eu_uk_attested_by=$3, outside_eu_uk_attested_at=$4 WHERE tenant_id=$1 AND contact_id=$2",
      [tenantId, contactId, randomUUID(), T0]));
    await fixture.service((tx) => tx.query("UPDATE crm_contacts SET e164_phone='+14155550102' WHERE tenant_id=$1 AND id=$2", [tenantId, contactId]));
    expect((await attested()).at).toBeNull();
  });
});
