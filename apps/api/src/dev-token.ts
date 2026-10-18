import { SignJWT } from "jose";
import type { Principal } from "@zs/core";

/** Mint a Supabase-shaped HS256 access token for local development and tests only. */
export function signDevToken(
  secret: string,
  principal: Principal,
  clock: { now(): Date },
  ttlSeconds = 7 * 24 * 3600,
): Promise<string> {
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ role: "authenticated", app_metadata: { tenant_id: principal.tenantId } })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(principal.actorId)
    .setAudience("authenticated")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(new TextEncoder().encode(secret));
}
