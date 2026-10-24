// Missed-call text-back actions (docs/requirements/twilio.md T-10..T-14). They run in the shared
// dispatcher transaction as the runtime role; only the server's voice-webhook principal may run
// them (edge/voice-session.ts). Original code.
import {
  Conflict,
  MESSAGE_SEND_REQUESTED,
  NotFound,
  VOICE_CALL_RECORD_ACTION,
  VOICE_TEXTBACK_OPTIN_ACTION,
  VOICE_VOICEMAIL_RECORD_ACTION,
  VOICEMAIL_AUDIO_DAYS,
  ValidationFailed,
  voiceCallCommandSchema,
  voiceOptinCommandSchema,
  voiceVoicemailCommandSchema,
  type MessageSendRequested,
  type Target,
  type VoiceCallResult,
  type VoiceOptinResult,
  type VoiceVoicemailResult,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { lockIdentities } from "../crm/contact.js";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";

/** One target per call, so every write about one call names the same target. */
export const voiceCallTargetId = (tenantId: string, callSid: string) => derivedId(tenantId, callSid, "voice-call");

async function resolveVoiceCall(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "voice_call") throw new ValidationFailed("Voice actions require a voice_call target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  return { tenantId, type: "voice_call", id: target.id };
}

function requireCallTarget(command: { target: Target }, tenantId: string, callSid: string) {
  if (command.target.id !== voiceCallTargetId(tenantId, callSid)) throw new ValidationFailed("Target must name the call");
}

interface CallRow {
  from_e164: string | null;
  to_e164: string;
  dial_status: string | null;
  offered: boolean | null;
  offer_reason: string | null;
  mailbox_open: boolean | null;
  disclosure_version: string | null;
}
const callColumns = "from_e164, to_e164, dial_status, offered, offer_reason, mailbox_open, disclosure_version";

async function lockCall(tx: Transaction, tenantId: string, callSid: string): Promise<CallRow | null> {
  return (await tx.query<CallRow>(
    `SELECT ${callColumns} FROM voice_calls WHERE tenant_id=$1 AND call_sid=$2 FOR UPDATE`, [tenantId, callSid])).rows[0] ?? null;
}

export const voiceCallHandler: ActionHandler = {
  resolveTarget: resolveVoiceCall,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(voiceCallCommandSchema, command);
    const tenantId = binding.tenantId;
    requireCallTarget(command, tenantId, payload.callSid);
    if (payload.step === "incoming") {
      // T-10: the call row exists only for the tenant's own number.
      const number = (await tx.query<{ phone_number: string }>(
        "SELECT phone_number FROM voice_numbers WHERE tenant_id=$1", [tenantId])).rows[0];
      if (!number || number.phone_number !== payload.to) throw new NotFound();
      const written = await tx.query(
        `INSERT INTO voice_calls (tenant_id, call_sid, from_e164, to_e164, incoming_twiml, created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, call_sid) DO NOTHING`,
        [tenantId, payload.callSid, payload.from, payload.to, payload.twiml, now]);
      const row = (await lockCall(tx, tenantId, payload.callSid))!;
      const result: VoiceCallResult = {
        callSid: payload.callSid, step: "incoming", recorded: written.rowCount === 1,
        offered: row.offered, offerReason: row.offer_reason as VoiceCallResult["offerReason"], mailboxOpen: row.mailbox_open,
      };
      return { result: { ...result } };
    }
    // T-11, T-14: the dial step's decision is stored once; a concurrent twin reads the winner's.
    const row = await lockCall(tx, tenantId, payload.callSid);
    if (!row) throw new NotFound();
    if (payload.offered && (row.from_e164 === null || !payload.mailboxOpen || payload.disclosureVersion === null))
      throw new ValidationFailed("A call without a caller number or a mailbox cannot be offered the text");
    let recorded = false;
    if (row.dial_status === null) {
      await tx.query(
        `UPDATE voice_calls SET dial_status=$3, offered=$4, offer_reason=$5, mailbox_open=$6, disclosure_version=$7
          WHERE tenant_id=$1 AND call_sid=$2`,
        [tenantId, payload.callSid, payload.dialStatus, payload.offered, payload.offerReason, payload.mailboxOpen,
          payload.offered ? payload.disclosureVersion : null]);
      recorded = true;
    }
    const result: VoiceCallResult = {
      callSid: payload.callSid, step: "dial", recorded,
      offered: recorded ? payload.offered : row.offered,
      offerReason: (recorded ? payload.offerReason : row.offer_reason) as VoiceCallResult["offerReason"],
      mailboxOpen: recorded ? payload.mailboxOpen : row.mailbox_open,
    };
    return { result: { ...result } };
  },
};

/** T-12: the SMS body. The delivery worker adds the opt-out line (D-9), so it is not stored twice. */
export const textbackBody = (businessName: string, bookingUrl: string) => `${businessName}: Book here: ${bookingUrl}`;

