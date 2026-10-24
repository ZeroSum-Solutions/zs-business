// enrichment.md E-4, E-6, E-7, E-17: the HTTP edge. Auth, owner vs staff, and tenant isolation. The
// worker and the Treg call are covered in core; here no call is made.
import { randomUUID } from "node:crypto";
import { creditWallet, enrichmentActorId } from "@zs/core";
import { apiErrorBodySchema, contactEnrichmentSchema, enrichmentProposalListSchema, enrichmentRequestRecordSchema } from "@zs/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createApiHarness, NOW, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

let h: ApiHarness;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness({ enrichment: { provider: "fake", archiveConfirmedOff: true } });
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
  await h.fixture.service((tx) => creditWallet(tx, {
    tenantId: h.a.tenantId, ledgerId: randomUUID(), amount: 1_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(NOW),
  }));
});
afterAll(async () => { await h?.close(); });

let serial = 0;
async function contact(tenantId: string, email: string | null = null, displayName: string | null = "Sam Buyer"): Promise<string> {
  const id = randomUUID();
  serial += 1;
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
     VALUES ($1,$2,$6,$3,$4,$5,$5)`,
    [tenantId, id, email ?? `sam${serial}@acme.example`, `+1415556${String(serial).padStart(4, "0")}`, NOW, displayName]));
  return id;
}

describe("enrichment routes", () => {
  it("needs a token", async () => {
    const response = await call(h.app, "POST", "/v1/enrichment/requests", { key: randomUUID(), body: { op: "company.enrich", contactId: randomUUID() } });
    expect(response.status).toBe(401);
  });

  it("lets an owner request an enrichment, and replays the same key to the same request", async () => {
    const contactId = await contact(h.a.tenantId);
    const key = randomUUID();
    const body = { op: "company.enrich", contactId };
    const first = await call(h.app, "POST", "/v1/enrichment/requests", { token: h.a.token, key, body });
    expect(first.status).toBe(201);
    const record = enrichmentRequestRecordSchema.parse(first.body.result ?? first.body);
    expect(record).toMatchObject({ contactId, status: "pending" });
    const replay = await call(h.app, "POST", "/v1/enrichment/requests", { token: h.a.token, key, body });
    expect(enrichmentRequestRecordSchema.parse(replay.body.result ?? replay.body).id).toBe(record.id);
    const read = await call(h.app, "GET", `/v1/enrichment/requests/${record.id}`, { token: h.a.token });
    expect(read.status).toBe(200);
  });

  it("refuses staff a request, and lets staff read and block", async () => {
    const contactId = await contact(h.a.tenantId);
    const denied = await call(h.app, "POST", "/v1/enrichment/requests", {
      token: staff.token, key: randomUUID(), body: { op: "company.enrich", contactId } });
    expect(denied.status).toBe(403);
    const read = await call(h.app, "GET", `/v1/contacts/${contactId}/enrichment`, { token: staff.token });
    expect(read.status).toBe(200);
    expect(contactEnrichmentSchema.parse(read.body).requests).toEqual([]);
    const blocked = await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/block`, {
      token: staff.token, key: randomUUID(), body: { reason: "asked us not to" } });
    expect(blocked.status).toBe(200);
    const unblockDenied = await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/unblock`, { token: staff.token, key: randomUUID() });
    expect(unblockDenied.status).toBe(403);
    const unblocked = await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/unblock`, { token: h.a.token, key: randomUUID() });
    expect(unblocked.status).toBe(200);
  });

  it("answers a blocked contact with enrichment_blocked", async () => {
    const contactId = await contact(h.a.tenantId);
    await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/block`, { token: h.a.token, key: randomUUID(), body: { reason: "no" } });
    const response = await call(h.app, "POST", "/v1/enrichment/requests", {
      token: h.a.token, key: randomUUID(), body: { op: "company.enrich", contactId } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(apiErrorBodySchema.parse(response.body).error.details).toMatchObject({ reason: "enrichment_blocked" });
  });

  it("shows tenant B nothing of tenant A: reads are NotFound, writes answer like an unknown contact", async () => {
    const contactId = await contact(h.a.tenantId);
    const created = await call(h.app, "POST", "/v1/enrichment/requests", {
      token: h.a.token, key: randomUUID(), body: { op: "company.enrich", contactId } });
    const requestId = enrichmentRequestRecordSchema.parse(created.body.result ?? created.body).id;
    for (const path of [`/v1/enrichment/requests/${requestId}`, `/v1/contacts/${contactId}/enrichment`]) {
      const response = await call(h.app, "GET", path, { token: h.b.token });
      expect(response.status, path).toBe(404);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
    }
    const unknown = randomUUID();
    for (const [path, unknownPath, body] of [
      [`/v1/contacts/${contactId}/region`, `/v1/contacts/${unknown}/region`, undefined],
      [`/v1/contacts/${contactId}/enrichment/block`, `/v1/contacts/${unknown}/enrichment/block`, { reason: "x" }],
    ] as const) {
      const foreign = await call(h.app, "POST", path, { token: h.b.token, key: randomUUID(), body });
      const missing = await call(h.app, "POST", unknownPath, { token: h.b.token, key: randomUUID(), body });
      expect([foreign.status, missing.status], path).toEqual([403, 403]);
    }
    const cross = await call(h.app, "POST", "/v1/enrichment/requests", {
      token: h.b.token, key: randomUUID(), body: { op: "company.enrich", contactId } });
    expect(cross.status).toBe(403);
    const none = await h.fixture.service(async (tx) => (await tx.query(
      "SELECT count(*)::int AS n FROM enrichment_requests WHERE tenant_id=$1", [h.b.tenantId])).rows[0].n);
    expect(none).toBe(0);
  });
});

/**
 * What the worker writes after a hit (E-13, E-14): a settled request, then one result and one
 * approval per field. Inserted directly so these tests make no call.
 */
async function proposals(tenantId: string, contactId: string, fields: Record<string, string>, { at = NOW, expires = "2026-11-18T08:00:00.000Z" } = {}) {
  const requestId = randomUUID();
  await h.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO enrichment_requests (tenant_id,id,contact_id,domain,price_cents,status,next_attempt_at,created_at,updated_at)
       VALUES ($1,$2,$3,'acme.example',5,'succeeded',$4,$4,$4)`, [tenantId, requestId, contactId, at]);
    for (const [field, value] of Object.entries(fields)) {
      const approvalId = randomUUID();
      const resultId = randomUUID();
      await tx.query(
        `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at)
         VALUES ($1,$2,'contact.profile.apply','contact',$3,$4,$5,$6,$7,$8)`,
        [tenantId, approvalId, contactId, JSON.stringify({ contactId, resultId }), `Save the company ${field} found for this contact`,
          enrichmentActorId(tenantId), at, expires]);
      await tx.query(
        `INSERT INTO enrichment_results (tenant_id,id,request_id,contact_id,field,value,provider,treg_call_id,approval_id,fetched_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'fake','call_1',$7,$8,$9)`,
        [tenantId, resultId, requestId, contactId, field, value, approvalId, at, expires]);
    }
  });
}

