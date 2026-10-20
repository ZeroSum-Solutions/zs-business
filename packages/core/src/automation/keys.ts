// M5 Activepieces keys (activepieces.md W-5, W-6, W-9). Original code. Nothing secret is stored:
// an endpoint's signing secret and a token's text both derive from the server key, so the
// database holds only what to revoke. Webhooks are signed the Standard Webhooks way: HMAC-SHA-256
// over `<id>.<timestamp>.<body>`, sent as space-separated `v1,<base64>` entries.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface AutomationKeySecrets {
  /** Derives every secret and token; signs and verifies. */
  readonly current: string;
  /** During a server key rotation: still verifies tokens and still signs webhooks (W-6). */
  readonly previous?: string | undefined;
}

const keys = (secrets: AutomationKeySecrets) =>
  [secrets.current, secrets.previous].filter((key): key is string => key !== undefined);

/** W-5: `whsec_` and the base64 of 32 bytes, the form Standard Webhooks verifiers read. */
export function webhookSigningSecret(key: string, tenantId: string, endpointId: string, version: number): string {
  const bytes = createHmac("sha256", key).update(`zsw1:${tenantId.toLowerCase()}:${endpointId.toLowerCase()}:${version}`).digest();
  return `whsec_${bytes.toString("base64")}`;
}

/** One `v1,<base64>` entry for one secret. */
export function signWebhookBody(secret: string, id: string, timestampSeconds: number, body: string): string {
  const raw = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", raw).update(`${id}.${timestampSeconds}.`).update(body).digest("base64")}`;
}

export interface SecretVersions {
  readonly secretVersion: number;
  /** The previous version, only while it is inside its grace (W-5). */
  readonly previousVersion: number | null;
}

/**
 * W-5, W-6: every secret a receiver may hold right now: the current version and, inside its
 * grace, the previous one, each under the current and (during a key rotation) the previous key.
 */
export function signingSecrets(secrets: AutomationKeySecrets, tenantId: string, endpointId: string, versions: SecretVersions): string[] {
  const out: string[] = [];
  for (const key of keys(secrets)) {
    out.push(webhookSigningSecret(key, tenantId, endpointId, versions.secretVersion));
    if (versions.previousVersion !== null) out.push(webhookSigningSecret(key, tenantId, endpointId, versions.previousVersion));
  }
  return [...new Set(out)];
}

/** The `webhook-signature` header: one entry per secret a receiver may hold. */
export function webhookSignatureHeader(secrets: readonly string[], id: string, timestampSeconds: number, body: string): string {
  return secrets.map((secret) => signWebhookBody(secret, id, timestampSeconds, body)).join(" ");
}

// W-9: `zsap1_` and 86 base64url characters: the tenant UUID, the token UUID and a 32-byte
// HMAC-SHA-256 tag over `zsap1:<tenant>:<token>`. The tag is checked before any database work.
const TOKEN_PREFIX = "zsap1_";
const TOKEN_PATTERN = /^zsap1_[A-Za-z0-9_-]{86}$/;
const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const uuidText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const tokenTag = (key: string, tenantId: string, tokenId: string): Buffer =>
  createHmac("sha256", key).update(`zsap1:${tenantId}:${tokenId}`).digest();

export interface AutomationTokenRef {
  readonly tenantId: string;
  readonly tokenId: string;
}

export function signAutomationToken(key: string, ref: AutomationTokenRef): string {
  const tenantId = ref.tenantId.toLowerCase();
  const tokenId = ref.tokenId.toLowerCase();
  return TOKEN_PREFIX + Buffer.concat([uuidBytes(tenantId), uuidBytes(tokenId), tokenTag(key, tenantId, tokenId)]).toString("base64url");
}

/** The tenant and token a bearer token names, or null for anything malformed or not signed by a known key. */
export function verifyAutomationToken(secrets: AutomationKeySecrets, token: string): AutomationTokenRef | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const encoded = token.slice(TOKEN_PREFIX.length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== encoded) return null;
  const tenantId = uuidText(bytes.subarray(0, 16));
  const tokenId = uuidText(bytes.subarray(16, 32));
  const given = bytes.subarray(32);
  let valid = false;
  for (const key of keys(secrets)) if (timingSafeEqual(given, tokenTag(key, tenantId, tokenId))) valid = true;
  return valid ? { tenantId, tokenId } : null;
}
