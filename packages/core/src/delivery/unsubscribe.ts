// Unsubscribe tokens (delivery.md D-9). Same shape as public booking keys (intake/keys.ts):
// the tenant and delivery travel inside the token, signed by the server, so a one-click
// unsubscribe names its tenant without trusting the request or a cross-tenant lookup.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "zsu1_";
const TAG_BYTES = 16;
const TOKEN_PATTERN = /^zsu1_[A-Za-z0-9_-]{64}$/;

export interface UnsubscribeSecrets {
  /** Signs new tokens and verifies. */
  readonly current: string;
  /** Verifies only, so links in mail already sent keep working through a rotation. */
  readonly previous?: string | undefined;
}
export interface UnsubscribeRef {
  readonly tenantId: string;
  readonly deliveryId: string;
}

const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const tag = (secret: string, tenantId: string, deliveryId: string): Buffer =>
  createHmac("sha256", secret).update(`zsu1:${tenantId}:${deliveryId}`).digest().subarray(0, TAG_BYTES);

export function signUnsubscribeToken(secret: string, ref: UnsubscribeRef): string {
  const tenantId = ref.tenantId.toLowerCase();
  const deliveryId = ref.deliveryId.toLowerCase();
  return PREFIX + Buffer.concat([uuidBytes(tenantId), uuidBytes(deliveryId), tag(secret, tenantId, deliveryId)])
    .toString("base64url");
}

/** The delivery a token names, or null for anything malformed or not signed by a known secret. */
export function verifyUnsubscribeToken(secrets: UnsubscribeSecrets, token: string): UnsubscribeRef | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const bytes = Buffer.from(token.slice(PREFIX.length), "base64url");
  if (bytes.length !== 48 || bytes.toString("base64url") !== token.slice(PREFIX.length)) return null;
  const tenantId = uuidText(bytes.subarray(0, 16));
  const deliveryId = uuidText(bytes.subarray(16, 32));
  const given = bytes.subarray(32);
  let valid = false;
  for (const secret of [secrets.current, secrets.previous]) {
    if (secret !== undefined && timingSafeEqual(given, tag(secret, tenantId, deliveryId))) valid = true;
  }
  return valid ? { tenantId, deliveryId } : null;
}
