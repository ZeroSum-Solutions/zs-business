// G-2: a grant Google gave that waits for the owner's confirmation. Original code. The callback
// arrives on a cross-site navigation that carries no session, so it cannot tell the owner's own
// consent from a callback URL someone else finished and relayed to the owner. It stages the grant
// instead: a token signed by the state secret, holding the sealed refresh token (useless without
// the worker's key) and what the state named, kept by the dashboard in a Strict cookie. The owner
// sees the Google account it names and connects it from a same-origin request with their session.
import { createHmac, timingSafeEqual } from "node:crypto";
import { connectGoogleCalendarInputSchema } from "@zs/contracts";
import type { OAuthStateSecrets } from "./oauth-state.js";

const PREFIX = "zgg1.";
/** A staged grant lives as long as the state that led to it. */
export const PENDING_GRANT_LIFETIME_MS = 10 * 60 * 1000;
/** Fits one cookie with room to spare; a longer token is refused when it is made. */
export const MAX_PENDING_GRANT_LENGTH = 3500;

export interface PendingGrant {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly connectionId: string;
  readonly accountEmail: string | null;
  readonly scope: string;
  readonly refreshTokenSealed: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The prefix is part of what is signed, so a signed state never reads as a grant, nor the reverse.
const tag = (secret: string, body: string) => createHmac("sha256", secret).update(`${PREFIX}${body}`).digest();

/** The signed token, or null when it would not fit a cookie. */
export function signPendingGrant(secret: string, grant: PendingGrant): string | null {
  const body = Buffer.from(JSON.stringify([
    grant.tenantId.toLowerCase(), grant.actorId.toLowerCase(), grant.resourceId.toLowerCase(), grant.connectionId.toLowerCase(),
    grant.accountEmail, grant.scope, grant.refreshTokenSealed, grant.expiresAt,
  ])).toString("base64url");
  const token = `${PREFIX}${body}.${tag(secret, body).toString("base64url")}`;
  return token.length <= MAX_PENDING_GRANT_LENGTH ? token : null;
}

/** The grant, or null when it is malformed, not signed by a known secret, or expired. */
export function verifyPendingGrant(secrets: OAuthStateSecrets, token: string | undefined, now: Date): PendingGrant | null {
  if (token === undefined || token.length > MAX_PENDING_GRANT_LENGTH || !token.startsWith(PREFIX)) return null;
  const parts = token.slice(PREFIX.length).split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return null;
  const [body, given] = [parts[0]!, Buffer.from(parts[1]!, "base64url")];
  // Only the canonical spelling of the 256-bit tag.
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
  if (!Array.isArray(fields) || fields.length !== 8) return null;
  const [tenantId, actorId, resourceId, connectionId, accountEmail, scope, refreshTokenSealed, expiresAt] = fields as unknown[];
  if (![tenantId, actorId, resourceId, connectionId].every((id) => typeof id === "string" && UUID.test(id))) return null;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now.getTime()) return null;
  // What the connect action will accept, checked here too.
  const input = connectGoogleCalendarInputSchema.safeParse({ connectionId, resourceId, accountEmail, scope, refreshTokenSealed });
  if (!input.success) return null;
  return {
    tenantId: tenantId as string, actorId: actorId as string, resourceId: input.data.resourceId, connectionId: input.data.connectionId,
    accountEmail: input.data.accountEmail, scope: input.data.scope, refreshTokenSealed: input.data.refreshTokenSealed, expiresAt,
  };
}
