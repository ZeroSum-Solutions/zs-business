// The HTTP client cancels with POST .../cancel, the key in the header and only the fields it was given
// (booking.md B-29), and passes the status filter to the bookings list.
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const BOOKING = "3c1e5a7b-9d2f-4e6a-8b1c-0000000000b1";
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
const KEY = { idempotencyKey: "00000000-0000-4000-8000-000000000001" };
const record = {
  id: BOOKING, tenantId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000a1", resourceId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000d1",
  startsAt: "2026-10-19T14:00:00.000Z", endsAt: "2026-10-19T14:30:00.000Z",
  occupiedStartsAt: "2026-10-19T14:00:00.000Z", occupiedEndsAt: "2026-10-19T14:30:00.000Z",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, status: "cancelled", createdAt: "2026-10-18T12:00:00.000Z",
};
const answer = { actionId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000f1", result: {
  booking: record, cancelledAt: "2026-10-18T13:00:00.000Z", reason: "Owner away", customerNotice: "queued",
} };

describe("http client: cancel a booking", () => {
  it("posts to .../cancel with the reason and notify flag", async () => {
    const { api, calls } = client([json(200, answer)]);
    const result = await api.cancelBooking({ bookingId: BOOKING, reason: "Owner away", notifyCustomer: false }, KEY);
    expect(result).toMatchObject({ customerNotice: "queued", booking: { status: "cancelled" } });
    expect(calls[0]!.url.pathname).toBe(`/api/v1/booking/bookings/${BOOKING}/cancel`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: "Owner away", notifyCustomer: false });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY.idempotencyKey);
  });

  it("sends an empty body when nothing else was given, and surfaces booking_over as a conflict", async () => {
    const { api, calls } = client([
      json(409, { error: { code: "Conflict", message: "The booking is already over", details: { reason: "booking_over" } } }),
    ]);
    await expect(api.cancelBooking({ bookingId: BOOKING }, KEY)).rejects.toMatchObject({ kind: "conflict", reason: "booking_over" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
  });

  it("sends the status filter on the bookings list", async () => {
    const { api, calls } = client([json(200, { items: [], limit: 100, offset: 0, nextOffset: null, nextCursor: null })]);
    await api.listBookings({ status: "cancelled", limit: 10 });
    expect(calls[0]!.url.searchParams.get("status")).toBe("cancelled");
  });
});
