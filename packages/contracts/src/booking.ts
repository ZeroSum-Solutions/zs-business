import { z } from "zod";
import { supportedInstantSchema } from "./instant.js";
import { isPostgresText } from "./json.js";
import {
  actionCommandSchema,
  actionResultSchema,
  targetSchema,
  uuidSchema,
  type ActionCommand,
  type ActionError,
  type ActionResult,
} from "./index.js";

// Root re-exports this module; defer access to the shared schema until parsing.
const idSchema = z.lazy(() => uuidSchema);

/** F1 frozen boundary. These schemas validate data; they do not calculate slots. */
/** B-3: UTC years 0001 through 9999 only. Year 0000 fits the pattern, but Postgres has no year zero. */
export const bookingInstantSchema = supportedInstantSchema;
export type BookingInstant = z.infer<typeof bookingInstantSchema>;
export const bookingTimeZoneSchema = z.string().min(1).refine((zone) => {
  if (zone !== "UTC" && !zone.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Expected an IANA time zone, or UTC");
export type BookingTimeZone = z.infer<typeof bookingTimeZoneSchema>;
const minutesSchema = z.number().int().min(0).max(1440);
export const localAvailabilityWindowSchema = z.strictObject({
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
}).refine((value) => value.startMinute < value.endMinute, "Window must have positive length");
export type LocalAvailabilityWindow = z.infer<typeof localAvailabilityWindowSchema>;
export const weeklyAvailabilityRuleSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  windows: z.array(localAvailabilityWindowSchema),
});
export type WeeklyAvailabilityRule = z.infer<typeof weeklyAvailabilityRuleSchema>;
export const availabilityOverrideSchema = z.strictObject({
  date: z.iso.date(),
  windows: z.array(localAvailabilityWindowSchema),
});
export type AvailabilityOverride = z.infer<typeof availabilityOverrideSchema>;
export const bookingResourceSchema = z.strictObject({
  tenantId: idSchema,
  id: idSchema,
  timeZone: bookingTimeZoneSchema,
  weekly: z.array(weeklyAvailabilityRuleSchema),
  overrides: z.array(availabilityOverrideSchema),
  slotLengthMinutes: z.number().int().min(1).max(1440),
  slotStepMinutes: z.number().int().min(1).max(1440),
  bufferBeforeMinutes: minutesSchema,
  bufferAfterMinutes: minutesSchema,
  minimumNoticeMinutes: z.number().int().min(0).max(525600),
  bookingHorizonMinutes: z.number().int().min(0).max(525600),
}).refine((value) => new Set(value.weekly.map((rule) => rule.weekday)).size === value.weekly.length,
  "Each weekday may appear once")
  .refine((value) => new Set(value.overrides.map((rule) => rule.date)).size === value.overrides.length,
    "Each override date may appear once");
export type BookingResource = z.infer<typeof bookingResourceSchema>;
export const bookingIntervalSchema = z.strictObject({
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
}).refine((value) => value.startsAt < value.endsAt, "Interval must have positive length");
export type BookingInterval = z.infer<typeof bookingIntervalSchema>;
export const bookingBusyIntervalSchema = z.discriminatedUnion("kind", [
  bookingIntervalSchema.safeExtend({
    kind: z.literal("booking"), tenantId: idSchema, resourceId: idSchema,
    bufferBeforeMinutes: minutesSchema, bufferAfterMinutes: minutesSchema,
  }),
  bookingIntervalSchema.safeExtend({
    kind: z.literal("external"), tenantId: idSchema, resourceId: idSchema,
  }),
]);
export type BookingBusyInterval = z.infer<typeof bookingBusyIntervalSchema>;
export const getAvailableSlotsInputSchema = z.strictObject({
  resource: bookingResourceSchema,
  range: bookingIntervalSchema,
  busy: z.array(bookingBusyIntervalSchema),
}).refine((value) => Date.parse(value.range.endsAt) - Date.parse(value.range.startsAt) <= 31 * 86400000,
  "Query range must be at most 31 elapsed days")
  .refine((value) => value.busy.every((busy) =>
    busy.tenantId === value.resource.tenantId && busy.resourceId === value.resource.id),
  "Busy intervals must belong to the input resource and tenant");
export type GetAvailableSlotsInput = z.infer<typeof getAvailableSlotsInputSchema>;
export const getAvailableSlotsOutputSchema = z.strictObject({
  resourceId: idSchema,
  timeZone: bookingTimeZoneSchema,
  slots: z.array(bookingIntervalSchema),
});
export type GetAvailableSlotsOutput = z.infer<typeof getAvailableSlotsOutputSchema>;
export const createBookingInputSchema = z.strictObject({
  bookingId: idSchema,
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
});
export type CreateBookingInput = z.infer<typeof createBookingInputSchema>;
export const createBookingCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("booking.create"),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: createBookingInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId,
  "Target must equal the pre-minted booking ID"));
