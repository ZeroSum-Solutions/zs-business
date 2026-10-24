import { describe, expect, it } from "vitest";
import {
  bookingContactOutputSchema,
  bookingContactResultSchema,
  bookingDetailSchema,
  bookingSummarySchema,
  createBookingCommandSchema,
  linkBookingContactCommandSchema,
  linkBookingContactRequestSchema,
  listBookingsQuerySchema,
  unlinkBookingContactCommandSchema,
  unlinkBookingContactRequestSchema,
} from "../src/index.js";

// booking-customer.md BC-3, BC-4, BC-6, BC-9 as contracts.

const tenantId = "11111111-1111-4111-8111-111111111111";
const bookingId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const base = { approvalReference: { tenantId, id: "55555555-5555-4555-8555-555555555555" }, idempotencyKey: "k1" };
const command = (actionType: string, payload: unknown, id = bookingId) => ({
  ...base, actionType, target: { tenantId, type: "booking", id }, payload,
});

describe("booking.contact.link (BC-3)", () => {
  it("takes the booking, the contact and the revision read, and names the booking as the target", () => {
    const ok = linkBookingContactCommandSchema.safeParse(command("booking.contact.link", { bookingId, contactId, expectedRevision: 0 }));
    expect(ok.success).toBe(true);
    expect(linkBookingContactCommandSchema.safeParse(command("booking.contact.link", { bookingId, contactId, expectedRevision: 4 }, contactId)).success).toBe(false);
  });

  it("refuses a negative, fractional or too large revision, extra keys and a missing contact", () => {
    for (const expectedRevision of [-1, 1.5, 2_147_483_648, "0", null]) {
      expect(linkBookingContactRequestSchema.safeParse({ contactId, expectedRevision }).success, String(expectedRevision)).toBe(false);
    }
    expect(linkBookingContactRequestSchema.safeParse({ contactId, expectedRevision: 0, bookingId }).success).toBe(false);
    expect(linkBookingContactRequestSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(linkBookingContactRequestSchema.safeParse({ contactId: "nope", expectedRevision: 0 }).success).toBe(false);
  });

  it("is not the booking.create payload: that stays {bookingId, resourceId, startsAt} (B-17)", () => {
    const withCustomer = createBookingCommandSchema.safeParse({
      ...base, actionType: "booking.create", target: { tenantId, type: "booking", id: bookingId },
      payload: { bookingId, resourceId: contactId, startsAt: "2026-11-02T10:00:00.000Z", contactId },
    });
    expect(withCustomer.success).toBe(false);
  });
});

describe("booking.contact.unlink (BC-4)", () => {
  it("needs a revision of at least 1: a booking with no row has nothing to clear", () => {
    expect(unlinkBookingContactCommandSchema.safeParse(command("booking.contact.unlink", { bookingId, expectedRevision: 1 })).success).toBe(true);
    expect(unlinkBookingContactRequestSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(unlinkBookingContactRequestSchema.safeParse({ expectedRevision: 2, contactId }).success).toBe(false);
  });

  it("wrong action types and targets do not parse", () => {
    expect(unlinkBookingContactCommandSchema.safeParse(command("booking.contact.link", { bookingId, expectedRevision: 1 })).success).toBe(false);
    expect(unlinkBookingContactCommandSchema.safeParse({ ...command("booking.contact.unlink", { bookingId, expectedRevision: 1 }), target: { tenantId, type: "deal", id: bookingId } }).success).toBe(false);
  });
});

describe("the result and the reads (BC-6, BC-9)", () => {
  it("returns the customer as linked, or null after an unlink, with the next revision", () => {
    expect(bookingContactResultSchema.parse({ bookingId, customer: { contactId, name: "Ana Ruiz", status: "linked" }, revision: 1 }).revision).toBe(1);
    expect(bookingContactResultSchema.parse({ bookingId, customer: null, revision: 2 }).customer).toBeNull();
    expect(bookingContactResultSchema.safeParse({ bookingId, customer: { contactId, name: "Ana", status: "new_contact" }, revision: 1 }).success).toBe(false);
    expect(bookingContactResultSchema.safeParse({ bookingId, customer: null, revision: 0 }).success).toBe(false);
    expect(bookingContactOutputSchema.safeParse({ result: { bookingId, customer: null, revision: 2 } }).success).toBe(false);
  });

  const summary = {
    id: bookingId, tenantId, resourceId: contactId, startsAt: "2026-11-02T10:00:00.000Z", endsAt: "2026-11-02T10:30:00.000Z",
    occupiedStartsAt: "2026-11-02T10:00:00.000Z", occupiedEndsAt: "2026-11-02T10:30:00.000Z",
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0, status: "confirmed", createdAt: "2026-10-23T09:00:00.000Z",
    source: "owner", intakeItemId: null, customer: { contactId, name: "Ana Ruiz", status: "linked" },
  };
  it("keeps the list shape and adds only customerRevision to the detail", () => {
    expect(bookingSummarySchema.safeParse(summary).success).toBe(true);
    expect(bookingSummarySchema.safeParse({ ...summary, customerRevision: 1 }).success).toBe(false);
    expect(bookingDetailSchema.safeParse({ ...summary, customerRevision: 1 }).success).toBe(true);
    expect(bookingDetailSchema.safeParse({ ...summary, customerRevision: 0, customer: null }).success).toBe(true);
    expect(bookingDetailSchema.safeParse(summary).success).toBe(false);
    expect(bookingDetailSchema.safeParse({ ...summary, customerRevision: 1, extra: true }).success).toBe(false);
  });

  it("lists a contact's bookings with a contactId filter", () => {
    expect(listBookingsQuerySchema.parse({ contactId }).contactId).toBe(contactId);
    expect(listBookingsQuerySchema.safeParse({ contactId: "nope" }).success).toBe(false);
  });
});
