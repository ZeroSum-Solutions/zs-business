import { z } from "zod";
import { formatEnvIssues, jwtEnvSchema, sessionCheckEnvSchema, type JwtConfig, type SessionCheckConfig } from "@zs/core";
import { assertLocalDatabaseUrl } from "@zs/db";

// The JWT_* variables (signing method, secret or JWKS URL, issuer, lifetime, skew) are parsed
// by the schema in @zs/core, shared with the MCP server.
export { jwtSecretSchema, PLACEHOLDER_JWT_SECRET } from "@zs/core";
export { assertLocalDatabaseUrl, assertLocalPool, describeDatabase, type LocalDatabaseTarget } from "@zs/db";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Longest wait for a pooled connection; node-postgres would otherwise wait forever.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  // Longest time one /v1 request may take; keep it under the dashboard proxy's 15 s.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
});
export interface ServerEnv {
  readonly databaseUrl: string;
  /** How access tokens are verified: `JWT_VERIFIER=hs256` with JWT_SECRET, or `jwks` with JWT_JWKS_URL. */
  readonly jwt: JwtConfig;
  /** How a token's session is checked: `SESSION_CHECK=supabase` (Supabase Auth) or `local-stub` (loopback only). */
  readonly sessionCheck: SessionCheckConfig;
  readonly allowedOrigins: string[];
  readonly port: number;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

/** Parse an environment object passed in by an entry point; this module never reads process.env. */
export function parseServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  const parsed = envSchema.safeParse(env);
  const jwt = jwtEnvSchema.safeParse(env);
  const sessionCheck = sessionCheckEnvSchema.safeParse(env);
  const issues = [...(parsed.error?.issues ?? []), ...(jwt.error?.issues ?? []), ...(sessionCheck.error?.issues ?? [])];
  if (parsed.success && sessionCheck.success) issues.push(...localStubIssues(sessionCheck.data, parsed.data.DATABASE_URL));
  if (!parsed.success || !jwt.success || !sessionCheck.success || issues.length > 0) throw new Error(formatEnvIssues(issues));
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwt: jwt.data,
    sessionCheck: sessionCheck.data,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
    poolMax: parsed.data.DATABASE_POOL_MAX,
    connectTimeoutMs: parsed.data.DATABASE_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
  };
}

/** The local auth stub exists only on loopback databases; refuse it anywhere else. */
export function localStubIssues(config: SessionCheckConfig, databaseUrl: string): z.core.$ZodIssue[] {
  if (config.method !== "local-stub") return [];
  try {
    assertLocalDatabaseUrl(databaseUrl);
    return [];
  } catch {
    return [{ code: "custom", path: ["SESSION_CHECK"], message: "SESSION_CHECK=local-stub needs a loopback DATABASE_URL", input: undefined }];
  }
}
