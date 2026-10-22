// booking.md B-3: client-supplied booking instants are UTC years 0001 through 9999. Year 0000
// fits the ISO pattern but Postgres has no year zero, so every booking boundary refuses it.
import { describe, expect, it } from "vitest";
import {
  bookingInstantSchema,
  createBookingInputSchema,
  createBookingRequestSchema,
  getAvailableSlotsInputSchema,
  listBookingsQuerySchema,
  publicBookingRequestBodySchema,
  slotsQuerySchema,
} from "../src/index.js";

const ID = "22222222-2222-4222-8222-222222222222";
const FIRST = "0001-01-01T00:00:00.000Z";
const LAST = "9999-12-31T23:59:59.999Z";
const YEAR_ZERO = "0000-12-31T23:00:00.000Z";
const resource = {
  tenantId: ID, id: ID, timeZone: "UTC", weekly: [], overrides: [], slotLengthMinutes: 30, slotStepMinutes: 30,
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, bookingHorizonMinutes: 0,
};

describe("booking instants (B-3)", () => {
  it("accepts the first and last supported instants and refuses year 0000", () => {
    expect(bookingInstantSchema.safeParse(FIRST).success).toBe(true);
    expect(bookingInstantSchema.safeParse(LAST).success).toBe(true);
    expect(bookingInstantSchema.safeParse(YEAR_ZERO).success).toBe(false);
    expect(bookingInstantSchema.safeParse("0000-01-01T00:00:00.000Z").success).toBe(false);
  });

  it.each([
    ["availability range", getAvailableSlotsInputSchema, { resource, range: { startsAt: YEAR_ZERO, endsAt: FIRST }, busy: [] }],
    ["availability busy entry", getAvailableSlotsInputSchema, { resource, range: { startsAt: FIRST, endsAt: "0001-01-02T00:00:00.000Z" },
      busy: [{ kind: "external", tenantId: ID, resourceId: ID, startsAt: YEAR_ZERO, endsAt: FIRST }] }],
    ["create input", createBookingInputSchema, { bookingId: ID, resourceId: ID, startsAt: YEAR_ZERO }],
    ["create request", createBookingRequestSchema, { resourceId: ID, startsAt: YEAR_ZERO }],
    ["slot search", slotsQuerySchema, { resourceId: ID, from: YEAR_ZERO, to: FIRST }],
    ["list filter from", listBookingsQuerySchema, { from: YEAR_ZERO }],
    ["list filter to", listBookingsQuerySchema, { to: YEAR_ZERO }],
  ])("the %s refuses year 0000", (_name, schema, value) => {
    expect((schema as { safeParse(input: unknown): { success: boolean } }).safeParse(value).success).toBe(false);
  });

  it("the edges of the range still parse at each boundary", () => {
    expect(slotsQuerySchema.safeParse({ resourceId: ID, from: "9999-12-31T00:00:00.000Z", to: LAST }).success).toBe(true);
    expect(listBookingsQuerySchema.safeParse({ from: FIRST, to: LAST }).success).toBe(true);
    expect(createBookingRequestSchema.safeParse({ resourceId: ID, startsAt: FIRST }).success).toBe(true);
    expect(createBookingInputSchema.safeParse({ bookingId: ID, resourceId: ID, startsAt: LAST }).success).toBe(true);
    expect(getAvailableSlotsInputSchema.safeParse({ resource, range: { startsAt: FIRST, endsAt: "0001-01-02T00:00:00.000Z" }, busy: [] }).success).toBe(true);
  });

  it("the public booking request refuses year 0000", () => {
    const shape = publicBookingRequestBodySchema.shape;
    expect(shape.startsAt.safeParse(YEAR_ZERO).success).toBe(false);
    expect(shape.startsAt.safeParse(FIRST).success).toBe(true);
  });
});
