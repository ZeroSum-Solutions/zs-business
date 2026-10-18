import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
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
  /** When set, the token's `iss` must equal it. */
  readonly issuer?: string;
  /** Longest accepted token lifetime, `exp` minus `iat` (or now, if earlier or absent). Default 1 hour. */
  readonly maxLifetimeSeconds?: number;
}

export const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 3600;

type Key = Uint8Array | JWTVerifyGetKey;

/**
 * Verify like a Supabase Auth access token: signature, exp/nbf against the injected clock,
 * audience, issuer when configured, `role = authenticated` and a bounded lifetime, then map
 * `sub` to the actor and `app_metadata.tenant_id` to the tenant.
 * The key is either an HS256 secret or a JWKS resolver (`createRemoteJWKSet`) for ES256/RS256.
 */
function createVerifier(key: Key, algorithms: string[], options: SupabaseTokenOptions): TokenVerifier {
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime <= 0)
    throw new Error("Maximum token lifetime must be a positive whole number of seconds");
  return {
    async verify(token) {
      let payload: JWTPayload;
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
      if (payload.role !== "authenticated") throw new Unauthenticated("Access token role must be authenticated");
      // A future iat must not stretch the window, so measure from the earlier of iat and now.
      const now = Math.floor(options.clock.now().getTime() / 1000);
      const start = typeof payload.iat === "number" ? Math.min(payload.iat, now) : now;
      if (payload.exp! - start > maxLifetime) throw new Unauthenticated("Access token lifetime is too long");
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
