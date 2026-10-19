import { z } from "zod";
import { bookingInstantSchema, bookingRecordSchema, bookingTimeZoneSchema } from "./booking.js";
import {
  contactRecordSchema,
  createOrFindContactInputSchema,
  createDealInputSchema,
  dealRecordSchema,
  moveDealStageInputSchema,
} from "./crm.js";
import { isPostgresText, jsonValueSchema } from "./json.js";

// The root module re-exports this one, so shared root schemas are not initialized yet here.
const idSchema = z.uuid().toLowerCase();

/** M1 edge boundary: request, response and error shapes shared by the HTTP API and MCP tools. */
export const idempotencyKeySchema = z.string().min(1).max(200)
  .refine(isPostgresText, "Text is not valid in Postgres");

/**
 * Supabase Auth access-token claims the edge relies on; other claims pass through.
 * `session_id` names the auth.sessions row, so a signed-out token is refused at once.
 */
export const accessTokenClaimsSchema = z.object({
  sub: idSchema,
  session_id: idSchema,
  app_metadata: z.object({ tenant_id: idSchema }),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const createBookingRequestSchema = z.strictObject({
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
});
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

const contact = createOrFindContactInputSchema.shape;
export const upsertContactRequestSchema = z.strictObject({
  displayName: contact.displayName.default(null),
  email: contact.email.default(null),
  phone: contact.phone.default(null),
  mode: contact.mode.default("interactive"),
  consent: contact.consent.default({ email: null, sms: null }),
}).refine((value) => value.email !== null || value.phone !== null, "At least one identity is required");
export type UpsertContactRequest = z.input<typeof upsertContactRequestSchema>;

const deal = createDealInputSchema.shape;
export const createDealRequestSchema = z.strictObject({
  contactId: deal.contactId,
  pipelineId: deal.pipelineId,
  stageId: deal.stageId,
  title: deal.title,
});
export type CreateDealRequest = z.infer<typeof createDealRequestSchema>;

const move = moveDealStageInputSchema.shape;
export const moveDealStageRequestSchema = z.strictObject({
  pipelineId: move.pipelineId,
  stageId: move.stageId,
  expectedRevision: move.expectedRevision,
});
export type MoveDealStageRequest = z.infer<typeof moveDealStageRequestSchema>;

/** Query strings arrive as text; coerce, then bound. */
export const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  /**
   * Where the page starts: the previous page's `nextCursor`. Unlike `offset`, rows added or
   * moved ahead of it while a caller pages do not repeat or skip rows after it. Opaque, and
   * only meaningful for the same list and sort; not combined with an offset.
   */
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/, "Not a page cursor").optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;
/** Bookings that overlap [from, to): either bound may be left open. */
export const listBookingsQuerySchema = pageQuerySchema.extend({
  resourceId: idSchema.optional(),
  from: bookingInstantSchema.optional(),
  to: bookingInstantSchema.optional(),
}).refine((value) => !value.from || !value.to || value.from < value.to, "Range must have positive length");
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export const listDealsQuerySchema = pageQuerySchema.extend({
  pipelineId: idSchema.optional(),
  contactId: idSchema.optional(),
});
export type ListDealsQuery = z.infer<typeof listDealsQuerySchema>;

/** At most one page of IDs, comma-separated, so a query string can carry them. */
export const MAX_CONTACT_IDS = 100;
const uuidText = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
export const listContactsQuerySchema = pageQuerySchema.extend({
  /** Part of a name, email or phone number, case-insensitive. Blank means no filter. */
  search: z.string().trim().max(200).refine(isPostgresText, "Text is not valid in Postgres").optional(),
  /** `recent`: newest first (the default). `name`: by name, then email, then phone. */
  sort: z.enum(["recent", "name"]).default("recent"),
  /** Only these contacts, such as the ones a page of deals refers to. */
  ids: z.string().regex(new RegExp(`^${uuidText}(,${uuidText}){0,${MAX_CONTACT_IDS - 1}}$`), `Up to ${MAX_CONTACT_IDS} comma-separated contact IDs`).optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;

export const slotsQuerySchema = z.strictObject({
  resourceId: idSchema,
  from: bookingInstantSchema,
  to: bookingInstantSchema,
  /** Zone for the local labels; defaults to the resource's own zone. */
  zone: bookingTimeZoneSchema.optional(),
}).refine((value) => value.from < value.to, "Range must have positive length")
  .refine((value) => Date.parse(value.to) - Date.parse(value.from) <= 31 * 86400000,
    "Query range must be at most 31 elapsed days");
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;

export const slotsResponseSchema = z.strictObject({
  resourceId: idSchema,
  timeZone: bookingTimeZoneSchema,
  zone: bookingTimeZoneSchema,
  slots: z.array(z.strictObject({
    startsAt: bookingInstantSchema,
    endsAt: bookingInstantSchema,
    /** Wall-clock start in `zone`, ISO 8601 without an offset. */
    localStart: z.string(),
  })),
});
export type SlotsResponse = z.infer<typeof slotsResponseSchema>;

export const pageSchema = <Item extends z.ZodType>(item: Item) => z.strictObject({
  items: z.array(item),
  limit: z.number().int(),
  offset: z.number().int(),
  /** The next page by offset; null on the last page and when this page was read by cursor. */
  nextOffset: z.number().int().nullable(),
  /** The next page by cursor, which stays put when rows are added ahead of it; null on the last page. */
  nextCursor: z.string().nullable(),
});
export const contactPageSchema = pageSchema(contactRecordSchema);
export type ContactPage = z.infer<typeof contactPageSchema>;
export const dealPageSchema = pageSchema(dealRecordSchema);
export type DealPage = z.infer<typeof dealPageSchema>;
export const bookingPageSchema = pageSchema(bookingRecordSchema);
export type BookingPage = z.infer<typeof bookingPageSchema>;

export const pipelineSummarySchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  stages: z.array(z.strictObject({ id: idSchema, name: z.string(), position: z.number().int() })),
});
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;
export const resourceSummarySchema = z.strictObject({
  id: idSchema,
  name: z.string().nullable(),
  timeZone: bookingTimeZoneSchema,
  slotLengthMinutes: z.number().int(),
});
export type ResourceSummary = z.infer<typeof resourceSummarySchema>;

/** One error body for every non-2xx response and every failed MCP tool call. */
export const apiErrorCodeSchema = z.enum([
  "ValidationFailed", "Unauthorized", "Forbidden", "NotFound", "Conflict", "Internal",
  /** 503: no database connection in time, the request deadline passed, or Supabase Auth could not answer. Retry later. */
  "Unavailable",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export const apiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Safe, documented fields only, such as `reason` or `currentRevision`. */
    details: z.record(z.string(), jsonValueSchema),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
