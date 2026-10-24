// enrichment.md E-4, E-6, E-7, E-17: the HTTP edge. Auth, owner vs staff, and tenant isolation. The
// worker and the Treg call are covered in core; here no call is made.
import { randomUUID } from "node:crypto";
import { creditWallet } from "@zs/core";
import { apiErrorBodySchema, contactEnrichmentSchema, enrichmentRequestRecordSchema } from "@zs/contracts";
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
async function contact(tenantId: string, email: string | null = null): Promise<string> {
  const id = randomUUID();
  serial += 1;
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
     VALUES ($1,$2,'Sam Buyer',$3,$4,$5,$5)`,
    [tenantId, id, email ?? `sam${serial}@acme.example`, `+1415556${String(serial).padStart(4, "0")}`, NOW]));
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
