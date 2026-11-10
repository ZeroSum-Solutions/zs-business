// Manage tokens (booking-self-service.md BS-1). Same shape as public booking keys and unsubscribe
// tokens: the tenant and the booking travel inside the token, signed by the server, so a route names
// its tenant without trusting the request. Original code.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "zsm1_";
const TAG_BYTES = 16;
const TOKEN_PATTERN = /^zsm1_[A-Za-z0-9_-]{70}$/;
const KEY_LABEL = "zs:booking-manage:v1";

export interface ManageSecrets {
  /** Signs new tokens and verifies. */
  readonly current: string;
  /** Verifies only, so links in mail already sent keep working through a rotation. */
  readonly previous?: string | undefined;
}
export interface ManageRef {
  readonly tenantId: string;
  readonly bookingId: string;
  /** Unix seconds; the token is dead from this instant on. */
  readonly expiresAt: number;
}

/** BS-1: the signing key is derived from the booking-key secret, so no new secret exists to deploy. */
const signingKey = (secret: string): Buffer => createHmac("sha256", secret).update(KEY_LABEL).digest();

const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const tag = (secret: string, tenantId: string, bookingId: string, expiresAt: number): Buffer =>
  createHmac("sha256", signingKey(secret)).update(`zsm1:${tenantId}:${bookingId}:${expiresAt}`).digest().subarray(0, TAG_BYTES);

/** The expiry is the booking's start: a whole second at or after it, so the token never dies early. */
export const manageExpiry = (startsAt: Date | string): number => Math.ceil(new Date(startsAt).getTime() / 1000);

export function signManageToken(secret: string, ref: ManageRef): string {
  const tenantId = ref.tenantId.toLowerCase();
  const bookingId = ref.bookingId.toLowerCase();
  if (!Number.isInteger(ref.expiresAt) || ref.expiresAt < 0 || ref.expiresAt > 0xffffffff) throw new RangeError("Token expiry out of range");
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32BE(ref.expiresAt);
  return PREFIX + Buffer.concat([uuidBytes(tenantId), uuidBytes(bookingId), expiry, tag(secret, tenantId, bookingId, ref.expiresAt)])
    .toString("base64url");
}

/** The booking a token names, or null for anything malformed or not signed by a known secret. Expiry is the caller's check. */
export function verifyManageToken(secrets: ManageSecrets, token: string): ManageRef | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const bytes = Buffer.from(token.slice(PREFIX.length), "base64url");
  if (bytes.length !== 52 || bytes.toString("base64url") !== token.slice(PREFIX.length)) return null;
  const tenantId = uuidText(bytes.subarray(0, 16));
  const bookingId = uuidText(bytes.subarray(16, 32));
  const expiresAt = bytes.readUInt32BE(32);
  const given = bytes.subarray(36);
  let valid = false;
  for (const secret of [secrets.current, secrets.previous]) {
    if (secret !== undefined && timingSafeEqual(given, tag(secret, tenantId, bookingId, expiresAt))) valid = true;
  }
  return valid ? { tenantId, bookingId, expiresAt } : null;
}
