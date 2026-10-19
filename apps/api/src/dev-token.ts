import { SignJWT } from "jose";
import type { VerifiedToken } from "./auth.js";

/**
 * Mint a Supabase-shaped HS256 access token for local development, tests, and check:hosted's
 * refusal probes. The session id must name a live session (the local stub in
 * @zs/db/local-auth, or Supabase Auth hosted), or the API refuses the token.
 */
export function signDevToken(
  secret: string,
  token: Omit<VerifiedToken, "expiresAt">,
  clock: { now(): Date },
  ttlSeconds = 7 * 24 * 3600,
  issuer?: string,
): Promise<string> {
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  const jwt = new SignJWT({ role: "authenticated", session_id: token.sessionId, app_metadata: { tenant_id: token.tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(token.actorId)
    .setAudience("authenticated")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds);
  return (issuer === undefined ? jwt : jwt.setIssuer(issuer)).sign(new TextEncoder().encode(secret));
}
