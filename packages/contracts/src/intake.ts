import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingInstantSchema, bookingRecordSchema, bookingTimeZoneSchema } from "./booking.js";
import { contactEmailInputSchema, contactPhoneSchema, crmInstantSchema } from "./crm.js";
import { pageQuerySchema, pageSchema } from "./page.js";
import { isPostgresText } from "./json.js";

// M3a public intake boundary (docs/requirements/public-intake.md). Root re-exports this
// module, so shared root schemas are reached lazily, as in booking.ts and crm.ts.
const idSchema = z.lazy(() => uuidSchema);
const postgresText = (max: number) => z.string().max(max).refine(isPostgresText, "Invalid Postgres text");

export const intakeChannelSchema = z.enum(["booking_page", "widget"]);
export type IntakeChannel = z.infer<typeof intakeChannelSchema>;
export const intakeStatusSchema = z.enum(["new_contact", "possible_match", "linked", "rejected"]);
export type IntakeStatus = z.infer<typeof intakeStatusSchema>;
export const intakeConsentPurpose = "marketing_updates";

/** What the visitor typed; trimmed, so a name of spaces is refused rather than stored. */
const visitorNameSchema = postgresText(400).transform((value) => value.trim())
  .pipe(z.string().min(1, "Name is required").max(200));
const notesSchema = postgresText(2000).transform((value) => value.trim())
  .pipe(z.string().max(1000)).transform((value) => (value === "" ? null : value));

/** P-5: the public request body. No tenant, status, time, source or purpose is accepted. */
export const publicBookingRequestBodySchema = z.strictObject({
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
  name: visitorNameSchema,
  email: contactEmailInputSchema,
  phone: contactPhoneSchema.nullable().default(null),
  notes: notesSchema.nullable().default(null),
  consent: z.strictObject({ email: z.boolean(), sms: z.boolean() }),
  disclosureVersion: postgresText(50).pipe(z.string().min(1)),
  channel: intakeChannelSchema,
  /** Honeypot: people never see this field, so it stays empty. */
  website: z.literal(""),
  botToken: postgresText(2048).optional(),
});
export type PublicBookingRequestBody = z.input<typeof publicBookingRequestBodySchema>;
export const publicIdempotencyKeySchema = z.uuid().toLowerCase();

/** The command payload the server builds after resolving the page; every ID is server-minted. */
export const publicBookingRequestInputSchema = z.strictObject({
  bookingId: idSchema,
  intakeItemId: idSchema,
  contactId: idSchema,
  pageId: idSchema,
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
  name: z.string().min(1).max(200).refine(isPostgresText),
  email: contactEmailInputSchema,
  phone: contactPhoneSchema.nullable(),
  notes: z.string().min(1).max(1000).refine(isPostgresText).nullable(),
  consent: z.strictObject({ email: z.boolean(), sms: z.boolean() }),
  disclosureVersion: z.string().min(1).max(50).refine(isPostgresText),
  channel: intakeChannelSchema,
});
export type PublicBookingRequestInput = z.infer<typeof publicBookingRequestInputSchema>;
export const publicBookingRequestCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("booking.public_request"),
  target: targetSchema.extend({ type: z.literal("booking") }),
  payload: publicBookingRequestInputSchema,
}).refine((command) => command.target.id === command.payload.bookingId,
  "Target must equal the pre-minted booking ID"));
export type PublicBookingRequestCommand = z.infer<typeof publicBookingRequestCommandSchema>;

/** Stored action result. It names the outcome, so it never leaves the server as is (P-6). */
export const publicBookingRequestResultSchema = z.strictObject({
  bookingId: idSchema,
  intakeItemId: idSchema,
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
  outcome: z.enum(["new_contact", "possible_match"]),
  contactId: idSchema.nullable(),
});
export type PublicBookingRequestResult = z.infer<typeof publicBookingRequestResultSchema>;
export const publicBookingRequestOutputSchema = z.lazy(() =>
  actionResultSchema.extend({ result: publicBookingRequestResultSchema }));

/** P-6: the one reply every accepted request gets, whoever the visitor is. */
export const publicBookingReplySchema = z.strictObject({
  requestId: idSchema,
  status: z.literal("confirmed"),
  resourceId: idSchema,
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
});
export type PublicBookingReply = z.infer<typeof publicBookingReplySchema>;

