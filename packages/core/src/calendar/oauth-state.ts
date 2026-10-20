// G-1, G-2, G-8: the signed OAuth state, the PKCE verifier and the watch channel token. Original
// code. Nothing is stored before the callback: the state carries who asked and for what, signed
// by the server, and the PKCE verifier derives from the state secret and the connection ID.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "zgs1.";
export const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;

export interface OAuthStateSecrets {
  /** Signs new states and verifies. */
  readonly current: string;
  /** Verifies only, through a rotation. */
  readonly previous?: string | undefined;
}
export interface OAuthState {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tag = (secret: string, body: string) => createHmac("sha256", secret).update(`${PREFIX}${body}`).digest();

export function signOAuthState(secret: string, state: OAuthState): string {
  const body = Buffer.from(JSON.stringify([
    state.tenantId.toLowerCase(), state.actorId.toLowerCase(), state.resourceId.toLowerCase(),
    state.connectionId.toLowerCase(), state.expiresAt,
  ])).toString("base64url");
  return `${PREFIX}${body}.${tag(secret, body).toString("base64url")}`;
}

/** The state, or null when it is malformed, not signed by a known secret, or expired. */
export function verifyOAuthState(secrets: OAuthStateSecrets, token: string, now: Date): OAuthState | null {
  if (token.length > 600 || !token.startsWith(PREFIX)) return null;
  const parts = token.slice(PREFIX.length).split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const [body, given] = [parts[0]!, Buffer.from(parts[1]!, "base64url")];
  // 43 characters carry 258 bits; only the canonical spelling of the 256-bit tag is accepted.
  if (given.toString("base64url") !== parts[1]) return null;
  let valid = false;
  for (const secret of [secrets.current, secrets.previous])
    if (secret !== undefined && timingSafeEqual(given, tag(secret, body))) valid = true;
  if (!valid) return null;
  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 5) return null;
  const [tenantId, actorId, resourceId, connectionId, expiresAt] = fields as unknown[];
  if (![tenantId, actorId, resourceId, connectionId].every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null;
  return { tenantId: tenantId as string, actorId: actorId as string, resourceId: resourceId as string, connectionId: connectionId as string, expiresAt };
}

/** RFC 7636 verifier (43 characters) for one connection, derived from the state secret. */
export function pkceVerifier(secret: string, connectionId: string): string {
  return createHmac("sha256", secret).update(`zgp1:${connectionId.toLowerCase()}`).digest().toString("base64url");
}
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest().toString("base64url");

/** G-8: the token Google echoes on every push for a channel. */
export function channelToken(secret: string, channelId: string): string {
  return createHmac("sha256", secret).update(`zgc1:${channelId.toLowerCase()}`).digest().toString("base64url");
}
export function verifyChannelToken(secret: string, channelId: string, token: string | undefined): boolean {
  // The alphabet check keeps a non-ASCII header from reaching timingSafeEqual at another byte length (it would throw).
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !UUID.test(channelId)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(channelToken(secret, channelId)));
}
