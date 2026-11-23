import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";

// Inbound email, slice 1: receive, dark (docs/requirements/inbound-email.md IE-3, IE-8, IE-9, IE-12, IE-17).
// Only the server's inbound-email principal runs these actions; no member session can. Root re-exports this
// module, so shared root schemas are reached lazily, as in voice.ts.
const idSchema = z.lazy(() => uuidSchema);

/** IE-2: a handle is 16 characters of lower-case base32 (80 random bits). */
export const INBOUND_HANDLE_PATTERN = /^[a-z2-7]{16}$/;
/** IE-3: a routed local part is the handle and an optional reply reference after `+`. */
export const INBOUND_LOCAL_PART_PATTERN = /^([a-z2-7]{16})(?:\+([a-z2-7]{16}))?$/;
/** IE-3: at most this many `to`, `cc` and `bcc` entries together are read. */
export const INBOUND_RECIPIENT_LIMIT = 50;
/** IE-8: the webhook body cap (413 past it). */
export const INBOUND_WEBHOOK_MAX_BYTES = 256 * 1024;
/** IE-17: per tenant at most this many received rows in a rolling window, by the injected clock. */
export const INBOUND_ADMISSION_LIMIT = 2000;
export const INBOUND_ADMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** IE-12: the subject is one line of at most 200 characters. */
export const INBOUND_SUBJECT_LIMIT = 200;
/** The longest sender address stored (RFC 5321 path limit plus room for a display form that failed to parse). */
export const INBOUND_FROM_LIMIT = 320;

/** `inbound.email.receive` (IE-9). The webhook names Resend's `email_id`; the key is `email-inbound:<email_id>`. */
export const INBOUND_EMAIL_RECEIVE_ACTION = "inbound.email.receive";
/** The outbox event the receive writes, `{ inboundEmailId }`; the content worker (slice 2) reads it. */
export const INBOUND_EMAIL_RECEIVED_EVENT = "inbound.email.received";
export const INBOUND_EMAIL_IDEMPOTENCY_PREFIX = "email-inbound:";

/**
 * Resend's ID for a received message: printable, no control characters, and short enough that the
 * idempotency key `email-inbound:<email_id>` fits the 200-character key limit.
 */
export const providerEmailIdSchema = z.string().min(1).max(200 - INBOUND_EMAIL_IDEMPOTENCY_PREFIX.length).regex(/^[\x21-\x7e]+$/, "Expected a provider email ID");
export const inboundReplyRefSchema = z.string().regex(INBOUND_HANDLE_PATTERN, "Expected a reply reference");

/** The payload holds IDs, the address, the reference and the subject; never a body (IE-9, IE-35). */
export const inboundEmailReceiveInputSchema = z.strictObject({
  inboundEmailId: idSchema,
  provider: z.literal("resend"),
  providerEmailId: providerEmailIdSchema,
  addressId: idSchema,
  replyRef: inboundReplyRefSchema.nullable(),
  /** Normalised as contacts are when it parses (IE-19); otherwise trimmed and lower-cased. */
  fromAddress: z.string().min(1).max(INBOUND_FROM_LIMIT).refine(isPostgresText, "Invalid Postgres text")
    .regex(/^[^\x00-\x1f\x7f-\x9f]+$/, "A sender address has no control characters"),
  /** One line, cut per IE-12; null when the message had none. */
  subject: z.string().min(1).max(INBOUND_SUBJECT_LIMIT).refine(isPostgresText, "Invalid Postgres text")
    .regex(/^[^\x00-\x1f\x7f-\x9f]+$/, "A subject is one line with no control characters").nullable(),
});
export type InboundEmailReceiveInput = z.infer<typeof inboundEmailReceiveInputSchema>;
export const inboundEmailReceiveCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(INBOUND_EMAIL_RECEIVE_ACTION),
  target: targetSchema.extend({ type: z.literal("inbound_email") }),
  payload: inboundEmailReceiveInputSchema,
}).refine((command) => command.target.id === command.payload.inboundEmailId, "Target must equal the inbound email ID"));
export type InboundEmailReceiveCommand = z.infer<typeof inboundEmailReceiveCommandSchema>;
export const inboundEmailReceiveResultSchema = z.strictObject({
  inboundEmailId: idSchema,
  /** IE-21: the sender thread, `e_<senderKey>`. */
  senderKey: idSchema,
});
export type InboundEmailReceiveResult = z.infer<typeof inboundEmailReceiveResultSchema>;
export const inboundEmailReceivedEventSchema = z.strictObject({ inboundEmailId: idSchema });
export type InboundEmailReceivedEvent = z.infer<typeof inboundEmailReceivedEventSchema>;

export const INBOUND_EMAIL_ACTIONS = Object.freeze([INBOUND_EMAIL_RECEIVE_ACTION] as const);
