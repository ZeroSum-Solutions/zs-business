import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { accessTokenClaimsSchema } from "@zs/contracts";
import type { Principal } from "@zs/core";

/** Verifies a bearer token and returns the principal, or throws Unauthenticated. */
export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export class Unauthenticated extends Error {
  constructor(message = "Invalid or missing access token") {
    super(message);
    this.name = "Unauthenticated";
  }
}

export interface SupabaseTokenOptions {
  readonly clock: { now(): Date };
  /** Supabase access tokens carry aud "authenticated". */
  readonly audience?: string;
  readonly issuer?: string;
}

type Key = Uint8Array | JWTVerifyGetKey;

/**
 * Verify like a Supabase Auth access token: signature, exp/nbf against the injected clock,
 * audience, then map `sub` to the actor and `app_metadata.tenant_id` to the tenant.
 * The key is either an HS256 secret or a JWKS resolver (`createRemoteJWKSet`) for ES256/RS256.
 */
function createVerifier(key: Key, algorithms: string[], options: SupabaseTokenOptions): TokenVerifier {
  return {
    async verify(token) {
      let payload: unknown;
      try {
        const verifyOptions = {
          algorithms,
          audience: options.audience ?? "authenticated",
          currentDate: options.clock.now(),
          requiredClaims: ["exp", "sub"],
          ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
        };
        payload = (typeof key === "function"
          ? await jwtVerify(token, key, verifyOptions)
          : await jwtVerify(token, key, verifyOptions)).payload;
      } catch {
        throw new Unauthenticated();
      }
      const claims = accessTokenClaimsSchema.safeParse(payload);
      if (!claims.success) throw new Unauthenticated("Access token lacks a user or tenant claim");
      return { actorId: claims.data.sub, tenantId: claims.data.app_metadata.tenant_id };
    },
  };
}

export function createHs256Verifier(secret: string, options: SupabaseTokenOptions): TokenVerifier {
  if (secret.length < 32) throw new Error("JWT secret must be at least 32 characters");
  return createVerifier(new TextEncoder().encode(secret), ["HS256"], options);
}

/** Swap-in for asymmetric Supabase signing keys: pass createRemoteJWKSet(new URL(jwksUrl)). */
export function createJwksVerifier(jwks: JWTVerifyGetKey, options: SupabaseTokenOptions): TokenVerifier {
  return createVerifier(jwks, ["ES256", "RS256"], options);
}
