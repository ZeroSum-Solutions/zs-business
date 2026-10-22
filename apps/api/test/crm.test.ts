import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  contactPageSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
  setDealDetailsOutputSchema,
} from "@zs/contracts";
import { call, contactAndDeal, createApiHarness, NOW, signedInMember, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

describe("contacts", () => {
  it("dedupes by email: 201 on create, 200 with the same contact on a match", async () => {
    const first = await call(h.app, "POST", "/v1/crm/contacts", {
      token: h.a.token, key: randomUUID(), body: { displayName: "Maren", email: "Maren@Example.com" },
    });
    const second = await call(h.app, "POST", "/v1/crm/contacts", {
      token: h.a.token, key: randomUUID(), body: { email: "maren@example.com", phone: "+12025550101" },
    });
    expect([first.status, second.status]).toEqual([201, 200]);
    const created = createOrFindContactOutputSchema.parse(first.body).result;
    const matched = createOrFindContactOutputSchema.parse(second.body).result;
    expect(matched).toMatchObject({ created: false, contact: { id: created.contact.id, phone: "+12025550101" } });
  });

  it("replays a contact create with its original status: 201 for a create, 200 for a match", async () => {
    const createKey = randomUUID();
    const body = { displayName: "Replay", email: "replay@example.com" };
    const created = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: createKey, body });
    const replayed = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: createKey, body });
    expect([created.status, replayed.status]).toEqual([201, 201]);
    expect(replayed.body).toEqual(created.body);
    const matchKey = randomUUID();
    const matched = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: matchKey, body });
    const matchReplay = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: matchKey, body });
    expect([matched.status, matchReplay.status]).toEqual([200, 200]);
    expect(matchReplay.body).toEqual(matched.body);
  });

  it("refuses consent evidence dated outside years 0001-9999 with a 400 and writes nothing", async () => {
    const count = () => h.fixture.service(async (tx) => (await tx.query(
      "SELECT (SELECT count(*) FROM actions WHERE tenant_id=$1) + (SELECT count(*) FROM crm_contacts WHERE tenant_id=$1) AS n",
      [h.a.tenantId])).rows[0].n);
    const before = await count();
    for (const recordedAt of ["0000-01-01T00:00:00.000Z", "0000-02-29T12:34:56.789Z"]) {
      const response = await call(h.app, "POST", "/v1/crm/contacts", {
        token: h.a.token, key: randomUUID(),
        body: { email: "year-zero@example.com", consent: { email: { status: "granted", source: "owner", recordedAt }, sms: null } },
      });
      expect(response.status).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
    expect(await count()).toBe(before);
  });

  it("rejects a contact without any identity", async () => {
    const response = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: randomUUID(), body: { displayName: "X" } });
    expect(response.status).toBe(400);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
  });

  it("pages the contact list", async () => {
    await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: randomUUID(), body: { phone: "+12025550199" } });
    const page = contactPageSchema.parse((await call(h.app, "GET", "/v1/crm/contacts?limit=1", { token: h.a.token })).body);
    expect(page.items).toHaveLength(1);
    expect(page.nextOffset).toBe(1);
    const bad = await call(h.app, "GET", "/v1/crm/contacts?limit=0", { token: h.a.token });
    expect(bad.status).toBe(400);
  });
});

describe("deal stage moves", () => {
  it("moves with the expected revision and returns 409 for a stale one", async () => {
    const { dealId } = await contactAndDeal(h, h.a, "move@example.com");
    const body = { pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 };
    const moved = await call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, { token: h.a.token, key: randomUUID(), body });
    expect(moved.status).toBe(200);
    expect(moveDealStageOutputSchema.parse(moved.body).result).toMatchObject({ stageId: h.a.stages[1], revision: 2 });
    const stale = await call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, {
      token: h.a.token, key: randomUUID(), body: { ...body, stageId: h.a.stages[0] },
    });
    expect(stale.status).toBe(409);
    expect(apiErrorBodySchema.parse(stale.body).error.details).toEqual({ reason: "stale_revision", currentRevision: 2 });
  });

  it("stamps the won date from the injected clock on entering a won stage and clears it on leaving (H-2)", async () => {
    const { contactId, dealId } = await contactAndDeal(h, h.a, "won@example.com");
    const listed = async () => dealPageSchema.parse((await call(h.app, "GET", `/v1/crm/deals?contactId=${contactId}`, {
      token: h.a.token,
    })).body).items.find((deal) => deal.id === dealId)!;
    expect(await listed()).toMatchObject({ stageId: h.a.stages[0], value: null, leadSource: null, wonAt: null });
    const move = (stageId: string, expectedRevision: number) => call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, {
      token: h.a.token, key: randomUUID(), body: { pipelineId: h.a.pipelineId, stageId, expectedRevision },
    });
    expect((await move(h.a.stages[1], 1)).status).toBe(200);
    expect(await listed()).toMatchObject({ stageId: h.a.stages[1], revision: 2, wonAt: NOW });
    expect((await move(h.a.stages[0], 2)).status).toBe(200);
    expect(await listed()).toMatchObject({ stageId: h.a.stages[0], revision: 3, wonAt: null });
  });

  it("replays a deal create with its original 201", async () => {
    const { contactId } = await contactAndDeal(h, h.a, "deal-replay@example.com");
    const key = randomUUID();
    const body = { contactId, pipelineId: h.a.pipelineId, stageId: h.a.stages[0], title: "Replay" };
    const created = await call(h.app, "POST", "/v1/crm/deals", { token: h.a.token, key, body });
    const replayed = await call(h.app, "POST", "/v1/crm/deals", { token: h.a.token, key, body });
    expect([created.status, replayed.status]).toEqual([201, 201]);
    expect(replayed.body).toEqual(created.body);
  });

  it("returns 400 for a non-UUID deal ID", async () => {
    const response = await call(h.app, "POST", "/v1/crm/deals/nope/stage", {
      token: h.a.token, key: randomUUID(), body: { pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 },
    });
    expect(response.status).toBe(400);
  });

  it("lists deals with their details and pipelines with stages and outcomes", async () => {
    const { contactId, dealId } = await contactAndDeal(h, h.a, "listed@example.com");
    const deals = dealPageSchema.parse((await call(h.app, "GET", `/v1/crm/deals?pipelineId=${h.a.pipelineId}`, { token: h.a.token })).body);
    expect(deals.items.find((deal) => deal.id === dealId)).toEqual({
      id: dealId, tenantId: h.a.tenantId, contactId, pipelineId: h.a.pipelineId, stageId: h.a.stages[0], title: "Ring",
      revision: 1, createdAt: NOW, updatedAt: NOW, value: null, leadSource: null, wonAt: null,
    });
    const pipelines = (await call(h.app, "GET", "/v1/crm/pipelines", { token: h.a.token })).body.items;
    expect(pipelines.map((item: unknown) => pipelineSummarySchema.parse(item))).toEqual([
      { id: h.a.pipelineId, name: "Sales", stages: [
        { id: h.a.stages[0], name: "New", position: 0, outcome: "open" },
        { id: h.a.stages[1], name: "Won", position: 1, outcome: "won" },
      ] },
    ]);
  });
});

