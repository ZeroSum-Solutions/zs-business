import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";
import { contactPhoneSchema } from "./crm.js";

// Missed-call text-back (docs/requirements/twilio.md T-10..T-14). Only the server's voice-webhook
// principal runs these actions; no member session can. Root re-exports this module, so shared
// root schemas are reached lazily, as in delivery.ts.
const idSchema = z.lazy(() => uuidSchema);

export const callSidSchema = z.string().regex(/^CA[0-9a-f]{32}$/, "Expected a Twilio CallSid");
export const recordingSidSchema = z.string().regex(/^RE[0-9a-f]{32}$/, "Expected a Twilio RecordingSid");
/** Short enough for a signed query parameter and a URL path; the operator picks it. */
export const voiceDisclosureVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/);

/** T-11: the dial leg's result words that mean the business did not answer. */
export const MISSED_DIAL_STATUSES = Object.freeze(["busy", "no-answer", "failed"] as const);
export const dialStatusSchema = z.enum(["completed", "busy", "no-answer", "failed", "canceled"]);
export type DialStatus = z.infer<typeof dialStatusSchema>;
/** T-11, T-14: why a call was or was not offered the text. */
export const offerReasonSchema = z.enum([
  "offered", "answered", "canceled", "disabled", "no_caller_number", "suppressed", "sms_denied", "limit",
  "limiter_unavailable", "mailbox_full",
]);
export type OfferReason = z.infer<typeof offerReasonSchema>;

/** `voice.call.record`: the incoming call, then the dial step's stored decision (T-10, T-11, T-14). */
export const VOICE_CALL_RECORD_ACTION = "voice.call.record";
export const voiceCallInputSchema = z.discriminatedUnion("step", [
  z.strictObject({ step: z.literal("incoming"), callSid: callSidSchema, from: contactPhoneSchema.nullable(), to: contactPhoneSchema }),
  z.strictObject({
    step: z.literal("dial"),
    callSid: callSidSchema,
    dialStatus: dialStatusSchema,
    offered: z.boolean(),
    offerReason: offerReasonSchema,
    mailboxOpen: z.boolean(),
    /** The wording offered; required when `offered` (the handler checks). */
    disclosureVersion: voiceDisclosureVersionSchema.nullable(),
  }),
]);
export type VoiceCallInput = z.infer<typeof voiceCallInputSchema>;
export const voiceCallCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(VOICE_CALL_RECORD_ACTION),
  target: targetSchema.extend({ type: z.literal("voice_call") }),
  payload: voiceCallInputSchema,
}));
export const voiceCallResultSchema = z.strictObject({
  callSid: callSidSchema,
  step: z.enum(["incoming", "dial"]),
  /** False when the row already held this step (a concurrent twin won). */
  recorded: z.boolean(),
  offered: z.boolean().nullable(),
  offerReason: offerReasonSchema.nullable(),
  mailboxOpen: z.boolean().nullable(),
});
export type VoiceCallResult = z.infer<typeof voiceCallResultSchema>;

/** `voice.textback.optin`: the caller pressed 1 (T-12). The rest comes from the stored rows. */
export const VOICE_TEXTBACK_OPTIN_ACTION = "voice.textback.optin";
export const voiceOptinInputSchema = z.strictObject({
  callSid: callSidSchema,
  /** The ID a new phone-only contact gets; an existing contact with the number is used instead. */
  contactId: idSchema,
  messageId: idSchema,
  disclosureVersion: voiceDisclosureVersionSchema,
});
export type VoiceOptinInput = z.infer<typeof voiceOptinInputSchema>;
export const voiceOptinCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(VOICE_TEXTBACK_OPTIN_ACTION),
  target: targetSchema.extend({ type: z.literal("voice_call") }),
  payload: voiceOptinInputSchema,
}));
export const voiceOptinResultSchema = z.strictObject({
  callSid: callSidSchema,
  /** `denied`: the contact has a recorded SMS denial; nothing was written and no text is coming. */
  outcome: z.enum(["requested", "denied"]),
  contactId: idSchema,
  messageId: idSchema.nullable(),
});
export type VoiceOptinResult = z.infer<typeof voiceOptinResultSchema>;

/** `voice.voicemail.record`: a completed recording becomes one voicemail (T-13). */
export const VOICE_VOICEMAIL_RECORD_ACTION = "voice.voicemail.record";
export const voiceVoicemailInputSchema = z.strictObject({
  callSid: callSidSchema,
  voicemailId: idSchema,
  recordingSid: recordingSidSchema,
  durationSeconds: z.number().int().min(1).max(600),
});
export type VoiceVoicemailInput = z.infer<typeof voiceVoicemailInputSchema>;
export const voiceVoicemailCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(VOICE_VOICEMAIL_RECORD_ACTION),
  target: targetSchema.extend({ type: z.literal("voice_call") }),
  payload: voiceVoicemailInputSchema,
}));
export const voiceVoicemailResultSchema = z.strictObject({
  callSid: callSidSchema,
  voicemailId: idSchema,
  contactId: idSchema.nullable(),
  recorded: z.boolean(),
});
export type VoiceVoicemailResult = z.infer<typeof voiceVoicemailResultSchema>;

export const VOICE_ACTIONS = Object.freeze([VOICE_CALL_RECORD_ACTION, VOICE_TEXTBACK_OPTIN_ACTION, VOICE_VOICEMAIL_RECORD_ACTION] as const);

/** T-13: how long a recording stays at Twilio. */
export const VOICEMAIL_AUDIO_DAYS = 30;