export type CreateBookingCommand = z.infer<typeof createBookingCommandSchema>;
export const bookingRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
  occupiedStartsAt: bookingInstantSchema,
  occupiedEndsAt: bookingInstantSchema,
  bufferBeforeMinutes: minutesSchema,
  bufferAfterMinutes: minutesSchema,
  /** B-29: `cancelled` rows are kept for the record and take no part in availability. */
  status: z.enum(["confirmed", "cancelled"]),
  createdAt: bookingInstantSchema,
}).refine((value) => value.startsAt < value.endsAt &&
  Date.parse(value.occupiedStartsAt) === Date.parse(value.startsAt) - value.bufferBeforeMinutes * 60000 &&
  Date.parse(value.occupiedEndsAt) === Date.parse(value.endsAt) + value.bufferAfterMinutes * 60000,
"Occupied interval must include exactly the saved buffers");
export type BookingRecord = z.infer<typeof bookingRecordSchema>;
export const createBookingOutputSchema = z.lazy(() => actionResultSchema.extend({ result: bookingRecordSchema }));
export type CreateBookingOutput = z.infer<typeof createBookingOutputSchema>;

/** B-29: why an owner cancelled, shown to nobody but the owner. One line of plain text, up to 500 characters. */
export const bookingCancelReasonSchema = z.string().trim().min(1).max(500).refine(isPostgresText, "Invalid Postgres text")
  .refine((value) => !/[\r\n\u0085\u2028\u2029]/u.test(value), "The reason must be one line");
/** B-29: the HTTP and tool body. Both fields are optional; the server fills the defaults before it binds the action. */
export const cancelBookingRequestSchema = z.strictObject({
  reason: bookingCancelReasonSchema.nullish(),
  notifyCustomer: z.boolean().optional(),
});
export type CancelBookingRequest = z.infer<typeof cancelBookingRequestSchema>;
/** B-29: the bound payload: every field present, so one cancellation has one canonical form. */
export const cancelBookingInputSchema = z.strictObject({
  bookingId: idSchema,
  reason: bookingCancelReasonSchema.nullable(),
  notifyCustomer: z.boolean(),
});
export type CancelBookingInput = z.infer<typeof cancelBookingInputSchema>;
export const CANCEL_BOOKING_ACTION = "booking.cancel";
export const cancelBookingCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CANCEL_BOOKING_ACTION),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: cancelBookingInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId, "Target must equal the booking"));
export type CancelBookingCommand = z.infer<typeof cancelBookingCommandSchema>;
/**
 * B-33: what happened to the customer's notice. `queued`: one transactional email was handed to delivery.
 * `off`: the owner chose not to notify. `no_customer` / `no_email`: nobody to write to. `already_cancelled`: this call
 * changed nothing, so it sent nothing.
 */
export const cancelNoticeSchema = z.enum(["queued", "off", "no_customer", "no_email", "already_cancelled"]);
export type CancelNotice = z.infer<typeof cancelNoticeSchema>;
export const cancelBookingResultSchema = z.strictObject({
  booking: bookingRecordSchema,
  cancelledAt: bookingInstantSchema,
  reason: z.string().nullable(),
  customerNotice: cancelNoticeSchema,
}).refine((value) => value.booking.status === "cancelled", "A cancellation result holds a cancelled booking");
export type CancelBookingResult = z.infer<typeof cancelBookingResultSchema>;
export const cancelBookingOutputSchema = z.lazy(() => actionResultSchema.extend({ result: cancelBookingResultSchema }));
export type CancelBookingOutput = z.infer<typeof cancelBookingOutputSchema>;

export const getAvailableSlotsErrorCodeSchema = z.enum(["ValidationFailed", "NotImplemented"]);
export type GetAvailableSlotsErrorCode = z.infer<typeof getAvailableSlotsErrorCodeSchema>;
export type GetAvailableSlotsError = ActionError<GetAvailableSlotsErrorCode>;
export const createBookingErrorCodeSchema = z.enum([
  "ValidationFailed", "TenantDenied", "BindingMismatch", "IdempotencyConflict", "Conflict", "NotImplemented",
]);
export type CreateBookingErrorCode = z.infer<typeof createBookingErrorCodeSchema>;
export type CreateBookingError = ActionError<CreateBookingErrorCode>;
export interface BookingSlotDependencies {
  readonly clock: { now(): Date };
}
/** Bind createDispatcher(handlers) to trusted DispatchContext at the server edge. */
export interface BookingWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
/** @throws {GetAvailableSlotsError} Synchronous, deterministic for the supplied clock. */
export type GetAvailableSlots = (input: GetAvailableSlotsInput, deps: BookingSlotDependencies) => GetAvailableSlotsOutput;
/** @throws {CreateBookingError} Resolves only after the shared dispatcher commits. */
export type CreateBooking = (command: CreateBookingCommand, ctx: BookingWriteContext) => Promise<CreateBookingOutput>;
