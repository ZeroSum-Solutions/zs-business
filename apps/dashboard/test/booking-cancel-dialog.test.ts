// What the owner reads around a cancel (booking.md B-30, B-33).
import { describe, expect, it } from "vitest";
import { cancelBookingMessage, cancelledToast } from "../src/components/calendar/booking-cancel-dialog";
import { ApiError, demoError } from "../src/lib/api";

describe("cancelledToast", () => {
  const at = "Mon, Oct 26 at 10:00 AM";
  it("says whether the customer was told", () => {
    expect(cancelledToast(at, "Ana Ruiz", "queued")).toBe(`Cancelled ${at}. Ana Ruiz will get an email.`);
    expect(cancelledToast(at, "Ana Ruiz", "off")).toBe(`Cancelled ${at}. No email was sent.`);
    expect(cancelledToast(at, null, "no_email")).toBe(`Cancelled ${at}. The customer has no email on file, so nothing was sent.`);
    expect(cancelledToast(at, null, "no_customer")).toBe(`Cancelled ${at}.`);
    expect(cancelledToast(at, null, "already_cancelled")).toBe(`${at} was already cancelled.`);
  });
});

describe("cancelBookingMessage", () => {
  it("explains an ended booking and a missing one, and leaves other errors to the default text", () => {
    expect(cancelBookingMessage(demoError("Conflict", { reason: "booking_over" }))).toMatch(/already over/);
    expect(cancelBookingMessage(demoError("NotFound"))).toMatch(/no longer on file/);
    expect(cancelBookingMessage(new ApiError("network", "offline"))).toBeUndefined();
  });
});
