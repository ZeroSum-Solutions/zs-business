import { SignJWT } from "jose";
import type { Principal } from "@zs/core";

/**
 * Mint a Supabase-shaped HS256 access token for local development, tests, and the pilot's
 * one server-side owner token (scripts/mint-token.ts). Real sign-in replaces the last use.
 */
export function signDevToken(
  secret: string,
  principal: Principal,
  clock: { now(): Date },
  ttlSeconds = 7 * 24 * 3600,
  issuer?: string,
): Promise<string> {
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  const token = new SignJWT({ role: "authenticated", app_metadata: { tenant_id: principal.tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.actorId)
    .setAudience("authenticated")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds);
  return (issuer === undefined ? token : token.setIssuer(issuer)).sign(new TextEncoder().encode(secret));
}