async function listProposals(token: string) {
  const response = await call(h.app, "GET", "/v1/enrichment/proposals", { token });
  expect(response.status).toBe(200);
  return enrichmentProposalListSchema.parse(response.body).items;
}

describe("enrichment proposals", () => {
  it("needs a token", async () => {
    expect((await call(h.app, "GET", "/v1/enrichment/proposals")).status).toBe(401);
  });

  it("lists each pending field with the current and the found value; approve writes it, reject drops it", async () => {
    const contactId = await contact(h.a.tenantId);
    await h.fixture.service((tx) => tx.query(
      `INSERT INTO crm_contact_profile (tenant_id,contact_id,company_name,updated_at) VALUES ($1,$2,'Acme Old',$3)`,
      [h.a.tenantId, contactId, NOW]));
    await proposals(h.a.tenantId, contactId, { name: "Acme Widgets", employees: "40", industry: "Hardware" });

    const mine = (await listProposals(h.a.token)).filter((p) => p.contactId === contactId);
    expect(mine.map((p) => [p.field, p.currentValue, p.proposedValue]).sort()).toEqual([
      ["employees", null, "40"], ["industry", null, "Hardware"], ["name", "Acme Old", "Acme Widgets"],
    ]);
    expect(mine[0]).toMatchObject({ contactName: "Sam Buyer", provider: "fake", callId: "call_1" });
    // Staff read the list too (E-17) but cannot decide.
    expect((await listProposals(staff.token)).filter((p) => p.contactId === contactId)).toHaveLength(3);

    const name = mine.find((p) => p.field === "name")!;
    const industry = mine.find((p) => p.field === "industry")!;
    const staffApprove = await call(h.app, "POST", `/v1/approvals/${name.approvalId}/approve`, { token: staff.token, key: randomUUID(), body: {} });
    expect(staffApprove.status).toBe(403);

    const approved = await call(h.app, "POST", `/v1/approvals/${name.approvalId}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status).toBe(200);
    const rejected = await call(h.app, "POST", `/v1/approvals/${industry.approvalId}/reject`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(rejected.status).toBe(200);

    const left = (await listProposals(h.a.token)).filter((p) => p.contactId === contactId);
    expect(left.map((p) => p.field)).toEqual(["employees"]);
    const read = contactEnrichmentSchema.parse((await call(h.app, "GET", `/v1/contacts/${contactId}/enrichment`, { token: h.a.token })).body);
    expect(read.profile).toMatchObject({ companyName: "Acme Widgets", companyIndustry: null, companyEmployees: null });
  });

  it("lists a proposal for a contact without a name", async () => {
    const contactId = await contact(h.a.tenantId, null, null);
    await proposals(h.a.tenantId, contactId, { name: "Nameless Co" });
    const mine = (await listProposals(h.a.token)).filter((p) => p.contactId === contactId);
    expect(mine).toMatchObject([{ contactName: null, proposedValue: "Nameless Co", status: "pending" }]);
  });

  it("keeps an approved proposal whose apply failed for the owner who approved it, until a retry applies it (A-7)", async () => {
    const contactId = await contact(h.a.tenantId);
    await proposals(h.a.tenantId, contactId, { industry: "Robotics" });
    const [pending] = (await listProposals(h.a.token)).filter((p) => p.contactId === contactId);
    await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/block`, { token: staff.token, key: randomUUID(), body: { reason: "asked us not to" } });

    const refused = await call(h.app, "POST", `/v1/approvals/${pending!.approvalId}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(apiErrorBodySchema.parse(refused.body).error.details).toMatchObject({ reason: "enrichment_blocked" });
    expect((await listProposals(h.a.token)).filter((p) => p.contactId === contactId))
      .toMatchObject([{ approvalId: pending!.approvalId, status: "approved" }]);
    // Only the owner who approved can retry the run, so staff do not see it.
    expect((await listProposals(staff.token)).some((p) => p.contactId === contactId)).toBe(false);

    await call(h.app, "POST", `/v1/contacts/${contactId}/enrichment/unblock`, { token: h.a.token, key: randomUUID() });
    const retried = await call(h.app, "POST", `/v1/approvals/${pending!.approvalId}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(retried.status).toBe(200);
    expect((await listProposals(h.a.token)).some((p) => p.contactId === contactId)).toBe(false);
    const read = contactEnrichmentSchema.parse((await call(h.app, "GET", `/v1/contacts/${contactId}/enrichment`, { token: h.a.token })).body);
    expect(read.profile).toMatchObject({ companyIndustry: "Robotics" });
  });

  it("leaves out expired proposals", async () => {
    const contactId = await contact(h.a.tenantId);
    await proposals(h.a.tenantId, contactId, { name: "Gone Co" }, { at: "2026-10-12T08:00:00.000Z", expires: "2026-10-19T07:59:00.000Z" });
    expect((await listProposals(h.a.token)).filter((p) => p.contactId === contactId)).toEqual([]);
  });

  it("shows tenant B none of tenant A's proposals, and B's decisions answer like an unknown approval", async () => {
    const contactId = await contact(h.a.tenantId);
    await proposals(h.a.tenantId, contactId, { domain: "acme.example" });
    const theirs = (await listProposals(h.a.token)).find((p) => p.contactId === contactId)!;
    expect((await listProposals(h.b.token)).some((p) => p.contactId === contactId)).toBe(false);
    for (const decision of ["approve", "reject"]) {
      const foreign = await call(h.app, "POST", `/v1/approvals/${theirs.approvalId}/${decision}`, { token: h.b.token, key: randomUUID(), body: {} });
      const unknown = await call(h.app, "POST", `/v1/approvals/${randomUUID()}/${decision}`, { token: h.b.token, key: randomUUID(), body: {} });
      expect([foreign.status, foreign.body], decision).toEqual([unknown.status, unknown.body]);
      expect(foreign.status, decision).toBeGreaterThanOrEqual(400);
    }
    expect((await listProposals(h.a.token)).some((p) => p.approvalId === theirs.approvalId)).toBe(true);
  });
});

describe("enrichment off", () => {
  it("answers enrichment_unavailable when no provider is configured", async () => {
    const off = await createApiHarness();
    try {
      const contactId = randomUUID();
      await off.fixture.service((tx) => tx.query(
        `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
         VALUES ($1,$2,'Sam','sam@acme.example','+14155550199',$3,$3)`, [off.a.tenantId, contactId, NOW]));
      const response = await call(off.app, "POST", "/v1/enrichment/requests", {
        token: off.a.token, key: randomUUID(), body: { op: "company.enrich", contactId } });
      expect(apiErrorBodySchema.parse(response.body).error.details).toMatchObject({ reason: "enrichment_unavailable" });
    } finally { await off.close(); }
  });
});