export const voiceOptinHandler: ActionHandler = {
  resolveTarget: resolveVoiceCall,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(voiceOptinCommandSchema, command);
    const tenantId = binding.tenantId;
    requireCallTarget(command, tenantId, payload.callSid);
    const call = await lockCall(tx, tenantId, payload.callSid);
    if (!call) throw new NotFound();
    // T-12: only an offered call with a caller number can opt in.
    if (call.offered !== true || call.from_e164 === null) throw new Conflict("The call was not offered the text", { reason: "not_offered" });
    const caller = call.from_e164;
    if (call.disclosure_version !== payload.disclosureVersion)
      throw new Conflict("The offer named other wording", { reason: "disclosure_changed" });
    const disclosure = (await tx.query<{ text: string }>(
      "SELECT text FROM voice_textback_disclosures WHERE tenant_id=$1 AND version=$2", [tenantId, payload.disclosureVersion])).rows[0];
    if (!disclosure) throw new NotFound();
    const setup = (await tx.query<{ booking_url: string | null; name: string }>(
      `SELECT v.booking_url, t.name FROM voice_numbers v JOIN tenants t ON t.tenant_id=v.tenant_id WHERE v.tenant_id=$1`, [tenantId])).rows[0];
    if (!setup || setup.booking_url === null) throw new Conflict("The tenant has no booking link to send", { reason: "text_back_off" });

    // C-5, C-6: the contact with this number, or a phone-only one (identity locks as the CRM action takes them).
    await lockIdentities(tx, tenantId, { email: null, phone: caller, contactId: payload.contactId });
    const existing = (await tx.query<{ id: string }>(
      "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND e164_phone=$2 ORDER BY id LIMIT 1 FOR UPDATE", [tenantId, caller])).rows[0];
    const contactId = existing?.id ?? payload.contactId;
    if (!existing) {
      // The candidate ID derives from this call; an unrelated contact holding it is a real conflict.
      if ((await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rowCount)
        throw new Conflict("The contact ID is already in use", { reason: "id_in_use" });
      await tx.query(
        `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
         VALUES ($1,$2,NULL,NULL,$3,$4,$4)`, [tenantId, contactId, caller, now]);
    }

    // C-10 fill-only: a recorded grant stays, a recorded denial is never replaced.
    const consent = (await tx.query<{ status: string }>(
      "SELECT status FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id=$2 AND channel='sms'", [tenantId, contactId])).rows[0];
    if (consent?.status === "denied") {
      const denied: VoiceOptinResult = { callSid: payload.callSid, outcome: "denied", contactId, messageId: null };
      return { result: { ...denied } };
    }
    await tx.query(
      `INSERT INTO voice_textback_consents (tenant_id, call_sid, contact_id, caller_e164, disclosure_version, disclosure_text, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, payload.callSid, contactId, caller, payload.disclosureVersion, disclosure.text, now]);
    if (!consent) {
      await tx.query(
        `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
         VALUES ($1,$2,'sms','granted',$3,$4)`, [tenantId, contactId, `twilio-voice:${payload.callSid}`, now]);
      // C-12: a filled-in consent counts as a change to the contact.
      if (existing) await tx.query("UPDATE crm_contacts SET updated_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, contactId, now]);
    }

    // D-1: the stored consent, the action and this event commit together; D-6 re-checks at delivery.
    const event: MessageSendRequested = {
      messageId: payload.messageId, contactId, channel: "sms", purpose: "transactional", subject: null,
      body: textbackBody(setup.name, setup.booking_url),
    };
    const requested: VoiceOptinResult = { callSid: payload.callSid, outcome: "requested", contactId, messageId: payload.messageId };
    return { result: { ...requested }, event: { type: MESSAGE_SEND_REQUESTED, payload: { ...event } } };
  },
};

export const voiceVoicemailHandler: ActionHandler = {
  resolveTarget: resolveVoiceCall,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(voiceVoicemailCommandSchema, command);
    const tenantId = binding.tenantId;
    requireCallTarget(command, tenantId, payload.callSid);
    const call = await lockCall(tx, tenantId, payload.callSid);
    if (!call) throw new NotFound();
    // T-14: a recording follows only a call whose mailbox the dial step opened.
    if (call.mailbox_open !== true) throw new Conflict("The call has no open mailbox", { reason: "mailbox_closed" });
    // T-13: the contact that already has the number (the opt-in made it, if it did); never a new one.
    const contact = call.from_e164 === null ? undefined : (await tx.query<{ id: string }>(
      "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND e164_phone=$2 ORDER BY id LIMIT 1", [tenantId, call.from_e164])).rows[0];
    const expires = new Date(now.getTime() + VOICEMAIL_AUDIO_DAYS * 86_400_000);
    const written = await tx.query(
      `INSERT INTO voicemails (tenant_id, id, call_sid, caller_e164, contact_id, recording_sid, duration_seconds, status, recorded_at, audio_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8,$9) ON CONFLICT (tenant_id, call_sid) DO NOTHING`,
      [tenantId, payload.voicemailId, payload.callSid, call.from_e164, contact?.id ?? null, payload.recordingSid,
        payload.durationSeconds, now, expires]);
    const stored = (await tx.query<{ id: string; contact_id: string | null }>(
      "SELECT id, contact_id FROM voicemails WHERE tenant_id=$1 AND call_sid=$2", [tenantId, payload.callSid])).rows[0]!;
    const result: VoiceVoicemailResult = {
      callSid: payload.callSid, voicemailId: stored.id, contactId: stored.contact_id, recorded: written.rowCount === 1,
    };
    return { result: { ...result } };
  },
};

export const voiceHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [VOICE_CALL_RECORD_ACTION]: voiceCallHandler,
  [VOICE_TEXTBACK_OPTIN_ACTION]: voiceOptinHandler,
  [VOICE_VOICEMAIL_RECORD_ACTION]: voiceVoicemailHandler,
});
