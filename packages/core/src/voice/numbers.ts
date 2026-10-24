// twilio.md T-10: an operator sets a tenant's voice number settings as the service role. The voice
// number is always the tenant's SMS number (T-7), so the text comes from the number the caller
// rang. Disclosure wording is append-only: a new wording is a new version. Original code.
import { ValidationFailed, contactPhoneSchema, voiceDisclosureVersionSchema } from "@zs/contracts";
import type { Transaction } from "@zs/db";

export interface VoiceNumberSettings {
  readonly phoneNumber: string;
  readonly forwardTo: string;
  readonly ringSeconds: number;
  readonly textbackEnabled: boolean;
  readonly bookingUrl: string | null;
  readonly disclosureVersion: string | null;
}

export interface VoiceNumberInput {
  readonly tenantId: string;
  /** Null removes the tenant's voice number (the disclosure history stays). */
  readonly forwardTo: string | null;
  readonly ringSeconds?: number;
  readonly textbackEnabled?: boolean;
  readonly bookingUrl?: string;
  /** A new wording to record as `version`; the number then uses it. */
  readonly disclosure?: { readonly version: string; readonly text: string };
  /** Use an already recorded version. */
  readonly disclosureVersion?: string;
  readonly now: Date;
}

interface Row {
  phone_number: string;
  forward_to_e164: string;
  ring_seconds: number;
  textback_enabled: boolean;
  booking_url: string | null;
  disclosure_version: string | null;
}

const settings = (row: Row): VoiceNumberSettings => ({
  phoneNumber: row.phone_number, forwardTo: row.forward_to_e164, ringSeconds: row.ring_seconds,
  textbackEnabled: row.textback_enabled, bookingUrl: row.booking_url, disclosureVersion: row.disclosure_version,
});

/** What the caller hears when offered the text (T-11), from the business name; the operator may reword it. */
export const defaultDisclosure = (businessName: string): string =>
  `${businessName}: press 1 to get our booking link by text, or stay on the line to leave a message. `
  + "We will send one text. Message and data rates may apply. Reply STOP to opt out.";

export async function assignVoiceNumber(tx: Transaction, input: VoiceNumberInput): Promise<VoiceNumberSettings | null> {
  if (input.forwardTo === null) {
    await tx.query("DELETE FROM voice_numbers WHERE tenant_id=$1", [input.tenantId]);
    return null;
  }
  if (!contactPhoneSchema.safeParse(input.forwardTo).success) throw new ValidationFailed("The forward-to number must be E.164, like +15555550100");
  if (input.ringSeconds !== undefined && !(Number.isInteger(input.ringSeconds) && input.ringSeconds >= 5 && input.ringSeconds <= 45))
    throw new ValidationFailed("Ring seconds must be a whole number from 5 to 45");
  if (input.bookingUrl !== undefined && (!/^https:\/\/[^\s<>"]+$/.test(input.bookingUrl) || input.bookingUrl.length > 300))
    throw new ValidationFailed("The booking link must be an https URL of at most 300 characters");
  const sms = (await tx.query<{ phone_number: string }>("SELECT phone_number FROM sms_numbers WHERE tenant_id=$1", [input.tenantId])).rows[0];
  if (!sms) throw new ValidationFailed("Assign the tenant an SMS number first (pnpm sms:number); the voice number is the same number");
  const name = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [input.tenantId])).rows[0];
  if (!name) throw new ValidationFailed("Unknown tenant");

  let version = input.disclosureVersion;
  if (input.disclosure) {
    if (!voiceDisclosureVersionSchema.safeParse(input.disclosure.version).success)
      throw new ValidationFailed("The disclosure version must be 1 to 40 letters, digits, dots, dashes or underscores");
    if (input.disclosure.text.length < 1 || input.disclosure.text.length > 1000) throw new ValidationFailed("The disclosure must be 1 to 1000 characters");
    const kept = (await tx.query<{ text: string }>(
      `INSERT INTO voice_textback_disclosures (tenant_id, version, text, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, version) DO NOTHING RETURNING text`,
      [input.tenantId, input.disclosure.version, input.disclosure.text, input.now])).rows[0];
    if (!kept) {
      const same = await tx.query("SELECT 1 FROM voice_textback_disclosures WHERE tenant_id=$1 AND version=$2 AND text=$3",
        [input.tenantId, input.disclosure.version, input.disclosure.text]);
      if (!same.rowCount) throw new ValidationFailed("That disclosure version already holds other wording; use a new version");
    }
    version = input.disclosure.version;
  }
  const existing = (await tx.query<Row>(
    "SELECT phone_number, forward_to_e164, ring_seconds, textback_enabled, booking_url, disclosure_version FROM voice_numbers WHERE tenant_id=$1 FOR UPDATE",
    [input.tenantId])).rows[0];
  const next = {
    ringSeconds: input.ringSeconds ?? existing?.ring_seconds ?? 20,
    enabled: input.textbackEnabled ?? existing?.textback_enabled ?? false,
    bookingUrl: input.bookingUrl ?? existing?.booking_url ?? null,
    version: version ?? existing?.disclosure_version ?? null,
  };
  if (next.enabled && (next.bookingUrl === null || next.version === null))
    throw new ValidationFailed("Turning the text-back on needs a booking link and a disclosure version");
  const row = (await tx.query<Row>(
    `INSERT INTO voice_numbers (tenant_id, phone_number, forward_to_e164, ring_seconds, textback_enabled, booking_url, disclosure_version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (tenant_id) DO UPDATE SET phone_number=EXCLUDED.phone_number, forward_to_e164=EXCLUDED.forward_to_e164,
       ring_seconds=EXCLUDED.ring_seconds, textback_enabled=EXCLUDED.textback_enabled, booking_url=EXCLUDED.booking_url,
       disclosure_version=EXCLUDED.disclosure_version, updated_at=EXCLUDED.updated_at
     RETURNING phone_number, forward_to_e164, ring_seconds, textback_enabled, booking_url, disclosure_version`,
    [input.tenantId, sms.phone_number, input.forwardTo, next.ringSeconds, next.enabled, next.bookingUrl, next.version, input.now])).rows[0]!;
  return settings(row);
}
