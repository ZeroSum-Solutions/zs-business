// M3d stop paths (delivery.md D-9). Like the public intake session, the tenant comes from a
// signed token (email) or from the server's own mapping of a provider number (SMS, M5), never
// from the request body, and the server builds a principal that may run only the suppression
// action it needs.
import {
  inboundSmsSchema,
  NotFound,
  SUPPRESSION_LIFT_ACTION,
  SUPPRESSION_RECORD_ACTION,
  TenantDenied,
  uuidSchema,
  type DeliveryChannel,
  type InboundSmsReply,
  type SuppressionResult,
} from "@zs/contracts";
import { liftSuppression, recordSuppression, smsKeyword, suppressionTargetId } from "../delivery/suppression.js";
import { verifyUnsubscribeToken, type UnsubscribeSecrets } from "../delivery/unsubscribe.js";
import { derivedId } from "./ids.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies } from "./session.js";

export const unsubscribeActorId = (tenantId: string) => derivedId(tenantId, "public-unsubscribe", "actor");
export const inboundSmsActorId = (tenantId: string) => derivedId(tenantId, "inbound-sms", "actor");

const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

export function createUnsubscribeSession(deps: EdgeDependencies, secrets: UnsubscribeSecrets) {
  /** The delivery a token names and where it went; a forged token and an unknown delivery look the same. */
  async function resolve(token: string) {
    const ref = verifyUnsubscribeToken(secrets, token);
    if (!ref) throw new NotFound();
    const row = await deps.db.tenant(ref.tenantId, async (tx) => (await tx.query<{ channel: DeliveryChannel; recipient_address: string | null }>(
      "SELECT channel, recipient_address FROM message_deliveries WHERE tenant_id=$1 AND id=$2",
      [ref.tenantId, ref.deliveryId])).rows[0]);
    if (!row || row.channel !== "email" || !row.recipient_address) throw new NotFound();
    return { ref, address: row.recipient_address };
  }

  return {
    /** For the confirmation page a GET shows; it never changes anything. */
    check: async (token: string): Promise<{ valid: true }> => {
      await resolve(token);
      return { valid: true };
    },
    /** RFC 8058 one-click: suppress the address the delivery went to. A repeat replays. */
    unsubscribe: async (token: string): Promise<SuppressionResult> => {
      const { ref, address } = await resolve(token);
      const tenantId = ref.tenantId;
      const idempotencyKey = `unsubscribe:${ref.deliveryId}`;
      const run = directDispatch(deps, tenantId, unsubscribeActorId(tenantId), only(SUPPRESSION_RECORD_ACTION));
      return recordSuppression({
        actionType: SUPPRESSION_RECORD_ACTION,
        target: { tenantId, type: "suppression", id: suppressionTargetId(tenantId, "email", address) },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: { channel: "email", address, reason: "unsubscribe", source: `email:${ref.deliveryId}` },
      }, { dispatch: run });
    },
  };
}

export interface InboundSmsReplies {
  readonly stop: string;
  readonly start: string;
  readonly help: string;
}
export const DEFAULT_SMS_REPLIES: InboundSmsReplies = Object.freeze({
  stop: "You are unsubscribed and will get no more messages. Reply START to resubscribe.",
  start: "You are resubscribed. Reply STOP to opt out.",
  help: "Reply STOP to opt out. Reply START to resubscribe.",
});

/**
 * D-9: an inbound SMS for one tenant. The tenant comes from the server's mapping of the
 * receiving number (M5 webhooks); the provider message ID keys the action, so a redelivered
 * webhook replays instead of acting twice.
 */
export function createInboundSmsSession(deps: EdgeDependencies, tenant: string, replies: InboundSmsReplies = DEFAULT_SMS_REPLIES) {
  const tenantId = uuidSchema.parse(tenant);
  const run = directDispatch(deps, tenantId, inboundSmsActorId(tenantId), only(SUPPRESSION_RECORD_ACTION, SUPPRESSION_LIFT_ACTION));
  return {
    async receive(body: unknown): Promise<InboundSmsReply> {
      const message = parseInput(inboundSmsSchema, body, "inbound message");
      const keyword = smsKeyword(message.body);
      if (keyword === null) return { keyword: null, reply: null };
      if (keyword === "help") return { keyword, reply: replies.help };
      const idempotencyKey = `sms-inbound:${message.providerMessageId}`;
      const envelope = {
        target: { tenantId, type: "suppression", id: suppressionTargetId(tenantId, "sms", message.from) },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
      };
      const source = `sms:${message.providerMessageId}`;
      if (keyword === "stop") {
        await recordSuppression({ actionType: SUPPRESSION_RECORD_ACTION, ...envelope,
          payload: { channel: "sms", address: message.from, reason: "stop", source } }, { dispatch: run });
        return { keyword, reply: replies.stop };
      }
      const lifted = await liftSuppression({ actionType: SUPPRESSION_LIFT_ACTION, ...envelope,
        payload: { channel: "sms", address: message.from, reason: "stop", source } }, { dispatch: run });
      // A number listed for another reason (a carrier block, an owner's manual entry) stays listed.
      return { keyword, reply: lifted.suppressed ? null : replies.start };
    },
  };
}
