// M5 email feedback (docs/requirements/resend.md R-8). A signed Resend webhook about a bounce or
// complaint suppresses the address that delivery went to. Like the unsubscribe session, the tenant
// and delivery come from what this system sent (the tags on the email) and are checked against the
// delivery row under that tenant's own scope; the server builds a principal that may record the
// one suppression only.
import { SUPPRESSION_RECORD_ACTION, TenantDenied, uuidSchema, type SuppressionResult } from "@zs/contracts";
import { recordSuppression, suppressionTargetId } from "../delivery/suppression.js";
import { resendSuppressionReason, type ResendEmailEvent } from "../delivery/resend-webhook.js";
import { derivedId } from "./ids.js";
import { directDispatch, type Authorize, type EdgeDependencies } from "./session.js";

export const emailFeedbackActorId = (tenantId: string) => derivedId(tenantId, "email-feedback", "actor");

const recordOnly: Authorize = async (_tx, binding) => {
  if (binding.actionType !== SUPPRESSION_RECORD_ACTION) throw new TenantDenied();
};

export type EmailFeedbackOutcome =
  | { readonly handled: true; readonly tenantId: string; readonly deliveryId: string; readonly result: SuppressionResult }
  | { readonly handled: false; readonly reason: string };

export function createEmailFeedbackSession(deps: EdgeDependencies, options: { readonly providerName?: string } = {}) {
  const providerName = options.providerName ?? "resend";
  return {
    /**
     * `eventId` is the webhook's own ID (svix-id), the same on every redelivery, so a repeat
     * replays the stored action instead of acting twice.
     */
    async receive(eventId: string, event: ResendEmailEvent): Promise<EmailFeedbackOutcome> {
      const wanted = resendSuppressionReason(event);
      if ("ignored" in wanted) return { handled: false, reason: wanted.ignored };
      const tenant = uuidSchema.safeParse(event.data.tags?.zs_tenant);
      const delivery = uuidSchema.safeParse(event.data.tags?.zs_delivery);
      if (!tenant.success || !delivery.success) return { handled: false, reason: "untagged" };
      const tenantId = tenant.data;
      const deliveryId = delivery.data;
      const row = await deps.db.tenant(tenantId, async (tx) => (await tx.query<{
        recipient_address: string | null; provider_message_id: string | null;
      }>(
        `SELECT recipient_address, provider_message_id FROM message_deliveries
          WHERE tenant_id=$1 AND id=$2 AND channel='email' AND provider=$3`,
        [tenantId, deliveryId, providerName])).rows[0]);
      if (!row || !row.recipient_address) return { handled: false, reason: "unknown_delivery" };
      // A delivery that recorded its Resend ID must match the event's; one whose reply was lost has none yet.
      if (row.provider_message_id !== null && row.provider_message_id !== event.data.email_id)
        return { handled: false, reason: "email_mismatch" };
      const address = row.recipient_address;
      if (!event.data.to.some((to) => to.trim().toLowerCase() === address.toLowerCase())) return { handled: false, reason: "recipient_mismatch" };
      const idempotencyKey = `email-feedback:${eventId}`;
      const run = directDispatch(deps, tenantId, emailFeedbackActorId(tenantId), recordOnly);
      const result = await recordSuppression({
        actionType: SUPPRESSION_RECORD_ACTION,
        target: { tenantId, type: "suppression", id: suppressionTargetId(tenantId, "email", address) },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: {
          channel: "email", address, reason: wanted.reason,
          source: `${providerName}:${event.type}:${deliveryId}`.slice(0, 200),
        },
      }, { dispatch: run });
      return { handled: true, tenantId, deliveryId, result };
    },
  };
}
export type EmailFeedbackSession = ReturnType<typeof createEmailFeedbackSession>;
