// Missed-call text-back webhooks (docs/requirements/twilio.md T-10..T-14). Like the SMS sessions,
// the tenant comes from the URL this system gave Twilio (the route has already checked the
// signature over it) and is checked against that tenant's own rows under its scope. The server
// builds a principal that may run only the three voice actions. Original code.
import {
  ActionError,
  IdempotencyConflict,
  MISSED_DIAL_STATUSES,
  TenantDenied,
  VOICE_CALL_RECORD_ACTION,
  VOICE_TEXTBACK_OPTIN_ACTION,
  VOICE_VOICEMAIL_RECORD_ACTION,
  callSidSchema,
  dialStatusSchema,
  recordingSidSchema,
  uuidSchema,
  voiceDisclosureVersionSchema,
  voiceOptinResultSchema,
  voiceVoicemailResultSchema,
  contactPhoneSchema,
  type ActionCommand,
  type DialStatus,
  type JsonValue,
  type OfferReason,
} from "@zs/contracts";
import { parseOrFail } from "../crm/rows.js";
import { voiceCallTargetId } from "../voice/actions.js";
import { dial, gather, hangup, record, say, voiceResponse } from "../voice/twiml.js";
import { retryableAsUnavailable } from "./errors.js";
import { derivedId } from "./ids.js";
import { directDispatch, trimTrailingSlashes, type Authorize, type EdgeDependencies } from "./session.js";

export const voiceActorId = (tenantId: string) => derivedId(tenantId, "twilio-voice", "actor");

const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

