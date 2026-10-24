// M3d delivery policy (delivery.md D-5, D-6, D-9). Original code: pricing, SMS segment
// counting, the content digest an approval binds, and the consent rule.
import { createHash } from "node:crypto";
import type { DeliveryChannel, DeliveryFinalReason, DeliveryPurpose } from "@zs/contracts";

// GSM 03.38 default alphabet and its extension table (extension characters take two septets).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

/**
 * Segments a carrier bills for one SMS: 160 GSM septets or 70 UCS-2 units in one part;
 * 153 and 67 per part once the text needs concatenation headers.
 */
export function smsSegments(text: string): number {
  let septets = 0;
  let gsm = true;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets += 1;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else { gsm = false; break; }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  // UCS-2 counts UTF-16 code units; a character outside the BMP takes two.
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export interface DeliveryPricing {
  readonly currency: string;
  /** Minor units per email. */
  readonly email: number;
  /** Minor units per SMS segment. */
  readonly smsSegment: number;
}

/** D-5: the price of the exact text the provider will receive. */
export function deliveryPrice(pricing: DeliveryPricing, channel: DeliveryChannel, text: string): number {
  return channel === "email" ? pricing.email : pricing.smsSegment * smsSegments(text);
}

export interface DigestContent {
  readonly messageId: string;
  readonly contactId: string;
  readonly channel: DeliveryChannel;
  readonly purpose: DeliveryPurpose;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * D-6: the digest an approval is checked against: SHA-256 over a fixed-order JSON array, so
 * any change of recipient, channel, purpose or wording is another digest.
 */
export function deliveryContentDigest(content: DigestContent): string {
  const canonical = JSON.stringify(["zs-delivery-v1", content.messageId, content.contactId, content.channel,
    content.purpose, content.subject, content.body]);
  return createHash("sha256").update(canonical).digest("hex");
}

export type ConsentStatus = "granted" | "denied" | null;

/**
 * D-6: whether consent and suppression allow this send, or the reason they do not. A recorded
 * denial always wins; marketing and every SMS need a recorded grant; a transactional email
 * (a reply to the contact, a booking notice) needs none.
 */
export function consentBlock(input: {
  readonly channel: DeliveryChannel;
  readonly purpose: DeliveryPurpose;
  readonly consent: ConsentStatus;
  readonly suppressed: boolean;
  /** Where the recorded consent came from (D-6 rev 5); a voice opt-in never counts for marketing. */
  readonly source?: string | null;
}): DeliveryFinalReason | null {
  if (input.suppressed) return "suppressed";
  if (input.consent === "denied") return "consent_denied";
  if (input.purpose === "marketing" && input.consent === "granted" && isVoiceGrant(input.source)) return "consent_missing";
  if ((input.purpose === "marketing" || input.channel === "sms") && input.consent !== "granted") return "consent_missing";
  return null;
}

/** twilio.md T-12: the source of a grant a caller gave on a call. */
export const VOICE_CONSENT_SOURCE_PREFIX = "twilio-voice:";
export const isVoiceGrant = (source: string | null | undefined) => typeof source === "string" && source.startsWith(VOICE_CONSENT_SOURCE_PREFIX);

/**
 * Placeholder addresses (crm.md) are never a real recipient: any address under the reserved
 * `.invalid` name (RFC 6761), not only the column default's `@placeholder.invalid`.
 */
export function usableEmail(address: string | null): string | null {
  return address && !/[@.]invalid$/i.test(address) ? address : null;
}

/** Exponential backoff from the attempt count (1-based), capped. Deterministic: no jitter source is injected. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}
