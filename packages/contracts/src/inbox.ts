import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingInstantSchema } from "./booking.js";
import { crmInstantSchema } from "./crm.js";
import { intakeChannelSchema, intakeStatusSchema } from "./intake.js";
import { isPostgresText } from "./json.js";
import { pageQuerySchema, pageSchema } from "./page.js";

// M3c Inbox v1 (docs/requirements/inbox-home.md I-1..I-9). Root re-exports this module, so
// shared root schemas are reached lazily, as in booking.ts and crm.ts.
const idSchema = z.lazy(() => uuidSchema);

export const replyStatusSchema = z.enum(["draft", "approved", "sent", "failed", "discarded"]);
export type ReplyStatus = z.infer<typeof replyStatusSchema>;
export const replyChannelSchema = z.enum(["email"]);
export type ReplyChannel = z.infer<typeof replyChannelSchema>;
export const MAX_REPLY_LENGTH = 5000;
/** I-5: trimmed, so a reply of spaces is refused rather than stored. */
export const replyBodySchema = z.string().max(MAX_REPLY_LENGTH * 2).refine(isPostgresText, "Invalid Postgres text")
  .transform((value) => value.trim())
  .pipe(z.string().min(1, "Write a reply first").max(MAX_REPLY_LENGTH));

/** I-2: `c_<contactId>` for a customer, `v_<intakeItemId>` for a visitor not yet linked. */
export const threadIdSchema = z.string()
  .regex(/^[cv]_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Not a thread ID")
  .transform((value) => value.toLowerCase());
export type ThreadId = z.infer<typeof threadIdSchema>;
export const threadKindSchema = z.enum(["customer", "visitor"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

export const draftReplyInputSchema = z.strictObject({ replyId: idSchema, contactId: idSchema, body: replyBodySchema });
export type DraftReplyInput = z.infer<typeof draftReplyInputSchema>;
export const draftReplyCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("inbox.reply.draft"),
  target: targetSchema.extend({ type: z.literal("inbox_reply") }),
  payload: draftReplyInputSchema,
}).refine((command) => command.target.id === command.payload.replyId, "Target must equal the pre-minted reply ID"));
export type DraftReplyCommand = z.infer<typeof draftReplyCommandSchema>;

export const replyRefInputSchema = z.strictObject({ replyId: idSchema });
export const approveReplyCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("inbox.reply.approve"),
  target: targetSchema.extend({ type: z.literal("inbox_reply") }),
  payload: replyRefInputSchema,
}).refine((command) => command.target.id === command.payload.replyId, "Target must equal the reply"));
export type ApproveReplyCommand = z.infer<typeof approveReplyCommandSchema>;
export const discardReplyCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("inbox.reply.discard"),
  target: targetSchema.extend({ type: z.literal("inbox_reply") }),
  payload: replyRefInputSchema,
}).refine((command) => command.target.id === command.payload.replyId, "Target must equal the reply"));
export type DiscardReplyCommand = z.infer<typeof discardReplyCommandSchema>;

/** The member a step names; `email` is null once that person is no longer a member. */
export const replyActorSchema = z.strictObject({ userId: idSchema, email: z.string().nullable() });
export type ReplyActor = z.infer<typeof replyActorSchema>;

export const replyRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  contactId: idSchema,
  channel: replyChannelSchema,
  body: z.string(),
  status: replyStatusSchema,
  draftedBy: replyActorSchema,
  createdAt: crmInstantSchema,
  approvedBy: replyActorSchema.nullable(),
  approvedAt: crmInstantSchema.nullable(),
  discardedAt: crmInstantSchema.nullable(),
  settledAt: crmInstantSchema.nullable(),
});
export type ReplyRecord = z.infer<typeof replyRecordSchema>;
export const replyOutputSchema = z.lazy(() => actionResultSchema.extend({ result: replyRecordSchema }));
export type ReplyOutput = z.infer<typeof replyOutputSchema>;

/** I-6: the one outbox event an approval writes; the delivery worker (M3d) reads it. */
export const REPLY_APPROVED_EVENT = "inbox.reply.approved";
export const replyApprovedEventSchema = z.strictObject({
  replyId: idSchema,
  contactId: idSchema,
  channel: replyChannelSchema,
});
export type ReplyApprovedEvent = z.infer<typeof replyApprovedEventSchema>;

/** HTTP and MCP bodies; the edge mints replyId from the idempotency key. */
export const draftReplyRequestSchema = z.strictObject({ contactId: idSchema, body: replyBodySchema });
export type DraftReplyRequest = z.input<typeof draftReplyRequestSchema>;
export const replyStepRequestSchema = z.strictObject({});

export const threadSummarySchema = z.strictObject({
  id: z.string(),
  kind: threadKindSchema,
  contactId: idSchema.nullable(),
  intakeItemId: idSchema.nullable(),
  /** The customer's name, else their email or phone; for a visitor, the name they typed. */
  name: z.string(),
  email: z.string().nullable(),
  /** The latest notes or reply text, at most 140 characters; null when there is none. */
  preview: z.string().nullable(),
  lastActivityAt: crmInstantSchema,
  needsReply: z.boolean(),
  needsReview: z.boolean(),
  drafts: z.number().int().min(0),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export const threadPageSchema = pageSchema(threadSummarySchema);
export type ThreadPage = z.infer<typeof threadPageSchema>;
export const listThreadsQuerySchema = pageQuerySchema;
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

export const requestEntrySchema = z.strictObject({
  type: z.literal("request"),
  id: idSchema,
  at: crmInstantSchema,
  channel: intakeChannelSchema,
  status: intakeStatusSchema,
  name: z.string(),
  notes: z.string().nullable(),
  booking: z.strictObject({
    id: idSchema,
    resourceId: idSchema,
    startsAt: bookingInstantSchema,
    endsAt: bookingInstantSchema,
  }).nullable(),
});
export type RequestEntry = z.infer<typeof requestEntrySchema>;
export const replyEntrySchema = z.strictObject({ type: z.literal("reply"), at: crmInstantSchema, reply: replyRecordSchema });
export type ReplyEntry = z.infer<typeof replyEntrySchema>;
export const threadEntrySchema = z.discriminatedUnion("type", [requestEntrySchema, replyEntrySchema]);
export type ThreadEntry = z.infer<typeof threadEntrySchema>;
/** I-3: at most this many latest entries; `olderEntries` says whether more exist. */
export const THREAD_ENTRY_LIMIT = 200;
export const threadDetailSchema = z.strictObject({
  ...threadSummarySchema.shape,
  phone: z.string().nullable(),
  entries: z.array(threadEntrySchema),
  olderEntries: z.boolean(),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;