/** T-14: a bucket and its rule. The API adapts its rate limiter to this port. */
export interface VoiceCharge {
  readonly key: string;
  readonly rule: { readonly limit: number; readonly windowMs: number };
}
export interface VoiceLimiter {
  /** All buckets are checked before any is charged; a refusal consumes nothing. A throw means "cannot answer". */
  take(charges: readonly VoiceCharge[]): Promise<{ readonly ok: boolean }>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** T-14 defaults. */
export const VOICE_LIMITS = Object.freeze({
  offerPerCaller: { limit: 1, windowMs: DAY },
  offerPerTenant: { limit: 100, windowMs: DAY },
  voicemailPerCaller: { limit: 5, windowMs: HOUR },
  voicemailPerTenant: { limit: 200, windowMs: DAY },
});

export interface VoiceSessionOptions {
  /** The API's public origin as Twilio calls it; the callback URLs in the TwiML are built from it. */
  readonly webhookBaseUrl: string;
  readonly limiter: VoiceLimiter;
}

export interface VoiceIncoming { readonly CallSid: string; readonly From: string; readonly To: string }

/** A refusal by the action (changed wording, closed mailbox) is answered quietly; a busy database is not: Twilio retries on 503. */
function refusal(error: unknown): void {
  if (!(error instanceof ActionError)) throw error;
  const retry = retryableAsUnavailable(error);
  if (retry !== error) throw retry;
}

const MAILBOX_FULL = "Our mailbox is full. Please try again later. Goodbye.";
const CANNOT_ANSWER = "We cannot take your call right now. Please try again later. Goodbye.";
const MESSAGE_PROMPT = "Sorry we missed your call. Please leave a message after the beep.";
const TEXT_ON_ITS_WAY = "Thank you. Your booking link is on its way by text.";

interface Setup {
  readonly phone: string;
  readonly forward: string;
  readonly ringSeconds: number;
  readonly enabled: boolean;
  readonly bookingUrl: string | null;
  readonly disclosureVersion: string | null;
  readonly name: string;
}
interface Call {
  readonly from: string | null;
  readonly dialStatus: string | null;
  readonly offered: boolean | null;
  readonly offerReason: OfferReason | null;
  readonly mailboxOpen: boolean | null;
  readonly disclosureVersion: string | null;
  readonly incomingTwiml: string;
}

export function createVoiceSession(deps: EdgeDependencies, options: VoiceSessionOptions) {
  const base = trimTrailingSlashes(options.webhookBaseUrl);
  const { limiter } = options;
  const url = (tenantId: string, path: string) => `${base}/webhooks/twilio/voice/${tenantId}${path}`;

  const run = (tenantId: string) => directDispatch(deps, tenantId, voiceActorId(tenantId),
    only(VOICE_CALL_RECORD_ACTION, VOICE_TEXTBACK_OPTIN_ACTION, VOICE_VOICEMAIL_RECORD_ACTION));

  /** The dispatcher command for one step: IDs derive from tenant and key, so a replay rebuilds it exactly. */
  const command = (tenantId: string, callSid: string, step: string, actionType: string, payload: JsonValue): ActionCommand => {
    const idempotencyKey = `twilio-voice:${callSid}:${step}`;
    return {
      actionType,
      target: { tenantId, type: "voice_call", id: voiceCallTargetId(tenantId, callSid) },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
      payload,
    };
  };

  const loadSetup = (tenantId: string): Promise<Setup | null> => deps.db.tenant(tenantId, async (tx) => {
    const row = (await tx.query<{
      phone_number: string; forward_to_e164: string; ring_seconds: number; textback_enabled: boolean;
      booking_url: string | null; disclosure_version: string | null; name: string;
    }>(`SELECT v.phone_number, v.forward_to_e164, v.ring_seconds, v.textback_enabled, v.booking_url, v.disclosure_version, t.name
          FROM voice_numbers v JOIN tenants t ON t.tenant_id=v.tenant_id WHERE v.tenant_id=$1`, [tenantId])).rows[0];
    return row ? {
      phone: row.phone_number, forward: row.forward_to_e164, ringSeconds: row.ring_seconds, enabled: row.textback_enabled,
      bookingUrl: row.booking_url, disclosureVersion: row.disclosure_version, name: row.name,
    } : null;
  });

  const loadCall = (tenantId: string, callSid: string): Promise<Call | null> => deps.db.tenant(tenantId, async (tx) => {
    const row = (await tx.query<{
      from_e164: string | null; dial_status: string | null; offered: boolean | null; offer_reason: OfferReason | null;
      mailbox_open: boolean | null; disclosure_version: string | null; incoming_twiml: string;
    }>(`SELECT from_e164, dial_status, offered, offer_reason, mailbox_open, disclosure_version, incoming_twiml
          FROM voice_calls WHERE tenant_id=$1 AND call_sid=$2`, [tenantId, callSid])).rows[0];
    return row ? {
      from: row.from_e164, dialStatus: row.dial_status, offered: row.offered, offerReason: row.offer_reason,
      mailboxOpen: row.mailbox_open, disclosureVersion: row.disclosure_version, incomingTwiml: row.incoming_twiml,
    } : null;
  });

  /** T-11: a SMS suppression on the number, or a recorded SMS denial on the contact that has it. */
  const smsBlocked = (tenantId: string, number: string): Promise<"suppressed" | "sms_denied" | null> =>
    deps.db.tenant(tenantId, async (tx) => {
      if ((await tx.query("SELECT 1 FROM suppressions WHERE tenant_id=$1 AND channel='sms' AND address=$2", [tenantId, number])).rowCount)
        return "suppressed";
      const denied = await tx.query(
        `SELECT 1 FROM crm_contacts c JOIN crm_contact_consent k ON k.tenant_id=c.tenant_id AND k.contact_id=c.id
          WHERE c.tenant_id=$1 AND c.e164_phone=$2 AND k.channel='sms' AND k.status='denied'`, [tenantId, number]);
      return denied.rowCount ? "sms_denied" : null;
    });

  const disclosureText = (tenantId: string, version: string): Promise<string | null> => deps.db.tenant(tenantId, async (tx) =>
    (await tx.query<{ text: string }>("SELECT text FROM voice_textback_disclosures WHERE tenant_id=$1 AND version=$2",
      [tenantId, version])).rows[0]?.text ?? null);

  /** T-13: the voicemail prompt and the recording verb. */
  const voicemail = (tenantId: string) => [
    say(MESSAGE_PROMPT),
    record({ action: url(tenantId, "/recording?step=done"), statusCallback: url(tenantId, "/recording"), maxLength: 120, timeout: 5 }),
  ];

  /** The answer the stored decision calls for; the same stored row always gives the same answer. */
  async function answerFor(tenantId: string, call: Call): Promise<string> {
    if (call.offerReason === "limiter_unavailable") return voiceResponse(say(CANNOT_ANSWER), hangup());
    if (call.offerReason === "mailbox_full") return voiceResponse(say(MAILBOX_FULL), hangup());
    if (call.mailboxOpen !== true) return voiceResponse(hangup());
    if (call.offered === true && call.disclosureVersion !== null) {
      const text = await disclosureText(tenantId, call.disclosureVersion);
      if (text !== null)
        return voiceResponse(
          gather(say(text), { action: url(tenantId, `/gather?v=${encodeURIComponent(call.disclosureVersion)}`), timeout: 6 }),
          ...voicemail(tenantId));
    }
    return voiceResponse(...voicemail(tenantId));
  }

  /** A charge that cannot be answered is "no", never an error the caller hears (T-14). */
  async function charge(charges: readonly VoiceCharge[]): Promise<"ok" | "refused" | "unavailable"> {
    try {
      return (await limiter.take(charges)).ok ? "ok" : "refused";
    } catch {
      return "unavailable";
    }
  }

  return {
    /** T-10: a call to the tenant's number rings the forward-to number. */
    async incoming(tenant: string, call: VoiceIncoming): Promise<string> {
      const tenantId = uuidSchema.safeParse(tenant);
      const callSid = callSidSchema.safeParse(call.CallSid);
      if (!tenantId.success || !callSid.success) return voiceResponse(hangup());
      const setup = await loadSetup(tenantId.data);
      if (!setup || setup.phone !== call.To) return voiceResponse(hangup());
      // T-14: a repeated webhook replays the stored answer, whatever the settings are now.
      const known = await loadCall(tenantId.data, callSid.data);
      if (known) return known.incomingTwiml;
      const from = contactPhoneSchema.safeParse(call.From);
      const answer = voiceResponse(dial(setup.forward, {
        timeout: setup.ringSeconds,
        ...(setup.enabled ? { action: url(tenantId.data, "/dial") } : {}),
      }));
      try {
        await run(tenantId.data)(command(tenantId.data, callSid.data, "call", VOICE_CALL_RECORD_ACTION, {
          step: "incoming", callSid: callSid.data, from: from.success ? from.data : null, to: setup.phone, twiml: answer,
        }));
      } catch (error) {
        // A concurrent twin stored its answer first: replay that one.
        if (!(error instanceof IdempotencyConflict)) throw error;
        const stored = await loadCall(tenantId.data, callSid.data);
        if (stored) return stored.incomingTwiml;
      }
      return answer;
    },

    /** T-11, T-14: the dial leg ended; decide once whether to offer the text and open the mailbox. */
    async dial(tenant: string, input: { readonly CallSid: string; readonly DialCallStatus: string }): Promise<string> {
      const tenantId = uuidSchema.safeParse(tenant);
      const callSid = callSidSchema.safeParse(input.CallSid);
      const status = dialStatusSchema.safeParse(input.DialCallStatus);
      if (!tenantId.success || !callSid.success || !status.success) return voiceResponse(hangup());
      // T-14: one callback at a time per call, across instances, so the limits are charged once and a
      // twin waits for the stored decision. The lock lives in this transaction; the work uses its own.
      return deps.db.tenant(tenantId.data, async (lock) => {
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`voice-dial:${tenantId.data}:${callSid.data}`]);
      let call = await loadCall(tenantId.data, callSid.data);
      if (!call) return voiceResponse(hangup());
      // A repeated callback answers from the stored decision and charges nothing again.
      if (call.dialStatus !== null) return answerFor(tenantId.data, call);

      const setup = (await loadSetup(tenantId.data))!;
      const decided = await decide(tenantId.data, call, setup, status.data);
      try {
        await run(tenantId.data)(command(tenantId.data, callSid.data, "dial", VOICE_CALL_RECORD_ACTION, {
          step: "dial", callSid: callSid.data, dialStatus: status.data, offered: decided.offered,
          offerReason: decided.reason, mailboxOpen: decided.mailboxOpen, disclosureVersion: decided.version,
        }));
      } catch (error) {
        // A concurrent twin decided first (its payload differed): answer from what it stored.
        if (!(error instanceof IdempotencyConflict)) throw error;
      }
      call = await loadCall(tenantId.data, callSid.data);
      return call ? answerFor(tenantId.data, call) : voiceResponse(hangup());
      });
    },

