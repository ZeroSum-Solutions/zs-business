import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";
import { contactEmailInputSchema, contactPhoneSchema } from "./crm.js";
import { isPostgresText } from "./json.js";

// M3d wallet and delivery boundary (docs/requirements/delivery.md). Root re-exports this
// module, so shared root schemas are reached lazily, as in crm.ts and intake.ts.
const idSchema = z.lazy(() => uuidSchema);
const postgresText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(isPostgresText, "Invalid Postgres text");

export const deliveryChannelSchema = z.enum(["email", "sms"]);
export type DeliveryChannel = z.infer<typeof deliveryChannelSchema>;
export const deliveryPurposeSchema = z.enum(["transactional", "marketing"]);
export type DeliveryPurpose = z.infer<typeof deliveryPurposeSchema>;

/** D-1: the outbox event type a producer commits to ask for one send. */
export const MESSAGE_SEND_REQUESTED = "message.send_requested";
export const EMAIL_BODY_MAX = 20000;
export const EMAIL_SUBJECT_MAX = 998;
/** Ten concatenated segments; longer texts are refused rather than split silently. */
export const SMS_BODY_MAX = 1530;

/**
 * D-1: the event payload. It names the contact, never an address: the worker resolves the
 * address at delivery time and re-checks consent and suppression for it (D-6). It names no
 * approval either: the worker re-checks the approval of the action that committed the event.
 */
export const messageSendRequestedSchema = z.discriminatedUnion("channel", [
  z.strictObject({
    messageId: idSchema,
    contactId: idSchema,
    channel: z.literal("email"),
    purpose: deliveryPurposeSchema,
    subject: postgresText(1, EMAIL_SUBJECT_MAX).refine((value) => !/[\r\n]/.test(value), "Subject must be one line"),
    body: postgresText(1, EMAIL_BODY_MAX),
  }),
  z.strictObject({
    messageId: idSchema,
    contactId: idSchema,
    channel: z.literal("sms"),
    purpose: deliveryPurposeSchema,
    subject: z.null().default(null),
    body: postgresText(1, SMS_BODY_MAX),
  }),
]);
export type MessageSendRequested = z.infer<typeof messageSendRequestedSchema>;
export type MessageSendRequestedInput = z.input<typeof messageSendRequestedSchema>;

export const deliveryStatusSchema = z.enum(["pending", "leased", "uncertain", "sent", "blocked", "dead"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
/** Why a delivery stopped without a send (blocked) or gave up (dead). */
export const deliveryFinalReasonSchema = z.enum([
  "suppressed", "consent_denied", "consent_missing", "approval_revoked", "approval_missing", "no_address",
  "provider_rejected", "max_attempts", "insufficient_funds", "dedupe_window_expired", "outcome_unknown",
  "settled_not_sent", "worker_error", "address_changed",
]);
export type DeliveryFinalReason = z.infer<typeof deliveryFinalReasonSchema>;

export const walletSummarySchema = z.strictObject({
  currency: z.string().regex(/^[a-z]{3}$/),
  /** Minor units (cents). */
  balance: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
});
export type WalletSummary = z.infer<typeof walletSummarySchema>;

/**
 * D-11: the priced jobs a wallet reservation can name. A new kind needs a revision of
 * delivery.md and a contract that names its job table and its price; the SQL check on
 * `wallet_reservations.job_kind` lists the same strings (a test keeps them in step).
 */
export const WALLET_JOB_KINDS = ["message_delivery", "enrichment", "image_job", "voice_minutes", "browser_run"] as const;
export const walletJobKindSchema = z.enum(WALLET_JOB_KINDS);
export type WalletJobKind = z.infer<typeof walletJobKindSchema>;

export const suppressionReasonSchema =z.enum(["unsubscribe", "stop", "bounce", "complaint", "manual"]);
export type SuppressionReason = z.infer<typeof suppressionReasonSchema>;

/** D-9: one channel and address; email canonical (lower case), SMS in E.164. */
export const suppressionAddressSchema = z.discriminatedUnion("channel", [
  z.strictObject({ channel: z.literal("email"), address: contactEmailInputSchema }),
  z.strictObject({ channel: z.literal("sms"), address: contactPhoneSchema }),
]);
export type SuppressionAddress = z.infer<typeof suppressionAddressSchema>;

export const SUPPRESSION_RECORD_ACTION = "suppression.record";
export const SUPPRESSION_LIFT_ACTION = "suppression.lift";

const suppressionFields = { reason: suppressionReasonSchema, source: postgresText(1, 200) };
export const recordSuppressionInputSchema = z.discriminatedUnion("channel", [
  z.strictObject({ channel: z.literal("email"), address: contactEmailInputSchema, ...suppressionFields }),
  z.strictObject({ channel: z.literal("sms"), address: contactPhoneSchema, ...suppressionFields }),
]);
export type RecordSuppressionInput = z.infer<typeof recordSuppressionInputSchema>;
export const recordSuppressionCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SUPPRESSION_RECORD_ACTION),
  target: targetSchema.extend({ type: z.literal("suppression") }),
  payload: recordSuppressionInputSchema,
}));

