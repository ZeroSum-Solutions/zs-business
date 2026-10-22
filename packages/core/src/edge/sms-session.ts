// M5 Twilio webhooks (docs/requirements/twilio.md T-6, T-8). Like the email feedback session, the
// tenant (and for a status, the delivery) comes from the URL this system gave Twilio, which the
// route has already checked the signature over, and is checked against that tenant's own rows under
// its scope. The server builds a principal that may run only the actions each webhook needs.
import {
  SMS_STATUS_RECORD_ACTION,
  SUPPRESSION_RECORD_ACTION,
  TenantDenied,
  contactPhoneSchema,
  uuidSchema,
  type SmsStatusResult,
} from "@zs/contracts";
import { recordSmsStatus } from "../delivery/sms-status.js";
import { recordSuppression, smsKeyword, suppressionTargetId } from "../delivery/suppression.js";
import { TWILIO_OPTED_OUT_ERROR, type TwilioInbound, type TwilioStatusCallback } from "../delivery/twilio-webhook.js";
import { createInboundSmsSession, type InboundSmsReplies } from "./delivery-session.js";
import { derivedId } from "./ids.js";
import { directDispatch, type Authorize, type EdgeDependencies } from "./session.js";

export const smsStatusActorId = (tenantId: string) => derivedId(tenantId, "sms-status", "actor");

const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

export type SmsStatusOutcome =
  | { readonly handled: true; readonly result: SmsStatusResult; readonly suppressed: boolean }
  | { readonly handled: false; readonly reason: string };

export function createSmsStatusSession(deps: EdgeDependencies, options: { readonly providerName?: string } = {}) {
  const providerName = options.providerName ?? "twilio";
  return {
    /** T-6: one signed status for the delivery the callback URL names. A repeat replays. */
    async receive(tenant: string, delivery: string, callback: TwilioStatusCallback): Promise<SmsStatusOutcome> {
      const tenantId = uuidSchema.safeParse(tenant);
      const deliveryId = uuidSchema.safeParse(delivery);
      if (!tenantId.success || !deliveryId.success) return { handled: false, reason: "unknown_delivery" };
      const scope = { tenantId: tenantId.data, deliveryId: deliveryId.data };
      const found = await deps.db.tenant(scope.tenantId, async (tx) => {
        const row = (await tx.query<{ recipient_address: string | null; provider_message_id: string | null }>(
          `SELECT recipient_address, provider_message_id FROM message_deliveries
            WHERE tenant_id=$1 AND id=$2 AND channel='sms' AND provider=$3`,
          [scope.tenantId, scope.deliveryId, providerName])).rows[0];
        const other = (await tx.query(
          "SELECT 1 FROM sms_status_events WHERE tenant_id=$1 AND delivery_id=$2 AND provider_message_id<>$3 LIMIT 1",
          [scope.tenantId, scope.deliveryId, callback.MessageSid])).rowCount === 1;
        return row ? { ...row, other } : null;
      });
      if (!found || !found.recipient_address) return { handled: false, reason: "unknown_delivery" };
      if (found.recipient_address !== callback.To) return { handled: false, reason: "recipient_mismatch" };
      if ((found.provider_message_id !== null && found.provider_message_id !== callback.MessageSid) || found.other)
        return { handled: false, reason: "message_mismatch" };
      const run = directDispatch(deps, scope.tenantId, smsStatusActorId(scope.tenantId),
        only(SMS_STATUS_RECORD_ACTION, SUPPRESSION_RECORD_ACTION));
      const statusKey = `sms-status:${callback.MessageSid}:${callback.MessageStatus}`;
      const result = await recordSmsStatus({
        actionType: SMS_STATUS_RECORD_ACTION,
        target: { tenantId: scope.tenantId, type: "delivery", id: scope.deliveryId },
        approvalReference: { tenantId: scope.tenantId, id: derivedId(scope.tenantId, statusKey, "approval") },
        idempotencyKey: statusKey,
        payload: {
          deliveryId: scope.deliveryId, providerMessageId: callback.MessageSid,
          status: callback.MessageStatus, errorCode: callback.ErrorCode,
        },
      }, { dispatch: run });
      // The recipient opted out at Twilio (a STOP this system did not see): stop here too.
      let suppressed = false;
      if (callback.ErrorCode === TWILIO_OPTED_OUT_ERROR) {
        const stopKey = `sms-status:${callback.MessageSid}:stop`;
        const address = found.recipient_address;
        await recordSuppression({
          actionType: SUPPRESSION_RECORD_ACTION,
          target: { tenantId: scope.tenantId, type: "suppression", id: suppressionTargetId(scope.tenantId, "sms", address) },
          approvalReference: { tenantId: scope.tenantId, id: derivedId(scope.tenantId, stopKey, "approval") },
          idempotencyKey: stopKey,
          payload: { channel: "sms", address, reason: "stop", source: `${providerName}:${callback.MessageSid}` },
        }, { dispatch: run });
        suppressed = true;
      }
      return { handled: true, result, suppressed };
    },
  };
}
export type SmsStatusSession = ReturnType<typeof createSmsStatusSession>;

