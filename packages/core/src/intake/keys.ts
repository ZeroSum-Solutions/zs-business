// Public booking keys (public-intake.md P-2): the tenant and page travel inside the key,
// signed by the server, so a visitor's request names its tenant without the server trusting
// any body field and without a cross-tenant lookup.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "zsb1_";
const TAG_BYTES = 16;
const KEY_PATTERN = /^zsb1_[A-Za-z0-9_-]{64}$/;

export interface BookingKeySecrets {
  /** Signs new keys and verifies. */
  readonly current: string;
  /** Verifies only, while embeds move to keys signed by the current secret. */
  readonly previous?: string | undefined;
}
export interface BookingPageRef {
  readonly tenantId: string;
  readonly pageId: string;
}

const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const tag = (secret: string, tenantId: string, pageId: string): Buffer =>
  createHmac("sha256", secret).update(`zsb1:${tenantId}:${pageId}`).digest().subarray(0, TAG_BYTES);

export function signBookingKey(secret: string, ref: BookingPageRef): string {
  const tenantId = ref.tenantId.toLowerCase();
  const pageId = ref.pageId.toLowerCase();
  return PREFIX + Buffer.concat([uuidBytes(tenantId), uuidBytes(pageId), tag(secret, tenantId, pageId)]).toString("base64url");
}

/** The page a key names, or null for anything malformed or not signed by a known secret. */
export function verifyBookingKey(secrets: BookingKeySecrets, key: string): BookingPageRef | null {
  if (!KEY_PATTERN.test(key)) return null;
  const bytes = Buffer.from(key.slice(PREFIX.length), "base64url");
  // base64url decoding ignores stray bits; re-encoding proves the text is the canonical form.
  if (bytes.length !== 48 || bytes.toString("base64url") !== key.slice(PREFIX.length)) return null;
  const tenantId = uuidText(bytes.subarray(0, 16));
  const pageId = uuidText(bytes.subarray(16, 32));
  const given = bytes.subarray(32);
  let valid = false;
  for (const secret of [secrets.current, secrets.previous]) {
    // Check every secret so timing does not tell which one matched.
    if (secret !== undefined && timingSafeEqual(given, tag(secret, tenantId, pageId))) valid = true;
  }
  return valid ? { tenantId, pageId } : null;
}