/** START lifts a stop keyword suppression only (D-9); other reasons stay. */
export const liftSuppressionInputSchema = z.strictObject({
  channel: z.literal("sms"),
  address: contactPhoneSchema,
  reason: z.literal("stop"),
  source: postgresText(1, 200),
});
export type LiftSuppressionInput = z.infer<typeof liftSuppressionInputSchema>;
export const liftSuppressionCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SUPPRESSION_LIFT_ACTION),
  target: targetSchema.extend({ type: z.literal("suppression") }),
  payload: liftSuppressionInputSchema,
}));

export const suppressionResultSchema = z.strictObject({
  channel: deliveryChannelSchema,
  suppressed: z.boolean(),
  /** True when this action changed the list; a repeat of an earlier change reports false. */
  changed: z.boolean(),
});
export type SuppressionResult = z.infer<typeof suppressionResultSchema>;

/** D-9: inbound SMS as a provider webhook will hand it over (M5); the sender is E.164. */
export const inboundSmsSchema = z.strictObject({
  from: contactPhoneSchema,
  body: z.string().max(SMS_BODY_MAX).refine(isPostgresText, "Invalid Postgres text"),
  /** The provider's ID for the inbound message; it keys the action, so a redelivered webhook replays. */
  // Leaves room for the server's "sms-inbound:" key and "sms:" source prefixes within 200.
  providerMessageId: postgresText(1, 180),
});
export type InboundSms = z.infer<typeof inboundSmsSchema>;
export const inboundSmsReplySchema = z.strictObject({
  keyword: z.enum(["stop", "start", "help"]).nullable(),
  /** Text to send back, or null for no reply. */
  reply: z.string().nullable(),
});
export type InboundSmsReply = z.infer<typeof inboundSmsReplySchema>;

/**
 * twilio.md T-8: the reply given to one inbound keyword text, under the message's own key, so a
 * repeat of the message gets the same text after the business name or HELP reply changes.
 */
export const SMS_REPLY_RECORD_ACTION = "sms.reply.record";
export const smsReplyInputSchema = z.strictObject({
  address: contactPhoneSchema,
  keyword: z.enum(["stop", "start", "help"]),
  reply: postgresText(1, 1000),
});
export const smsReplyCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SMS_REPLY_RECORD_ACTION),
  target: targetSchema.extend({ type: z.literal("suppression") }),
  payload: smsReplyInputSchema,
}));

/**
 * twilio.md T-5, T-6: one signed provider status for one SMS delivery, recorded as evidence that
 * the provider created the message. Only the server's status-callback principal runs it.
 */
export const SMS_STATUS_RECORD_ACTION = "sms.status.record";
export const smsStatusInputSchema = z.strictObject({
  deliveryId: idSchema,
  providerMessageId: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/),
  /** The provider's status word, lower case (queued, sent, delivered, undelivered, failed, …). */
  status: z.string().regex(/^[a-z_]{1,40}$/),
  /** The provider's numeric error code, when it reported one. */
  errorCode: z.string().regex(/^[0-9]{1,10}$/).nullable(),
});
export type SmsStatusInput = z.infer<typeof smsStatusInputSchema>;
export const smsStatusCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(SMS_STATUS_RECORD_ACTION),
  target: targetSchema.extend({ type: z.literal("delivery") }),
  payload: smsStatusInputSchema,
}));
export const smsStatusResultSchema = z.strictObject({
  deliveryId: idSchema,
  status: z.string(),
  /** False when this status of this message was already recorded. */
  recorded: z.boolean(),
});
export type SmsStatusResult = z.infer<typeof smsStatusResultSchema>;