    /** T-12: the caller pressed a key. Only `1` on an offered call opts in. */
    async gather(tenant: string, input: { readonly CallSid: string; readonly Digits: string | undefined }, version: string | undefined): Promise<string> {
      const tenantId = uuidSchema.safeParse(tenant);
      const callSid = callSidSchema.safeParse(input.CallSid);
      if (!tenantId.success || !callSid.success) return voiceResponse(hangup());
      const call = await loadCall(tenantId.data, callSid.data);
      if (!call || call.mailboxOpen !== true) return voiceResponse(hangup());
      const signedVersion = voiceDisclosureVersionSchema.safeParse(version);
      if (input.Digits === "1" && call.offered === true && call.from !== null && signedVersion.success
        && call.disclosureVersion === signedVersion.data) {
        try {
          const output = await run(tenantId.data)(command(tenantId.data, callSid.data, "optin", VOICE_TEXTBACK_OPTIN_ACTION, {
            callSid: callSid.data,
            contactId: derivedId(tenantId.data, callSid.data, "contact"),
            messageId: derivedId(tenantId.data, callSid.data, "message"),
            disclosureVersion: signedVersion.data,
          }));
          // Only now, with the opt-in committed, may the caller hear that a text is coming (T-10).
          if (parseOrFail(voiceOptinResultSchema, output.result).outcome === "requested")
            return voiceResponse(say(TEXT_ON_ITS_WAY), ...voicemail(tenantId.data));
        } catch (error) {
          // A refusal (changed wording, no booking link) sends nothing; database errors still propagate.
          refusal(error);
        }
      }
      // No press, another key, a denial or a refusal: nothing is written and nothing is sent.
      return voiceResponse(...voicemail(tenantId.data));
    },

