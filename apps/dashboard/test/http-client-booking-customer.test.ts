// The HTTP client reads and writes the booking customer routes with the contract schemas
// (booking-customer.md BC-3..BC-6).
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const BOOKING = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000b1";
const CONTACT = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000c1";

interface Call { url: URL; init: RequestInit }
function client(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "/api",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const KEY = { idempotencyKey: "00000000-0000-4000-8000-000000000001" };

const summary = {
  id: BOOKING, tenantId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000a1", resourceId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000d1",
  startsAt: "2026-10-19T14:00:00.000Z", endsAt: "2026-10-19T14:30:00.000Z",
  occupiedStartsAt: "2026-10-19T14:00:00.000Z", occupiedEndsAt: "2026-10-19T14:30:00.000Z",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, status: "confirmed", createdAt: "2026-10-18T12:00:00.000Z",
  source: "owner", intakeItemId: null,
};
const customer = { contactId: CONTACT, name: "Ana Ruiz", status: "linked" };
const result = (revision: number, linked: boolean) => ({
  bookingId: BOOKING, customer: linked ? customer : null, revision,
});
const action = (value: unknown) => ({ actionId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000f1", result: value });

describe("http client: the booking customer", () => {
  it("reads one booking from GET /v1/booking/bookings/:id with its revision", async () => {
    const { api, calls } = client([json(200, { ...summary, customer, customerRevision: 1 }), json(200, { ...summary, customer: null })]);
    expect(await api.getBooking(BOOKING)).toMatchObject({ customer, customerRevision: 1 });
    expect(calls[0]!.url.pathname).toBe(`/api/v1/booking/bookings/${BOOKING}`);
    expect(calls[0]!.init.method).toBe("GET");
    // A detail without its revision is not in contract shape.
    await expect(api.getBooking(BOOKING)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("links with POST .../contact/link, the revision in the body and the key in the header", async () => {
    const { api, calls } = client([json(200, action(result(1, true)))]);
    expect(await api.linkBookingContact({ bookingId: BOOKING, contactId: CONTACT, expectedRevision: 0 }, KEY)).toEqual(result(1, true));
    expect(calls[0]!.url.pathname).toBe(`/api/v1/booking/bookings/${BOOKING}/contact/link`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(body(calls[0])).toEqual({ contactId: CONTACT, expectedRevision: 0 });
    expect(headers(calls[0])["Idempotency-Key"]).toBe(KEY.idempotencyKey);
  });

  it("unlinks with POST .../contact/unlink", async () => {
    const { api, calls } = client([json(200, action(result(2, false)))]);
    expect(await api.unlinkBookingContact({ bookingId: BOOKING, expectedRevision: 1 }, KEY)).toEqual(result(2, false));
    expect(calls[0]!.url.pathname).toBe(`/api/v1/booking/bookings/${BOOKING}/contact/unlink`);
    expect(body(calls[0])).toEqual({ expectedRevision: 1 });
  });

  it("sends contactId on the bookings list, and shows a stale revision with the current one", async () => {
    const { api, calls } = client([
      json(200, { items: [], limit: 100, offset: 0, nextOffset: null, nextCursor: null }),
      json(409, { error: { code: "Conflict", message: "x", details: { reason: "stale_revision", currentRevision: 4 } } }),
    ]);
    await api.listBookings({ contactId: CONTACT });
    expect(calls[0]!.url.searchParams.get("contactId")).toBe(CONTACT);
    const stale = await api.linkBookingContact({ bookingId: BOOKING, contactId: CONTACT, expectedRevision: 0 }, KEY).catch((error: unknown) => error);
    expect(stale).toMatchObject({ kind: "conflict", details: { reason: "stale_revision", currentRevision: 4 } });
  });
});
