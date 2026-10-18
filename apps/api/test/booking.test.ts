import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, bookingPageSchema, createBookingOutputSchema, slotsResponseSchema } from "@zs/contracts";
import { call, createApiHarness, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

const book = (startsAt: string, key = randomUUID(), tenant = h.a, resourceId = tenant.resourceId) =>
  call(h.app, "POST", "/v1/booking/bookings", { token: tenant.token, key, body: { resourceId, startsAt } });

describe("POST /v1/booking/bookings", () => {
  it("lets exactly one of two concurrent overlapping creates win", async () => {
    const [first, second] = await Promise.all([book("2026-10-19T10:00:00.000Z"), book("2026-10-19T10:30:00.000Z")]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    expect(apiErrorBodySchema.parse(loser.body).error).toMatchObject({ code: "Conflict", details: { reason: "slot_unavailable" } });
    const listed = bookingPageSchema.parse((await call(h.app, "GET", "/v1/booking/bookings", { token: h.a.token })).body);
    expect(listed.items.filter((item) => item.startsAt.startsWith("2026-10-19T10:"))).toHaveLength(1);
  });

  it("replays the stored result for a repeated Idempotency-Key", async () => {
    const key = randomUUID();
    const first = await book("2026-10-19T12:00:00.000Z", key);
    const again = await book("2026-10-19T12:00:00.000Z", key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(createBookingOutputSchema.parse(first.body).result.startsAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("rejects reuse of a key with a different body", async () => {
    const key = randomUUID();
    expect((await book("2026-10-19T13:00:00.000Z", key)).status).toBe(201);
    const reused = await book("2026-10-19T14:00:00.000Z", key);
    expect(reused.status).toBe(409);
    expect(apiErrorBodySchema.parse(reused.body).error.details).toEqual({ reason: "idempotency_key_reused" });
  });

  it("returns 400 with the error shape for a bad body", async () => {
    const response = await call(h.app, "POST", "/v1/booking/bookings", {
      token: h.a.token, key: randomUUID(), body: { resourceId: "not-a-uuid", startsAt: "tomorrow", extra: 1 },
    });
    expect(response.status).toBe(400);
    const body = apiErrorBodySchema.parse(response.body);
    expect(body.error.code).toBe("ValidationFailed");
    const paths = (body.error.details.issues as { path: string }[]).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["resourceId", "startsAt"]));
  });

  it("returns 400 for malformed JSON and a missing Idempotency-Key", async () => {
    const malformed = await h.app.request("/v1/booking/bookings", {
      method: "POST", body: "{",
      headers: { Authorization: `Bearer ${h.a.token}`, "Content-Type": "application/json", "Idempotency-Key": "k" },
    });
    expect(malformed.status).toBe(400);
    apiErrorBodySchema.parse(await malformed.json());
    const noKey = await call(h.app, "POST", "/v1/booking/bookings", {
      token: h.a.token, body: { resourceId: h.a.resourceId, startsAt: "2026-10-19T15:00:00.000Z" },
    });
    expect(noKey.status).toBe(400);
    expect(apiErrorBodySchema.parse(noKey.body).error.code).toBe("ValidationFailed");
  });
  it("rejects an oversized body with 413 and the error shape", async () => {
    const response = await call(h.app, "POST", "/v1/booking/bookings", {
      token: h.a.token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt: "x".repeat(70000) },
    });
    expect(response.status).toBe(413);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
  });
});

describe("GET /v1/booking/slots", () => {
  it("lists free slots with local labels and hides booked ones", async () => {
    const query = `resourceId=${h.a.resourceId}&from=2026-10-19T09:00:00.000Z&to=2026-10-19T17:00:00.000Z&zone=America/New_York`;
    const response = await call(h.app, "GET", `/v1/booking/slots?${query}`, { token: h.a.token });
    expect(response.status).toBe(200);
    const body = slotsResponseSchema.parse(response.body);
    expect(body.zone).toBe("America/New_York");
    const starts = body.slots.map((slot) => slot.startsAt);
    expect(starts).not.toContain("2026-10-19T12:00:00.000Z");
    expect(starts).toContain("2026-10-19T09:00:00.000Z");
    expect(body.slots.find((slot) => slot.startsAt === "2026-10-19T09:00:00.000Z")?.localStart).toBe("2026-10-19T05:00:00");
  });

  it("rejects a missing range with 400", async () => {
    const response = await call(h.app, "GET", `/v1/booking/slots?resourceId=${h.a.resourceId}`, { token: h.a.token });
    expect(response.status).toBe(400);
    apiErrorBodySchema.parse(response.body);
  });
});