    /** T-13: `step=done` is the Record action (hang up); otherwise the status callback files the voicemail. */
    async recording(tenant: string, input: {
      readonly CallSid: string; readonly RecordingSid?: string | undefined; readonly RecordingStatus?: string | undefined;
      readonly RecordingDuration?: string | undefined;
    }, step: string | undefined): Promise<string> {
      if (step === "done") return voiceResponse(hangup());
      const tenantId = uuidSchema.safeParse(tenant);
      const callSid = callSidSchema.safeParse(input.CallSid);
      const recordingSid = recordingSidSchema.safeParse(input.RecordingSid);
      const seconds = /^[0-9]{1,6}$/.test(input.RecordingDuration ?? "") ? Number(input.RecordingDuration) : 0;
      if (!tenantId.success || !callSid.success || !recordingSid.success || input.RecordingStatus !== "completed" || seconds < 1)
        return voiceResponse();
      try {
        const output = await run(tenantId.data)(command(tenantId.data, callSid.data, "voicemail", VOICE_VOICEMAIL_RECORD_ACTION, {
          callSid: callSid.data,
          voicemailId: derivedId(tenantId.data, callSid.data, "voicemail"),
          recordingSid: recordingSid.data,
          durationSeconds: Math.min(seconds, 600),
        }));
        parseOrFail(voiceVoicemailResultSchema, output.result);
      } catch (error) {
        // A call with no open mailbox, an unknown call or a second recording for one call changes nothing.
        refusal(error);
      }
      return voiceResponse();
    },
  };

  /** T-11, T-14: the decision for a call whose dial leg just ended. Limits are charged here, once. */
  async function decide(tenantId: string, call: Call, setup: Setup, status: DialStatus): Promise<{
    offered: boolean; reason: OfferReason; mailboxOpen: boolean; version: string | null;
  }> {
    const no = (reason: OfferReason, mailboxOpen = false) => ({ offered: false, reason, mailboxOpen, version: null });
    if (status === "completed") return no("answered");
    if (status === "canceled") return no("canceled");
    if (!(MISSED_DIAL_STATUSES as readonly string[]).includes(status) || !setup.enabled) return no("disabled");
    const who = call.from ?? "withheld";
    // T-14: the mailbox first. A full mailbox or a limiter that cannot answer ends the call politely.
    const mailbox = await charge([
      { key: `voice-mail:${tenantId}:${who}`, rule: VOICE_LIMITS.voicemailPerCaller },
      { key: `voice-mail-tenant:${tenantId}`, rule: VOICE_LIMITS.voicemailPerTenant },
    ]);
    if (mailbox === "refused") return no("mailbox_full");
    if (mailbox === "unavailable") return no("limiter_unavailable");
    if (call.from === null) return no("no_caller_number", true);
    if (setup.bookingUrl === null || setup.disclosureVersion === null) return no("disabled", true);
    const blocked = await smsBlocked(tenantId, call.from);
    if (blocked !== null) return no(blocked, true);
    const offer = await charge([
      { key: `voice-offer:${tenantId}:${call.from}`, rule: VOICE_LIMITS.offerPerCaller },
      { key: `voice-offer-tenant:${tenantId}`, rule: VOICE_LIMITS.offerPerTenant },
    ]);
    if (offer === "refused") return no("limit", true);
    if (offer === "unavailable") return no("limiter_unavailable");
    return { offered: true, reason: "offered", mailboxOpen: true, version: setup.disclosureVersion };
  }
}
export type VoiceSession = ReturnType<typeof createVoiceSession>;
