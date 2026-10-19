// Access token verification shared by the HTTP API and the MCP server. Both verify a
// Supabase Auth access token with one of these verifiers, then call authenticate() (live
// session and membership) before any read or write. Clock and config are injected.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { accessTokenClaimsSchema } from "@zs/contracts";
import { AuthUnavailable, Unauthenticated } from "./errors.js";
import type { Principal } from "./session.js";

export { Unauthenticated };

/** A verified token: the principal plus the Supabase session it belongs to. */
export interface VerifiedToken extends Principal {
  /** The token's `session_id`; authenticate() checks it against live sessions on every call. */
  readonly sessionId: string;
  /** The token's `exp`, in seconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * Verifies a bearer token and returns the principal, or throws Unauthenticated (a bad token)
 * or AuthUnavailable (the signing keys could not be fetched, so nobody can tell).
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface SupabaseTokenOptions {
  readonly clock: { now(): Date };
  /** Supabase access tokens carry aud "authenticated". */
  readonly audience?: string;
  /** When set, the token's `iss` must equal it. */
  readonly issuer?: string;
  /** Longest accepted token lifetime, `exp` minus `iat`. Default 1 hour. */
  readonly maxLifetimeSeconds?: number;
  /** How far `iat` may lie ahead of the clock, for skew between issuer and verifier. Default 60 seconds. */
  readonly clockSkewSeconds?: number;
}

export const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 3600;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

type Key = Uint8Array | JWTVerifyGetKey;

/** Key lookups that fail because of the token itself: its kid names no key, or several, or its alg has none. */
const TOKEN_KEY_ERRORS = [joseErrors.JWKSNoMatchingKey, joseErrors.JWKSMultipleMatchingKeys, joseErrors.JOSENotSupported];

/**
 * The JWKS resolver, with every failure that is not the token's own turned into
 * AuthUnavailable: a fetch that timed out (JWKSTimeout) or failed, an answer other than 200,
 * or a key set that is not valid JSON or not a valid JWKS.
 */
function providerFailuresUnavailable(getKey: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await getKey(header, token);
    } catch (error) {
      if (TOKEN_KEY_ERRORS.some((type) => error instanceof type)) throw error;
      throw new AuthUnavailable("Supabase Auth's signing keys could not be fetched", { cause: error });
    }
  };
}

/**
 * Verify like a Supabase Auth access token: signature, exp/nbf against the injected clock,
 * audience, issuer when configured, `role = authenticated`, an `iat` no later than now plus
 * the allowed skew and a lifetime `exp - iat` within the maximum, then map
 * `sub` to the actor, `app_metadata.tenant_id` to the tenant and `session_id` to the session.
 * The signature proves none of these are still allowed: authenticate() checks the session is
 * live and the user is a member of the tenant on every request or tool call.
 * The key is either an HS256 secret or a JWKS resolver for ES256/RS256.
 */
function createVerifier(key: Key, algorithms: string[], options: SupabaseTokenOptions): TokenVerifier {
  const maxLifetime = options.maxLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime <= 0)
    throw new Error("Maximum token lifetime must be a positive whole number of seconds");
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isSafeInteger(skew) || skew < 0)
    throw new Error("Clock skew must be a non-negative whole number of seconds");
  return {
    async verify(token) {
      let payload: JWTPayload;
      try {
        const verifyOptions = {
          algorithms,
          audience: options.audience ?? "authenticated",
          currentDate: options.clock.now(),
          requiredClaims: ["exp", "iat", "sub", "session_id"],
          ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
        };
        payload = (typeof key === "function"
          ? await jwtVerify(token, providerFailuresUnavailable(key), verifyOptions)
          : await jwtVerify(token, key, verifyOptions)).payload;
      } catch (error) {
        // An outage is not a bad token: 503, so the caller keeps its session and retries.
        if (error instanceof AuthUnavailable) throw error;
        throw new Unauthenticated();
      }
      if (payload.role !== "authenticated") throw new Unauthenticated("Access token role must be authenticated");
      // jose has checked that exp and iat are numbers. An iat beyond the skew is refused, so it
      // cannot shift the window into the future; within it, the full lifetime is accepted.
      const now = Math.floor(options.clock.now().getTime() / 1000);
      if (payload.iat! > now + skew) throw new Unauthenticated("Access token was issued in the future");
      if (payload.exp! - payload.iat! > maxLifetime) throw new Unauthenticated("Access token lifetime is too long");
      const claims = accessTokenClaimsSchema.safeParse(payload);
      if (!claims.success) throw new Unauthenticated("Access token lacks a user, session or tenant claim");
      return {
        actorId: claims.data.sub, tenantId: claims.data.app_metadata.tenant_id, sessionId: claims.data.session_id, expiresAt: payload.exp!,
      };
    },
  };
}

/** Legacy Supabase JWT secret: HS256 only. */
export function createHs256Verifier(secret: string, options: SupabaseTokenOptions): TokenVerifier {
  if (secret.length < 32) throw new Error("JWT secret must be at least 32 characters");
  return createVerifier(new TextEncoder().encode(secret), ["HS256"], options);
}

