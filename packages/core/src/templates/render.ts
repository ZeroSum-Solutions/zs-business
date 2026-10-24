// The wording of a template revision filled with a send's recorded values (agents.md G-19, delivery.md D-6).
// A leaf module: the approval check imports it, so it imports nothing from approvals.
import { renderTemplate, type DeliveryChannel, type DeliveryPurpose } from "@zs/contracts";
import { deliveryContentDigest } from "../delivery/policy.js";

interface Wording { readonly channel: DeliveryChannel; readonly purpose: DeliveryPurpose; readonly subject: string | null; readonly body: string }

/** The wording of a revision filled with the values a send recorded. */
export function renderedContent(
  revision: Pick<Wording, "subject" | "body">, values: Readonly<Record<string, string>>,
): { subject: string | null; body: string } {
  return {
    subject: revision.subject === null ? null : renderTemplate(revision.subject, values),
    body: renderTemplate(revision.body, values),
  };
}

/** D-6: the digest of the delivery a send must produce: the revision rendered with its recorded values. */
export function sendDigest(
  revision: Wording, values: Readonly<Record<string, string>>,
  messageId: string, contactId: string,
): string {
  const content = renderedContent(revision, values);
  return deliveryContentDigest({
    messageId, contactId, channel: revision.channel, purpose: revision.purpose, subject: content.subject, body: content.body,
  });
}

