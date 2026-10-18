import { SignJWT } from "jose";
import type { VerifiedToken } from "./auth.js";

/**
 * Mint a Supabase-shaped HS256 access token for local development and tests only. The
 * session id must name a live auth.sessions row (the local stub in @zs/db/local-auth), or the
 * API refuses the token.
 */
export function signDevToken(
  secret: string,
  token: VerifiedToken,
  clock: { now(): Date },
  ttlSeconds = 7 * 24 * 3600,
): Promise<string> {
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ role: "authenticated", session_id: token.sessionId, app_metadata: { tenant_id: token.tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(token.actorId)
    .setAudience("authenticated")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}