/** T-8: who answers STOP, START and HELP. */
export type KeywordReplies = "provider" | "app";

/** T-8: the replies for one tenant, naming the business as carriers require. */
export function tenantSmsReplies(name: string, helpReply: string | null): InboundSmsReplies {
  return {
    stop: `${name}: You are unsubscribed and will get no more messages. Reply START to resubscribe.`,
    start: `${name}: You are resubscribed. Reply STOP to opt out.`,
    help: helpReply ?? `${name}: Reply STOP to opt out, START to resubscribe. Msg & data rates may apply.`,
  };
}

export type InboundTextOutcome =
  | { readonly handled: true; readonly keyword: "stop" | "start" | "help"; readonly reply: string | null }
  | { readonly handled: false; readonly reason: string };

export function createTwilioInboundSession(deps: EdgeDependencies, options: { readonly keywordReplies?: KeywordReplies } = {}) {
  const keywordReplies = options.keywordReplies ?? "provider";
  return {
    /** T-6, T-8: a signed inbound text to the number of the tenant the URL names. */
    async receive(tenant: string, message: TwilioInbound): Promise<InboundTextOutcome> {
      const tenantId = uuidSchema.safeParse(tenant);
      if (!tenantId.success) return { handled: false, reason: "unknown_number" };
      // Only the keyword texts change anything; others are not stored yet.
      if (smsKeyword(message.Body) === null) return { handled: false, reason: "not_a_keyword" };
      const number = await deps.db.tenant(tenantId.data, async (tx) => (await tx.query<{
        phone_number: string; help_reply: string | null; name: string;
      }>(
        `SELECT n.phone_number, n.help_reply, t.name FROM sms_numbers n JOIN tenants t ON t.tenant_id=n.tenant_id
          WHERE n.tenant_id=$1`, [tenantId.data])).rows[0]);
      if (!number || number.phone_number !== message.To) return { handled: false, reason: "unknown_number" };
      if (!contactPhoneSchema.safeParse(message.From).success) return { handled: false, reason: "sender_not_e164" };
      // With Twilio's own opt-out handling on, it has answered already; a second reply would be noise.
      const replies = keywordReplies === "app" ? tenantSmsReplies(number.name, number.help_reply) : null;
      const session = createInboundSmsSession(deps, tenantId.data, replies);
      const result = await session.receive({ from: message.From, body: message.Body, providerMessageId: message.MessageSid });
      if (result.keyword === null) return { handled: false, reason: "not_a_keyword" };
      return { handled: true, keyword: result.keyword, reply: result.reply };
    },
  };
}
export type TwilioInboundSession = ReturnType<typeof createTwilioInboundSession>;
