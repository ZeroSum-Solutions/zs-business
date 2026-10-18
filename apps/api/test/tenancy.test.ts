import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, bookingPageSchema, contactPageSchema, dealPageSchema } from "@zs/contracts";
import { call, contactAndDeal, createApiHarness, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
let aDeal: { contactId: string; dealId: string };
let bDeal: { contactId: string; dealId: string };
beforeAll(async () => {
  h = await createApiHarness();
  aDeal = await contactAndDeal(h, h.a, "a@example.com");
  bDeal = await contactAndDeal(h, h.b, "b@example.com");
  for (const tenant of [h.a, h.b])
    expect((await call(h.app, "POST", "/v1/booking/bookings", {
      token: tenant.token, key: randomUUID(), body: { resourceId: tenant.resourceId, startsAt: "2026-10-19T09:00:00.000Z" },
    })).status).toBe(201);
});
afterAll(async () => { await h?.close(); });

// Every request runs as zs_runtime (authenticated) through ScopedDatabase; RLS does the denial.
describe("two-tenant denial over HTTP under the runtime role", () => {
  it("lists only the caller's contacts, deals and bookings", async () => {
    for (const [tenant, own] of [[h.a, aDeal], [h.b, bDeal]] as const) {
      const contacts = contactPageSchema.parse((await call(h.app, "GET", "/v1/crm/contacts", { token: tenant.token })).body);
      const deals = dealPageSchema.parse((await call(h.app, "GET", "/v1/crm/deals", { token: tenant.token })).body);
      const bookings = bookingPageSchema.parse((await call(h.app, "GET", "/v1/booking/bookings", { token: tenant.token })).body);
      expect(contacts.items.map((item) => item.id)).toEqual([own.contactId]);
      expect(deals.items.map((item) => item.id)).toEqual([own.dealId]);
      expect(bookings.items).toHaveLength(1);
      for (const item of [...contacts.items, ...deals.items, ...bookings.items]) expect(item.tenantId).toBe(tenant.tenantId);
    }
  });

  it("cannot move another tenant's deal (403) and leaves it unchanged", async () => {
    const response = await call(h.app, "POST", `/v1/crm/deals/${aDeal.dealId}/stage`, {
      token: h.b.token, key: randomUUID(), body: { pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 },
    });
    expect(response.status).toBe(403);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Forbidden");
    const deals = dealPageSchema.parse((await call(h.app, "GET", "/v1/crm/deals", { token: h.a.token })).body);
    expect(deals.items[0]).toMatchObject({ id: aDeal.dealId, stageId: h.a.stages[0], revision: 1 });
  });

  it("cannot book or read slots on another tenant's resource", async () => {
    const booking = await call(h.app, "POST", "/v1/booking/bookings", {
      token: h.b.token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: "2026-10-19T11:00:00.000Z" },
    });
    expect(booking.status).toBe(403);
    const slots = await call(h.app, "GET",
      `/v1/booking/slots?resourceId=${h.a.resourceId}&from=2026-10-19T09:00:00.000Z&to=2026-10-19T17:00:00.000Z`,
      { token: h.b.token });
    expect(slots.status).toBe(404);
    apiErrorBodySchema.parse(slots.body);
  });

  it("cannot attach a deal to another tenant's contact", async () => {
    const response = await call(h.app, "POST", "/v1/crm/deals", {
      token: h.b.token, key: randomUUID(),
      body: { contactId: aDeal.contactId, pipelineId: h.b.pipelineId, stageId: h.b.stages[0], title: "Steal" },
    });
    expect(response.status).toBe(403);
  });

  it("does not replay another tenant's idempotency key", async () => {
    const key = randomUUID();
    const body = { resourceId: h.a.resourceId, startsAt: "2026-10-19T13:00:00.000Z" };
    expect((await call(h.app, "POST", "/v1/booking/bookings", { token: h.a.token, key, body })).status).toBe(201);
    const replayAsB = await call(h.app, "POST", "/v1/booking/bookings", { token: h.b.token, key, body });
    expect(replayAsB.status).toBe(403);
  });
});
