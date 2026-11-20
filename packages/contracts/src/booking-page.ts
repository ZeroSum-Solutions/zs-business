import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";

// Editing a booking page after it is created (docs/requirements/public-intake.md P-17). Root
// re-exports this module, so shared root schemas are reached lazily, as in business.ts.
const idSchema = z.lazy(() => uuidSchema);

/** P-17: the owner action that changes a page's title or description. */
export const BOOKING_PAGE_UPDATE_ACTION = "booking.page.update";

/** Postgres `char_length` counts code points, so the length rules do too. */
const codePointsAtMost = (max: number) => (value: string) => [...value].length <= max;
const postgresText = (value: string) => isPostgresText(value);

/** `booking_pages.title`: 1..200 characters after trimming. */
export const bookingPageTitleSchema = z.string().trim().min(1)
  .refine(codePointsAtMost(200), "Expected at most 200 characters").refine(postgresText, "Text is not valid in Postgres");
/** `booking_pages.description`: 1..2000 characters after trimming; null clears it (the page then shows none). */
export const bookingPageDescriptionSchema = z.string().trim().min(1)
  .refine(codePointsAtMost(2000), "Expected at most 2000 characters").refine(postgresText, "Text is not valid in Postgres");

/** The editable fields; the ones named are set, the others stay as they are. A title cannot be cleared. */
export const bookingPageChangesSchema = z.strictObject({
  title: bookingPageTitleSchema,
  description: bookingPageDescriptionSchema.nullable(),
}).partial().refine((changes) => Object.keys(changes).length > 0, "Name at least one field to change");
export type BookingPageChanges = z.infer<typeof bookingPageChangesSchema>;

/** P-17: PUT /v1/booking/pages/:id. */
export const updateBookingPageRequestSchema = z.strictObject({ changes: bookingPageChangesSchema });
export type UpdateBookingPageRequest = z.infer<typeof updateBookingPageRequestSchema>;

/** P-17: the page as it stands after the edit; `changed` is false when every named field already had its value. */
export const bookingPageUpdatedSchema = z.strictObject({
  pageId: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  changed: z.boolean(),
});
export type BookingPageUpdated = z.infer<typeof bookingPageUpdatedSchema>;

/** `replayed` is true only when a stored action answered: the same Idempotency-Key and request. */
export const updateBookingPageResponseSchema = z.lazy(() =>
  actionResultSchema.extend({ result: bookingPageUpdatedSchema, replayed: z.boolean() }));
export type UpdateBookingPageResponse = z.infer<typeof updateBookingPageResponseSchema>;

/** The action command the dispatcher binds: the target is the page, the payload repeats its ID and the changes. */
export const updateBookingPageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(BOOKING_PAGE_UPDATE_ACTION),
  target: targetSchema.extend({ type: z.literal("booking_page") }),
  payload: z.strictObject({ pageId: idSchema, changes: bookingPageChangesSchema }),
}).refine((command) => command.payload.pageId === command.target.id, "The page and the target differ"));
