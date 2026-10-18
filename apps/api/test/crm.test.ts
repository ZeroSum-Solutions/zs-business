import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  contactPageSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
} from "@zs/contracts";
import { call, contactAndDeal, createApiHarness, type ApiHarness } from "./helpers.js";

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

  it("returns 400 for a non-UUID deal ID", async () => {
    const response = await call(h.app, "POST", "/v1/crm/deals/nope/stage", {
      token: h.a.token, key: randomUUID(), body: { pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 },
    });
    expect(response.status).toBe(400);
  });

  it("lists deals and pipelines with stages", async () => {
    const deals = dealPageSchema.parse((await call(h.app, "GET", `/v1/crm/deals?pipelineId=${h.a.pipelineId}`, { token: h.a.token })).body);
    expect(deals.items.length).toBeGreaterThan(0);
    const pipelines = (await call(h.app, "GET", "/v1/crm/pipelines", { token: h.a.token })).body.items;
    expect(pipelines.map((item: unknown) => pipelineSummarySchema.parse(item))).toEqual([
      { id: h.a.pipelineId, name: "Sales", stages: [
        { id: h.a.stages[0], name: "New", position: 0 }, { id: h.a.stages[1], name: "Won", position: 1 },
      ] },
    ]);
  });
});