/** Asymmetric Supabase signing keys: ES256 or RS256 only, keys from a JWKS (createRemoteJWKSet or createLocalJWKSet). */
export function createJwksVerifier(jwks: JWTVerifyGetKey, options: SupabaseTokenOptions): TokenVerifier {
  return createVerifier(jwks, ["ES256", "RS256"], options);
}

// ---------------------------------------------------------------------------------------------
// Configuration. Entry points pass their environment object in; this module never reads it.

export const JWT_VERIFIERS = ["hs256", "jwks"] as const;
export type JwtVerifierMethod = (typeof JWT_VERIFIERS)[number];

/** The value shipped in .env.example; a server that still uses it must not start. */
export const PLACEHOLDER_JWT_SECRET = "replace-with-a-local-dev-secret-of-32-or-more-chars";
export const jwtSecretSchema = z.string()
  .min(32, "JWT_SECRET must be at least 32 characters")
  .refine((value) => value !== PLACEHOLDER_JWT_SECRET, "JWT_SECRET is still the .env.example placeholder");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why a URL setting is refused, or null: https, or plain http only on loopback for local tests. */
export function secureUrlProblem(variable: string, value: string): string | null {
  const url = URL.parse(value);
  if (!url) return `${variable} must be a URL`;
  if (url.username || url.password) return `${variable} must not carry credentials`;
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  return `${variable} must use https (plain http only on 127.0.0.1, [::1] or localhost)`;
}
const jwksUrlProblem = (value: string) => secureUrlProblem("JWT_JWKS_URL", value);

interface JwtCommonConfig {
  readonly issuer: string | undefined;
  readonly maxLifetimeSeconds: number;
  readonly clockSkewSeconds: number;
}
export type JwtConfig =
  | (JwtCommonConfig & { readonly method: "hs256"; readonly secret: string })
  | (JwtCommonConfig & { readonly method: "jwks"; readonly jwksUrl: string });

/**
 * The JWT_* variables shared by every entry point that verifies access tokens. The signing
 * method is an explicit, required choice: `JWT_VERIFIER=hs256` needs JWT_SECRET (the legacy
 * Supabase JWT secret), `JWT_VERIFIER=jwks` needs JWT_JWKS_URL (asymmetric signing keys).
 */
export const jwtEnvSchema = z.object({
  JWT_VERIFIER: z.enum(JWT_VERIFIERS, { error: "JWT_VERIFIER must be hs256 or jwks" }),
  JWT_SECRET: z.string().optional(),
  JWT_JWKS_URL: z.string().optional(),
  JWT_ISSUER: z.string().min(1).optional(),
  // Default one hour, like Supabase Auth. Local dev raises it to accept the 7-day seed token.
  JWT_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600).default(DEFAULT_MAX_TOKEN_LIFETIME_SECONDS),
  // How far a token's iat may lie ahead of this server's clock. Default one minute.
  JWT_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(DEFAULT_CLOCK_SKEW_SECONDS),
}).transform((env, ctx): JwtConfig => {
  const common = {
    issuer: env.JWT_ISSUER,
    maxLifetimeSeconds: env.JWT_MAX_TTL_SECONDS,
    clockSkewSeconds: env.JWT_CLOCK_SKEW_SECONDS,
  };
  if (env.JWT_VERIFIER === "hs256") {
    if (env.JWT_SECRET === undefined) {
      ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "JWT_SECRET is required when JWT_VERIFIER=hs256" });
      return z.NEVER;
    }
    const secret = jwtSecretSchema.safeParse(env.JWT_SECRET);
    if (!secret.success) {
      for (const issue of secret.error.issues) ctx.addIssue({ code: "custom", path: ["JWT_SECRET"], message: issue.message });
      return z.NEVER;
    }
    return { ...common, method: "hs256", secret: secret.data };
  }
  if (env.JWT_JWKS_URL === undefined) {
    ctx.addIssue({ code: "custom", path: ["JWT_JWKS_URL"], message: "JWT_JWKS_URL is required when JWT_VERIFIER=jwks" });
    return z.NEVER;
  }
  const problem = jwksUrlProblem(env.JWT_JWKS_URL);
  if (problem) {
    ctx.addIssue({ code: "custom", path: ["JWT_JWKS_URL"], message: problem });
    return z.NEVER;
  }
  return { ...common, method: "jwks", jwksUrl: env.JWT_JWKS_URL };
});

/** One line per issue, `PATH: message`; never echoes the values. */
export function formatEnvIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return `Invalid environment: ${issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ")}`;
}

/** Parse the JWT_* variables from an environment object passed in by an entry point. */
export function parseJwtEnv(env: Readonly<Record<string, string | undefined>>): JwtConfig {
  const parsed = jwtEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(formatEnvIssues(parsed.error.issues));
  return parsed.data;
}

/** The verifier the config chooses, checking times against the injected clock. */
export function createVerifierFromConfig(config: JwtConfig, clock: { now(): Date }): TokenVerifier {
  const options: SupabaseTokenOptions = {
    clock,
    maxLifetimeSeconds: config.maxLifetimeSeconds,
    clockSkewSeconds: config.clockSkewSeconds,
    ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
  };
  if (config.method === "hs256") return createHs256Verifier(config.secret, options);
  const problem = jwksUrlProblem(config.jwksUrl);
  if (problem) throw new Error(problem);
  return createJwksVerifier(createRemoteJWKSet(new URL(config.jwksUrl)), options);
}
