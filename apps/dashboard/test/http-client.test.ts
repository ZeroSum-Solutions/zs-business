import { describe, expect, it } from "vitest";
import { ApiError, isDealChanged, isSlotTaken, isStaleRevision } from "../src/lib/api/errors";
import { createHttpClient, MAX_PAGES } from "../src/lib/api/http-client";

const TENANT = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const RESOURCE = "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61";
const BOOKING = "b8c2d4e6-1a3f-4b5c-9d7e-000000000099";
const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";

interface Call { url: string; init: RequestInit }

function client(responses: (Response | Error)[], token: string | null = "dev-token") {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "https://api.example.test/",
    getToken: () => token,
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

let keys = 0;
/** A caller-owned key, as `useIntentKey` hands out. */
const key = () => ({ idempotencyKey: `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}` });

const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;

describe("http client", () => {
  it("sends bearer auth and the caller's Idempotency-Key on writes", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: bookingRecord })]);
    const record = await api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt }, key());
    expect(record.id).toBe(BOOKING);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/booking/bookings");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headers(calls[0]).Authorization).toBe("Bearer dev-token");
    expect(headers(calls[0])["Idempotency-Key"]).toMatch(/^00000000-0000-4000-8000-/);
    // createBookingRequestSchema is strict: the server derives the booking ID from the key.
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt });
  });

  it("refuses a write without a caller-owned Idempotency-Key instead of making one up", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: bookingRecord })]);
    const input = { resourceId: RESOURCE, startsAt: bookingRecord.startsAt };
    // @ts-expect-error: the key is required; this is the call a forgetful caller would make.
    await expect(api.createBooking(input)).rejects.toBeInstanceOf(TypeError);
    await expect(api.createBooking(input, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("keeps every request out of the HTTP cache", async () => {
    const { api, calls } = client([
      json(200, { items: [] }),
      json(201, { actionId: ACTION, result: bookingRecord }),
    ]);
    await api.listResources();
    await api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt }, key());
    expect(calls.map((call) => call.init.cache)).toEqual(["no-store", "no-store"]);
  });

  it("reuses a caller-supplied Idempotency-Key so retries are safe", async () => {
    const { api, calls } = client([
      json(201, { actionId: ACTION, result: bookingRecord }),
      json(201, { actionId: ACTION, result: bookingRecord }),
    ]);
    const input = { resourceId: RESOURCE, startsAt: bookingRecord.startsAt };
    await api.createBooking(input, { idempotencyKey: "retry-key-1" });
    await api.createBooking(input, { idempotencyKey: "retry-key-1" });
    expect(headers(calls[0])["Idempotency-Key"]).toBe("retry-key-1");
    expect(headers(calls[1])["Idempotency-Key"]).toBe("retry-key-1");
  });

  it("does not send an Idempotency-Key or body on reads, and builds the slot query", async () => {
    const { api, calls } = client([json(200, { resourceId: RESOURCE, timeZone: "America/New_York", zone: "America/New_York", slots: [] })], null);
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
    [429, "rate_limited"],
    [500, "server"],
  ] as const)("maps HTTP %i to ApiError kind %s from the shared error body", async (status, kind) => {
    const { api } = client([json(status, { error: { code: "Conflict", message: "Server says no", details: { a: 1 } } })]);
    const error = await api.listContacts().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe(kind);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).code).toBe("Conflict");
    expect((error as ApiError).details).toEqual({ a: 1 });
    // Server messages are for developers; the shown message is plain copy.
    expect((error as ApiError).message).not.toBe("Server says no");
  });

  it("ignores a body that is not apiErrorBodySchema but keeps the status", async () => {
    const { api } = client([json(409, { code: "Conflict", message: "flat body" })]);
    const error = await api.listContacts().catch((caught: unknown) => caught) as ApiError;
    expect(error).toMatchObject({ kind: "conflict", code: null, reason: null });
  });

  it.each(["overlap", "slot_unavailable"])("treats a booking 409 with reason %s as a taken slot", async (reason) => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "Requested slot is unavailable", details: { reason } } })]);
    const error = await api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt }, key()).catch((caught: unknown) => caught);
    expect(isSlotTaken(error)).toBe(true);
    expect(isStaleRevision(error)).toBe(false);
    expect((error as ApiError).message).toBe("That time was just taken.");
  });

  it("does not treat a reused idempotency key as a taken slot", async () => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "x", details: { reason: "idempotency_key_reused" } } })]);
    const error = await api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt }, key()).catch((caught: unknown) => caught);
    expect(isSlotTaken(error)).toBe(false);
    expect((error as ApiError).reason).toBe("idempotency_key_reused");
  });

  it("points a 400 at the first field in details.issues", async () => {
    const { api } = client([json(400, { error: { code: "ValidationFailed", message: "Invalid request", details: { issues: [{ path: "phone", message: "Expected E.164 phone" }] } } })]);
    const error = await api.createOrFindContact({ displayName: null, email: null, phone: "12" }, key()).catch((caught: unknown) => caught) as ApiError;
    expect(error).toMatchObject({ kind: "validation", field: "phone", code: "ValidationFailed" });
    expect(error.message).toBe("Enter a phone number with country code, like +1 212 555 0142.");
  });

  it("uses a plain default message when the error body is not JSON", async () => {
    const { api } = client([new Response("<html>bad gateway</html>", { status: 502 })]);
    const error = await api.listDeals().catch((caught: unknown) => caught) as ApiError;
    expect(error.kind).toBe("server");
    expect(error.code).toBeNull();
    expect(error.message).toBe("Something went wrong on our side. Try again.");
  });

  it("maps a stale_revision 409 on stage move to a conflict the UI can act on", async () => {
    const { api, calls } = client([json(409, { error: { code: "Conflict", message: "The deal revision changed", details: { reason: "stale_revision", currentRevision: 3 } } })]);
    const error = await api.moveDealStage({
      dealId: "d3a17b5c-2e4f-4a6b-8c9d-000000000001", pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01",
      stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03", expectedRevision: 2,
    }, key()).catch((caught: unknown) => caught) as ApiError;
    expect(calls[0]?.url).toBe("https://api.example.test/v1/crm/deals/d3a17b5c-2e4f-4a6b-8c9d-000000000001/stage");
    expect(headers(calls[0])["Idempotency-Key"]).toBeDefined();
    // moveDealStageRequestSchema is strict: the deal ID travels in the path only.
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01", stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03", expectedRevision: 2,
    });
    expect(error.kind).toBe("conflict");
    expect(error.code).toBe("Conflict");
    expect(isStaleRevision(error)).toBe(true);
    expect(isDealChanged(error)).toBe(true);
    expect(error.details.currentRevision).toBe(3);
  });

  it("treats a concurrent_update 409 like a stale revision: reload, then retry", async () => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "x", details: { reason: "concurrent_update" } } })]);
    const error = await api.moveDealStage({
      dealId: "d3a17b5c-2e4f-4a6b-8c9d-000000000001", pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01",
      stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03", expectedRevision: 2,
    }, key()).catch((caught: unknown) => caught);
    expect(isDealChanged(error)).toBe(true);
    expect(isSlotTaken(error)).toBe(false);
  });

  it("maps 429 to its own kind with a wait message", async () => {
    const { api } = client([json(429, { error: { code: "Internal", message: "slow down", details: {} } })]);
    const error = await api.listResources().catch((caught: unknown) => caught) as ApiError;
    expect(error.kind).toBe("rate_limited");
    expect(error.message).toBe("Too many requests. Wait a minute, then try again.");
  });

  it("maps a thrown fetch to a network error", async () => {
    const { api } = client([new TypeError("Failed to fetch")]);
    await expect(api.listResources()).rejects.toMatchObject({ kind: "network", status: null });
  });

  it("rejects a response that does not match the contract", async () => {
    const { api } = client([json(201, { actionId: ACTION, result: { ...bookingRecord, status: "pending" } })]);
    await expect(api.createBooking({ resourceId: RESOURCE, startsAt: bookingRecord.startsAt }, key())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("sends contact writes in the contract shape and returns the dedupe flag", async () => {
    const contact = {
      id: "5e0c1a2b-7d3f-4c8a-9b1e-000000000001", tenantId: TENANT, displayName: "Marguerite Okafor",
      email: "marguerite.okafor@example.com", phone: null, consent: { email: null, sms: null },
      createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    };
    const { api, calls } = client([json(200, { actionId: ACTION, result: { contact, created: false } })]);
    const result = await api.createOrFindContact({ displayName: "M. Okafor", email: "Marguerite.Okafor@example.com", phone: null }, key());
    expect(result.created).toBe(false);
    expect(result.contact.id).toBe(contact.id);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      displayName: "M. Okafor", email: "Marguerite.Okafor@example.com", phone: null,
      mode: "interactive", consent: { email: null, sms: null },
    });
  });

  it("sends phones as E.164", async () => {
    const contact = {
      id: "5e0c1a2b-7d3f-4c8a-9b1e-000000000002", tenantId: TENANT, displayName: null, email: null, phone: "+16465550177",
      consent: { email: null, sms: null }, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    };
    const { api, calls } = client([json(201, { actionId: ACTION, result: { contact, created: true } })]);
    await api.createOrFindContact({ displayName: null, email: null, phone: "+1 (646) 555-0177" }, key());
    expect(JSON.parse(String(calls[0]?.init.body)).phone).toBe("+16465550177");
  });

  it("sends the search to the API and reads one page of customers in name order", async () => {
    const contact = (n: number, name: string) => ({
      id: `5e0c1a2b-7d3f-4c8a-9b1e-${String(n).padStart(12, "0")}`, tenantId: TENANT, displayName: name,
      email: `${name.toLowerCase()}@example.com`, phone: null, consent: { email: null, sms: null },
      createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    });
    const { api, calls } = client([
      json(200, { items: [contact(2, "Ash"), contact(3, "Ashby")], limit: 50, offset: 0, nextOffset: null, nextCursor: "next-page" }),
    ]);
    const found = await api.listContacts({ search: "  ash " });
    expect(found).toEqual({ items: [contact(2, "Ash"), contact(3, "Ashby")], nextCursor: "next-page" });
    expect(calls.map((call) => new URL(call.url).search)).toEqual(["?sort=name&search=ash&limit=50"]);
  });

  it(`walks a filtered list by nextCursor, and marks it incomplete past ${MAX_PAGES} pages`, async () => {
    const page = (offset: number) => json(200, {
      items: [{
        id: `d0a1b2c3-7d3f-4c8a-9b1e-${String(offset + 1).padStart(12, "0")}`, tenantId: TENANT,
        contactId: "5e0c1a2b-7d3f-4c8a-9b1e-000000000001", pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01",
        stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e02", title: `Deal ${offset}`, revision: 1,
        createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
        value: null, leadSource: null, wonAt: null,
      }],
      limit: 100, offset: 0, nextOffset: null, nextCursor: `after-${offset + 100}`,
    });
    const { api, calls } = client(Array.from({ length: MAX_PAGES + 5 }, (_, index) => page(index * 100)));
    const list = await api.listDeals({ pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01" });
    expect(calls).toHaveLength(MAX_PAGES);
    expect(list).toMatchObject({ incomplete: true, loaded: MAX_PAGES });
    expect(new URL(calls[0]!.url).search).toBe("?pipelineId=2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01&limit=100");
    expect(new URL(calls[1]!.url).search).toBe("?pipelineId=2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01&limit=100&cursor=after-100");
  });

  it("reads one customer by ID, and says not found without asking for a malformed ID", async () => {
    const { api, calls } = client([json(404, { error: { code: "NotFound", message: "Not found", details: {} } })]);
    await expect(api.getContact("5e0c1a2b-7d3f-4c8a-9b1e-999999999999")).rejects.toMatchObject({
      kind: "not_found", code: "NotFound", message: "We could not find that customer.",
    });
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/crm/contacts/5e0c1a2b-7d3f-4c8a-9b1e-999999999999");
    await expect(api.getContact("not-a-customer")).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(1);
  });

  it("passes the caller's signal to fetch, and lets a cancelled read reject as a cancellation", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const api = createHttpClient({
      baseUrl: "https://api.example.test",
      fetch: (_input, init) => {
        seen = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      },
    });
    const read = api.listContacts({ search: "ash" }, { signal: controller.signal });
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBe(controller.signal);
  });

  it("reads resources and pipelines from the API, stages in position order", async () => {
    const { api, calls } = client([
      json(200, { items: [{ id: RESOURCE, name: "Showroom appointments", timeZone: "America/New_York", slotLengthMinutes: 60 }] }),
      json(200, { items: [{
        id: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01", name: "Commissions",
        stages: [
          { id: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e03", name: "Consultation", position: 2, outcome: "open" },
          { id: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e02", name: "Inquiry", position: 1, outcome: "open" },
        ],
      }] }),
    ]);
    expect(await api.listResources()).toEqual([{ id: RESOURCE, name: "Showroom appointments", timeZone: "America/New_York", slotLengthMinutes: 60 }]);
    const [pipeline] = await api.listPipelines();
    expect(pipeline?.stages.map((stage) => stage.name)).toEqual(["Inquiry", "Consultation"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/booking/resources", "/v1/crm/pipelines"]);
  });
});

describe("http client through the dashboard proxy", () => {
  it("calls the same-origin path and sends no Authorization header", async () => {
    const calls: Call[] = [];
    const api = createHttpClient({
      baseUrl: "/api",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init: init ?? {} });
        return json(200, { resourceId: RESOURCE, timeZone: "America/New_York", zone: "America/New_York", slots: [] });
      },
    });
    await api.getSlots({ resourceId: RESOURCE, from: "2026-10-20T04:00:00.000Z", to: "2026-10-21T04:00:00.000Z" });
    expect(calls[0]!.url).toBe(`/api/v1/booking/slots?resourceId=${RESOURCE}&from=2026-10-20T04%3A00%3A00.000Z&to=2026-10-21T04%3A00%3A00.000Z`);
    expect(Object.keys(headers(calls[0])).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("lists intake items by status and sends reviews to the item's route", async () => {
    const item = {
      id: "1f4e6a8c-3b5d-4e7f-8a9b-000000000001", tenantId: TENANT, kind: "booking_request", status: "possible_match",
      channel: "widget", pageId: "7c9e1b3d-5f7a-4b9c-8d1e-2f3a4b5c6d01",
      submitted: { name: "M. Okafor", email: "m@example.com", phone: null, notes: null },
      matchedContactIds: ["5e0c1a2b-7d3f-4c8a-9b1e-000000000001"], contactId: null, consent: { email: null, sms: null },
      booking: null, reviewedAt: null, createdAt: "2026-10-18T12:00:00.000Z",
    };
    const linked = { ...item, status: "linked", contactId: item.matchedContactIds[0], reviewedAt: "2026-10-18T13:00:00.000Z" };
    const envelope = { actionId: ACTION, result: linked };
    const { api, calls } = client([
      json(200, { items: [item], limit: 100, offset: 0, nextOffset: null, nextCursor: null }),
      json(200, envelope),
      json(200, { ...envelope, result: { ...linked, status: "rejected", contactId: null } }),
    ]);
    expect((await api.listIntakeItems({ status: "possible_match" })).items).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/intake/items?status=possible_match&limit=100");
    await api.linkIntakeItem({ itemId: item.id, contactId: item.matchedContactIds[0]! }, key());
    expect(calls[1]!.url).toBe(`https://api.example.test/v1/intake/items/${item.id}/link`);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ contactId: item.matchedContactIds[0] });
    await api.rejectIntakeItem(item.id, key());
    expect(calls[2]!.url).toBe(`https://api.example.test/v1/intake/items/${item.id}/reject`);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({});
  });
});
