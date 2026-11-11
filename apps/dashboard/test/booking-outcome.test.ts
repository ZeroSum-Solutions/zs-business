// What the owner reads and which appointments show the control (booking.md B-37..B-43).
import { describe, expect, it } from "vitest";
import {
  bookingOutcomeMessage, canMarkOutcome, outcomeLabel, outcomeToast,
} from "../src/components/calendar/booking-outcome";
import { ApiError, demoError, type BookingView } from "../src/lib/api";

const NOW = Date.parse("2026-10-18T13:00:00.000Z");
const view = (patch: Partial<BookingView>): BookingView => ({
  id: "b8c2d4e6-1a3f-4b5c-9d7e-000000000010", resourceId: "r", startsAt: "2026-10-15T14:00:00.000Z", endsAt: "2026-10-15T14:30:00.000Z",
  status: "confirmed", outcome: null, ...patch,
}) as BookingView;

describe("canMarkOutcome", () => {
  it("is true for a confirmed booking that has started, and nothing else (B-39)", () => {
    expect(canMarkOutcome(view({}), NOW)).toBe(true);
    expect(canMarkOutcome(view({ outcome: "no_show" }), NOW)).toBe(true);
    expect(canMarkOutcome(view({ startsAt: new Date(NOW).toISOString() }), NOW)).toBe(true);
    expect(canMarkOutcome(view({ startsAt: "2026-10-19T14:00:00.000Z" }), NOW)).toBe(false);
    expect(canMarkOutcome(view({ status: "cancelled" }), NOW)).toBe(false);
  });
});

describe("outcomeLabel and outcomeToast", () => {
  const at = "Thu, Oct 15 at 10:00 AM";
  it("names both marks", () => {
    expect(outcomeLabel("completed")).toBe("Completed");
    expect(outcomeLabel("no_show")).toBe("No-show");
  });
  it("says what the mark does for review requests, and when nothing changed", () => {
    expect(outcomeToast(at, "completed", true)).toBe(`Marked ${at} completed. A review request can follow.`);
    expect(outcomeToast(at, "no_show", true)).toBe(`Marked ${at} as a no-show. No review request will be sent.`);
    expect(outcomeToast(at, "completed", false)).toBe(`${at} was already marked completed.`);
    expect(outcomeToast(at, "no_show", false)).toBe(`${at} was already marked no-show.`);
  });
});

describe("bookingOutcomeMessage", () => {
  it("explains a booking that has not started, a cancelled one and a missing one, and leaves other errors to the default text", () => {
    expect(bookingOutcomeMessage(demoError("Conflict", { reason: "booking_not_started" }))).toMatch(/not started/);
    expect(bookingOutcomeMessage(demoError("Conflict", { reason: "booking_cancelled" }))).toMatch(/cancelled/);
    expect(bookingOutcomeMessage(demoError("NotFound"))).toMatch(/no longer on file/);
    expect(bookingOutcomeMessage(new ApiError("network", "offline"))).toBeUndefined();
  });
});
