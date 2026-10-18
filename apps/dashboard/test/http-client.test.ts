import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";

const TENANT = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const RESOURCE = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61";
const BOOKING = "b8c2d4e6-1a3f-4b5c-9d7e-000000000099";
const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";

interface Call { url: string; init: RequestInit }

function client(responses: (Response | Error)[], token: string | null = "dev-token") {
  const calls: Call[] = [];
  const queue = [...responses];
  let ids = 0;
  const api = createHttpClient({
    baseUrl: "https://api.example.test/",
    getToken: () => token,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    resources: [],
    pipeline: null,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { api, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const bookingRecord = {
  id: BOOKING, tenantId: TENANT, resourceId: RESOURCE,
  startsAt: "2026-10-20T15:00:00.000Z", endsAt: "2026-10-20T15:45:00.000Z",
  occupiedStartsAt: "2026-10-20T15:00:00.000Z", occupiedEndsAt: "2026-10-20T16:00:00.000Z",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 15, status: "confirmed", createdAt: "2026-10-18T12:00:00.000Z",
};

const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;

describe("http client", () => {
  it("sends bearer auth and a generated Idempotency-Key on writes", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: bookingRecord })]);
    const record = await api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt, bookingId: BOOKING });
    expect(record.id).toBe(BOOKING);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/booking/bookings");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headers(calls[0]).Authorization).toBe("Bearer dev-token");
    expect(headers(calls[0])["Idempotency-Key"]).toMatch(/^00000000-0000-4000-8000-/);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ bookingId: BOOKING, resourceId: RESOURCE, startsAt: bookingRecord.startsAt });
  });

  it("reuses a caller-supplied Idempotency-Key so retries are safe", async () => {
    const { api, calls } = client([
      json(201, { actionId: ACTION, result: bookingRecord }),
      json(201, { actionId: ACTION, result: bookingRecord }),
    ]);
    const input = { resourceId: RESOURCE, startsAt: bookingRecord.startsAt, bookingId: BOOKING };
    await api.createBooking(input, { idempotencyKey: "retry-key-1" });
    await api.createBooking(input, { idempotencyKey: "retry-key-1" });
    expect(headers(calls[0])["Idempotency-Key"]).toBe("retry-key-1");
    expect(headers(calls[1])["Idempotency-Key"]).toBe("retry-key-1");
  });

  it("does not send an Idempotency-Key or body on reads, and builds the slot query", async () => {
    const { api, calls } = client([json(200, { resourceId: RESOURCE, timeZone: "America/New_York", slots: [] })], null);
    await api.getSlots({ resourceId: RESOURCE, from: "2026-10-20T04:00:00.000Z", to: "2026-10-21T04:00:00.000Z", zone: "America/New_York" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/booking/slots");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      resourceId: RESOURCE, from: "2026-10-20T04:00:00.000Z", to: "2026-10-21T04:00:00.000Z", zone: "America/New_York",
    });
    expect(headers(calls[0])["Idempotency-Key"]).toBeUndefined();
    expect(headers(calls[0]).Authorization).toBeUndefined();
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it.each([
    [400, "validation"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [500, "server"],
  ] as const)("maps HTTP %i to ApiError kind %s", async (status, kind) => {
    const { api } = client([json(status, { error: { code: "Conflict", message: "Server says no", details: { a: 1 } } })]);
    const error = await api.listContacts().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe(kind);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).code).toBe("Conflict");
    expect((error as ApiError).message).toBe("Server says no");
    expect((error as ApiError).details).toEqual({ a: 1 });
  });

  it("uses a plain default message when the error body is not JSON", async () => {
    const { api } = client([new Response("<html>bad gateway</html>", { status: 502 })]);
    const error = await api.listDeals().catch((caught: unknown) => caught) as ApiError;
    expect(error.kind).toBe("server");
    expect(error.code).toBeNull();
    expect(error.message).toBe("Something went wrong on our side. Try again.");
  });

  it("maps a 409 on stage move to a conflict the UI can act on", async () => {
    const { api, calls } = client([json(409, { code: "Conflict", message: "Revision is stale" })]);
    const error = await api.moveDealStage({
      dealId: "d3a17b5c-2e4f-4a6b-8c9d-000000000001", pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01",
      stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03", expectedRevision: 2,
    }).catch((caught: unknown) => caught) as ApiError;
    expect(calls[0]?.url).toBe("https://api.example.test/v1/crm/deals/d3a17b5c-2e4f-4a6b-8c9d-000000000001/stage");
    expect(headers(calls[0])["Idempotency-Key"]).toBeDefined();
    expect(error.kind).toBe("conflict");
    expect(error.code).toBe("Conflict");
  });

  it("maps a thrown fetch to a network error", async () => {
    const { api } = client([new TypeError("Failed to fetch")]);
    await expect(api.listBookings()).rejects.toMatchObject({ kind: "network", status: null });
  });

  it("rejects a response that does not match the contract", async () => {
    const { api } = client([json(201, { actionId: ACTION, result: { ...bookingRecord, status: "pending" } })]);
    await expect(api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("sends contact writes in the contract shape and returns the dedupe flag", async () => {
    const contact = {
      id: "5e0c1a2b-7d3f-4c8a-9b1e-000000000001", tenantId: TENANT, displayName: "Marguerite Okafor",
      email: "marguerite.okafor@example.com", phone: null, consent: { email: null, sms: null },
      createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    };
    const { api, calls } = client([json(200, { actionId: ACTION, result: { contact, created: false } })]);
    const result = await api.createOrFindContact({ displayName: "M. Okafor", email: "Marguerite.Okafor@example.com", phone: null });
    expect(result.created).toBe(false);
    expect(result.contact.id).toBe(contact.id);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({ mode: "interactive", consent: { email: null, sms: null }, email: "Marguerite.Okafor@example.com" });
    expect(body.contactId).toMatch(/^00000000-0000-4000-8000-/);
  });
});