describe("deal details (H-1)", () => {
  const setDetails = (dealId: string, body: unknown, token = h.a.token, key: string = randomUUID()) =>
    call(h.app, "POST", `/v1/crm/deals/${dealId}/details`, { token, key, body });
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

  it("sets value and lead source, bumps the revision, and lists them", async () => {
    const { contactId, dealId } = await contactAndDeal(h, h.a, "details@example.com");
    const key = randomUUID();
    const body = { expectedRevision: 1, value: usd(125000), leadSource: "website" };
    const set = await setDetails(dealId, body, h.a.token, key);
    expect(set.status).toBe(200);
    const result = setDealDetailsOutputSchema.parse(set.body).result;
    expect(result).toMatchObject({ id: dealId, revision: 2, updatedAt: NOW, value: usd(125000), leadSource: "website", wonAt: null });
    // A replay returns the stored result; reusing the key with another body is refused.
    expect((await setDetails(dealId, body, h.a.token, key)).body).toEqual(set.body);
    const reused = await setDetails(dealId, { ...body, leadSource: "phone" }, h.a.token, key);
    expect(reused.status).toBe(409);
    expect(apiErrorBodySchema.parse(reused.body).error.details).toEqual({ reason: "idempotency_key_reused" });
    const listed = dealPageSchema.parse((await call(h.app, "GET", `/v1/crm/deals?contactId=${contactId}`, { token: h.a.token })).body);
    expect(listed.items).toEqual([result]);
    // Clearing both is allowed.
    const cleared = await setDetails(dealId, { expectedRevision: 2, value: null, leadSource: null });
    expect(setDealDetailsOutputSchema.parse(cleared.body).result).toMatchObject({ revision: 3, value: null, leadSource: null });
  });

  it("answers a stale revision with 409 stale_revision and the current revision", async () => {
    const { dealId } = await contactAndDeal(h, h.a, "details-stale@example.com");
    expect((await setDetails(dealId, { expectedRevision: 1, value: usd(5000), leadSource: "referral" })).status).toBe(200);
    const stale = await setDetails(dealId, { expectedRevision: 1, value: usd(9000), leadSource: "referral" });
    expect(stale.status).toBe(409);
    expect(apiErrorBodySchema.parse(stale.body).error).toMatchObject({
      code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 },
    });
    // A stage move uses the same revision, so it sees the details write too.
    const move = await call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, {
      token: h.a.token, key: randomUUID(), body: { pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 },
    });
    expect(apiErrorBodySchema.parse(move.body).error.details).toEqual({ reason: "stale_revision", currentRevision: 2 });
  });

  it("lets staff set details (customers), refuses another tenant, and validates input", async () => {
    const { dealId } = await contactAndDeal(h, h.a, "details-staff@example.com");
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    expect((await setDetails(dealId, { expectedRevision: 1, value: usd(100), leadSource: "phone" }, staff.token)).status).toBe(200);
    const foreign = await setDetails(dealId, { expectedRevision: 2, value: usd(1), leadSource: "ads" }, h.b.token);
    expect(foreign.status).toBe(403);
    expect(apiErrorBodySchema.parse(foreign.body).error.code).toBe("Forbidden");
    for (const body of [
      { expectedRevision: 2, value: { amountMinor: 1, currency: "usd" }, leadSource: null },
      { expectedRevision: 2, value: { amountMinor: -1, currency: "USD" }, leadSource: null },
      { expectedRevision: 2, value: null, leadSource: "billboard" },
      { expectedRevision: 2, value: null },
    ]) {
      const bad = await setDetails(dealId, body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(apiErrorBodySchema.parse(bad.body).error.code).toBe("ValidationFailed");
    }
    expect((await setDetails("nope", { expectedRevision: 2, value: null, leadSource: null })).status).toBe(400);
    const missingKey = await call(h.app, "POST", `/v1/crm/deals/${dealId}/details`, {
      token: h.a.token, body: { expectedRevision: 2, value: null, leadSource: null },
    });
    expect(missingKey.status).toBe(400);
  });
});
