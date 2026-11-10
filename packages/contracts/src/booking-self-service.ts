import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingInstantSchema, bookingRecordSchema, bookingTimeZoneSchema } from "./booking.js";

// The customer's own booking link (docs/requirements/booking-self-service.md BS-1..BS-13). Root
// re-exports this module, so shared root schemas are reached lazily, as in booking-customer.ts.
const idSchema = z.lazy(() => uuidSchema);

export const SELF_CANCEL_ACTION = "booking.self_cancel";
export const SELF_RESCHEDULE_ACTION = "booking.self_reschedule";
export const CONFIRMATION_SEND_ACTION = "booking.confirmation_send";
/** BS-6, BS-8: the one reason text each path stores; the owner reads it, the customer never types it. */
export const SELF_CANCEL_REASON = "Cancelled by the customer";
export const SELF_RESCHEDULE_REASON = "Rescheduled by the customer";

/** BS-6: the bound payload. */
export const selfCancelInputSchema = z.strictObject({ bookingId: idSchema });
export type SelfCancelInput = z.infer<typeof selfCancelInputSchema>;
export const selfCancelCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SELF_CANCEL_ACTION),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: selfCancelInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking"));
export type SelfCancelCommand = z.infer<typeof selfCancelCommandSchema>;
export const selfCancelResultSchema = z.strictObject({
  booking: bookingRecordSchema,
  /** False when the booking was already cancelled: nothing changed. */
  changed: z.boolean(),
}).refine((value) => value.booking.status === "cancelled", "A cancellation result holds a cancelled booking");
export type SelfCancelResult = z.infer<typeof selfCancelResultSchema>;

/** BS-8: the old booking is the target; the new booking's ID is server-minted from the stored key. */
export const selfRescheduleInputSchema = z.strictObject({
  bookingId: idSchema,
  newBookingId: idSchema,
  startsAt: bookingInstantSchema,
});
export type SelfRescheduleInput = z.infer<typeof selfRescheduleInputSchema>;
export const selfRescheduleCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SELF_RESCHEDULE_ACTION),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: selfRescheduleInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking")
  .refine((command) => command.payload.bookingId !== command.payload.newBookingId, "The new booking needs its own ID"));
export type SelfRescheduleCommand = z.infer<typeof selfRescheduleCommandSchema>;
export const selfRescheduleResultSchema = z.strictObject({
  previousBookingId: idSchema,
  booking: bookingRecordSchema,
}).refine((value) => value.booking.status === "confirmed", "A reschedule result holds a confirmed booking");
export type SelfRescheduleResult = z.infer<typeof selfRescheduleResultSchema>;

/** BS-3: which words the email uses. */
export const confirmationKindSchema = z.enum(["booked", "rescheduled"]);
export type ConfirmationKind = z.infer<typeof confirmationKindSchema>;
export const confirmationInputSchema = z.strictObject({ bookingId: idSchema, kind: confirmationKindSchema });
export type ConfirmationInput = z.infer<typeof confirmationInputSchema>;
export const confirmationCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CONFIRMATION_SEND_ACTION),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: confirmationInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking"));
export type ConfirmationCommand = z.infer<typeof confirmationCommandSchema>;
/** `queued`: handed to delivery. The others: nobody to write to, or the booking is not live. */
export const confirmationNoticeSchema = z.enum(["queued", "no_customer", "no_email", "not_confirmed"]);
export type ConfirmationNotice = z.infer<typeof confirmationNoticeSchema>;
export const confirmationResultSchema = z.strictObject({ notice: confirmationNoticeSchema });
export type ConfirmationResult = z.infer<typeof confirmationResultSchema>;

/** BS-1: a manage token as it appears in a path. */
export const manageTokenSchema = z.string().regex(/^zsm1_[A-Za-z0-9_-]{70}$/);

/** BS-4: what the link's holder may see. No contact, no notes, no internal IDs. */
export const manageViewSchema = z.strictObject({
  state: z.enum(["confirmed", "cancelled", "moved", "started"]),
  businessName: z.string(),
  serviceName: z.string().nullable(),
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
  timeZone: bookingTimeZoneSchema,
  slotLengthMinutes: z.number().int().positive(),
  canChange: z.boolean(),
  movedTo: z.strictObject({ startsAt: bookingInstantSchema, endsAt: bookingInstantSchema, token: manageTokenSchema }).nullable(),
});
export type ManageView = z.infer<typeof manageViewSchema>;

/** BS-5: the slots query without a resource; the booking names it. */
export const manageSlotsQuerySchema = z.strictObject({
  from: bookingInstantSchema,
  to: bookingInstantSchema,
  zone: bookingTimeZoneSchema.optional(),
}).refine((value) => value.from < value.to, "Range must have positive length")
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 31 * 86400000, "Query range must be at most 31 elapsed days");
export type ManageSlotsQuery = z.infer<typeof manageSlotsQuerySchema>;

export const manageCancelBodySchema = z.strictObject({});
export const manageRescheduleBodySchema = z.strictObject({ startsAt: bookingInstantSchema });
export type ManageRescheduleBody = z.infer<typeof manageRescheduleBodySchema>;
/** BS-8: the reply to a reschedule: the new booking's view and its link. */
export const manageRescheduleReplySchema = z.strictObject({ view: manageViewSchema, token: manageTokenSchema });
export type ManageRescheduleReply = z.infer<typeof manageRescheduleReplySchema>;

export const selfCancelOutputSchema = z.lazy(() => actionResultSchema.extend({ result: selfCancelResultSchema }));
export const selfRescheduleOutputSchema = z.lazy(() => actionResultSchema.extend({ result: selfRescheduleResultSchema }));
export const confirmationOutputSchema = z.lazy(() => actionResultSchema.extend({ result: confirmationResultSchema }));
