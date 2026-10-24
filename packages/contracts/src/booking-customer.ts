import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingSummarySchema } from "./intake.js";

// The booking customer link (docs/requirements/booking-customer.md BC-1..BC-10). Root re-exports this
// module, so shared root schemas are reached lazily, as in business.ts.
const idSchema = z.lazy(() => uuidSchema);
const MAX_REVISION = 2_147_483_647;

/** BC-3: 0 only when the booking has never had a link row; every change adds one (BC-4). */
export const bookingContactRevisionSchema = z.number().int().min(0).max(MAX_REVISION);

/** BC-3: link or change. `expectedRevision` is the booking's `customerRevision` as last read. */
export const linkBookingContactInputSchema = z.strictObject({
  bookingId: idSchema,
  contactId: idSchema,
  expectedRevision: bookingContactRevisionSchema,
});
export type LinkBookingContactInput = z.infer<typeof linkBookingContactInputSchema>;
/** BC-4: clear. A booking with no link row has nothing to clear, so the revision is at least 1. */
export const unlinkBookingContactInputSchema = z.strictObject({
  bookingId: idSchema,
  expectedRevision: z.number().int().min(1).max(MAX_REVISION),
});
export type UnlinkBookingContactInput = z.infer<typeof unlinkBookingContactInputSchema>;

/** The HTTP bodies: the booking is named by the path. */
export const linkBookingContactRequestSchema = linkBookingContactInputSchema.omit({ bookingId: true });
export type LinkBookingContactRequest = z.infer<typeof linkBookingContactRequestSchema>;
export const unlinkBookingContactRequestSchema = unlinkBookingContactInputSchema.omit({ bookingId: true });
export type UnlinkBookingContactRequest = z.infer<typeof unlinkBookingContactRequestSchema>;

export const BOOKING_CONTACT_TARGET = "booking";
export const linkBookingContactCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("booking.contact.link"),
  target: targetSchema.extend({ type: z.literal(BOOKING_CONTACT_TARGET) }),
  payload: linkBookingContactInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking"));
export type LinkBookingContactCommand = z.infer<typeof linkBookingContactCommandSchema>;
export const unlinkBookingContactCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("booking.contact.unlink"),
  target: targetSchema.extend({ type: z.literal(BOOKING_CONTACT_TARGET) }),
  payload: unlinkBookingContactInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking"));
export type UnlinkBookingContactCommand = z.infer<typeof unlinkBookingContactCommandSchema>;

/** BC-6: the customer of an owner-made booking with a link, as lists show it. */
export const bookingCustomerSchema = z.strictObject({
  contactId: idSchema,
  name: z.string().nullable(),
  status: z.literal("linked"),
});
export type BookingCustomer = z.infer<typeof bookingCustomerSchema>;

/** What a link or unlink returns: the booking's customer now, and the revision to send next. */
export const bookingContactResultSchema = z.strictObject({
  bookingId: idSchema,
  customer: bookingCustomerSchema.nullable(),
  revision: z.number().int().min(1).max(MAX_REVISION),
});
export type BookingContactResult = z.infer<typeof bookingContactResultSchema>;
export const bookingContactOutputSchema = z.lazy(() => actionResultSchema.extend({ result: bookingContactResultSchema }));
export type BookingContactOutput = z.infer<typeof bookingContactOutputSchema>;

/**
 * BC-6, BC-9: one booking as the detail read shows it. The list's `customer` carries no revision
 * (older dashboards parse that shape strictly), so the detail adds `customerRevision`: 0 while the
 * booking has never had a link row, then the revision of the latest change, also after an unlink.
 */
export const bookingDetailSchema = bookingSummarySchema.extend({ customerRevision: bookingContactRevisionSchema });
export type BookingDetail = z.infer<typeof bookingDetailSchema>;
