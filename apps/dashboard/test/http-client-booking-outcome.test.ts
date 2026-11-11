// The HTTP client marks an outcome with POST .../outcome, the key in the header and only the mark in the body
// (booking.md B-37..B-39), and passes the API's refusal reasons through.
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
  startsAt: "2026-10-15T14:00:00.000Z", endsAt: "2026-10-15T14:30:00.000Z",
  occupiedStartsAt: "2026-10-15T14:00:00.000Z", occupiedEndsAt: "2026-10-15T14:30:00.000Z",
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, status: "confirmed", createdAt: "2026-10-01T12:00:00.000Z",
};
const answer = { actionId: "3c1e5a7b-9d2f-4e6a-8b1c-0000000000f1", result: {
  booking: record, outcome: "completed", outcomeAt: "2026-10-18T13:00:00.000Z", changed: true,
} };
const conflict = (reason: string) => json(409, { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason } } });

describe("http client: mark a booking's outcome", () => {
  it("posts to .../outcome with only the outcome in the body", async () => {
    const { api, calls } = client([json(200, answer)]);
    const result = await api.setBookingOutcome({ bookingId: BOOKING, outcome: "completed" }, KEY);
    expect(result).toMatchObject({ outcome: "completed", changed: true, booking: { id: BOOKING } });
    expect(calls[0]!.url.pathname).toBe(`/api/v1/booking/bookings/${BOOKING}/outcome`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ outcome: "completed" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY.idempotencyKey);
  });

  it("surfaces booking_not_started and booking_cancelled as conflicts with their reasons", async () => {
    const { api } = client([conflict("booking_not_started"), conflict("booking_cancelled")]);
    await expect(api.setBookingOutcome({ bookingId: BOOKING, outcome: "no_show" }, KEY)).rejects.toMatchObject({ kind: "conflict", reason: "booking_not_started" });
    await expect(api.setBookingOutcome({ bookingId: BOOKING, outcome: "no_show" }, KEY)).rejects.toMatchObject({ kind: "conflict", reason: "booking_cancelled" });
  });

  it("surfaces an unknown booking as not_found", async () => {
    const { api } = client([json(404, { error: { code: "NotFound", message: "Not found", details: {} } })]);
    await expect(api.setBookingOutcome({ bookingId: BOOKING, outcome: "completed" }, KEY)).rejects.toMatchObject({ kind: "not_found" });
  });
});