/** P-11: what a visitor may see about a page. */
export const publicPageSchema = z.strictObject({
  businessName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  resources: z.array(z.strictObject({
    id: idSchema,
    name: z.string().nullable(),
    timeZone: bookingTimeZoneSchema,
    slotLengthMinutes: z.number().int(),
  })),
  disclosure: z.strictObject({ version: z.string(), text: z.string() }),
});
export type PublicPage = z.infer<typeof publicPageSchema>;

/** Owner view of a page, with what the owner pastes into a website. */
export const bookingPageSummarySchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  published: z.boolean(),
  disclosureVersion: z.string(),
  resourceIds: z.array(idSchema),
  publicKey: z.string(),
  bookingUrl: z.string(),
  embedScript: z.string(),
  embedIframe: z.string(),
});
export type BookingPageSummary = z.infer<typeof bookingPageSummarySchema>;

export const intakeConsentRecordSchema = z.strictObject({
  status: z.enum(["granted", "denied"]),
  purpose: z.string(),
  disclosureVersion: z.string(),
  /** P-8: the words the visitor saw, kept on the row; the page may show other words now. */
  disclosureText: z.string(),
  source: z.string(),
  recordedAt: crmInstantSchema,
});
export type IntakeConsentRecord = z.infer<typeof intakeConsentRecordSchema>;

export const intakeItemRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  kind: z.literal("booking_request"),
  status: intakeStatusSchema,
  channel: intakeChannelSchema,
  pageId: idSchema,
  submitted: z.strictObject({
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    notes: z.string().nullable(),
  }),
  matchedContactIds: z.array(idSchema),
  contactId: idSchema.nullable(),
  consent: z.strictObject({ email: intakeConsentRecordSchema.nullable(), sms: intakeConsentRecordSchema.nullable() }),
  booking: z.strictObject({
    id: idSchema,
    resourceId: idSchema,
    startsAt: bookingInstantSchema,
    endsAt: bookingInstantSchema,
  }).nullable(),
  reviewedAt: crmInstantSchema.nullable(),
  createdAt: crmInstantSchema,
});
export type IntakeItemRecord = z.infer<typeof intakeItemRecordSchema>;
export const intakeItemPageSchema = pageSchema(intakeItemRecordSchema);
export type IntakeItemPage = z.infer<typeof intakeItemPageSchema>;

export const listIntakeItemsQuerySchema = pageQuerySchema.extend({
  status: intakeStatusSchema.optional(),
});
export type ListIntakeItemsQuery = z.infer<typeof listIntakeItemsQuerySchema>;

export const linkIntakeItemRequestSchema = z.strictObject({ contactId: idSchema });
export type LinkIntakeItemRequest = z.infer<typeof linkIntakeItemRequestSchema>;
export const rejectIntakeItemRequestSchema = z.strictObject({});

export const linkIntakeItemInputSchema = z.strictObject({ intakeItemId: idSchema, contactId: idSchema });
export const linkIntakeItemCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("intake.item.link"),
  target: targetSchema.extend({ type: z.literal("intake_item") }),
  payload: linkIntakeItemInputSchema,
}).refine((command) => command.target.id === command.payload.intakeItemId, "Target must equal the intake item"));
export type LinkIntakeItemCommand = z.infer<typeof linkIntakeItemCommandSchema>;
export const rejectIntakeItemInputSchema = z.strictObject({ intakeItemId: idSchema });
export const rejectIntakeItemCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("intake.item.reject"),
  target: targetSchema.extend({ type: z.literal("intake_item") }),
  payload: rejectIntakeItemInputSchema,
}).refine((command) => command.target.id === command.payload.intakeItemId, "Target must equal the intake item"));
export type RejectIntakeItemCommand = z.infer<typeof rejectIntakeItemCommandSchema>;
export const intakeItemOutputSchema = z.lazy(() => actionResultSchema.extend({ result: intakeItemRecordSchema }));
export type IntakeItemOutput = z.infer<typeof intakeItemOutputSchema>;

/** A booking as the owner's lists show it: the record plus where it came from (P-12). */
export const bookingSummarySchema = z.strictObject({
  ...bookingRecordSchema.shape,
  source: z.enum(["owner", "website"]),
  intakeItemId: idSchema.nullable(),
  customer: z.strictObject({
    contactId: idSchema.nullable(),
    name: z.string().nullable(),
    status: intakeStatusSchema,
  }).nullable(),
});
export type BookingSummary = z.infer<typeof bookingSummarySchema>;
