import type { Pool } from "pg";
import { parse } from "pg-connection-string";
import { z } from "zod";
import { trimTrailingSlashes } from "@zs/core";
import { trustedProxyList, type ClientIpConfig } from "./public/client-ip.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** The only fields a plain postgres URL yields; anything else came from a query parameter. */
const PLAIN_FIELDS = new Set(["user", "password", "host", "port", "database"]);

export interface LocalDatabaseTarget {
  /** The validated string, unchanged: pass exactly this to `pg`. */
  readonly connectionString: string;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
}

function refuse(reason: string): never {
  throw new Error(`Refusing to run: ${reason}`);
}

/**
 * Dev scripts may only touch a loopback database: never Supabase or any shared host.
 * Checks the destination `pg` will actually use (it parses with pg-connection-string, where
 * query parameters such as host, hostaddr and port override the URL), so any query string,
 * unix-socket path or multi-host list is refused outright.
 */
export function assertLocalDatabaseUrl(value: string): LocalDatabaseTarget {
  if (!/^postgres(ql)?:\/\//i.test(value)) refuse("database URL must be a postgres:// URL");
  if (value.includes("?")) refuse("database URL must not carry query parameters");
  let config: ReturnType<typeof parse>;
  try {
    config = parse(value);
  } catch {
    refuse("database URL is not a valid URL");
  }
  const extra = Object.keys(config).filter((key) => config[key] !== undefined && !PLAIN_FIELDS.has(key));
  if (extra.length > 0) refuse(`database URL must not set ${extra.join(", ")}`);
  const host = (config.host ?? "").toLowerCase();
  if (!LOOPBACK.has(host)) refuse("database URL must point at 127.0.0.1 or localhost");
  return {
    connectionString: value,
    host,
    port: config.port || "5432",
    database: config.database ?? "",
    user: config.user ?? "",
  };
}

/** The pool's own destination must pass assertLocalDatabaseUrl: a connection string and no override fields. */
export function assertLocalPool(pool: Pool): LocalDatabaseTarget {
  const { connectionString, host, port, user, database } = pool.options;
  if (typeof connectionString !== "string") refuse("database pool must be built from a checked connection string");
  if ([host, port, user, database].some((value) => value !== undefined))
    refuse("database pool must not override the connection string's host, port, user or database");
  return assertLocalDatabaseUrl(connectionString);
}

/** Non-secret fields only, for logs: never the password or the raw URL. */
export function describeDatabase(target: LocalDatabaseTarget): { host: string; port: string; database: string } {
  return { host: target.host, port: target.port, database: target.database };
}

/** The value shipped in .env.example; a server that still uses it must not start. */
export const PLACEHOLDER_JWT_SECRET = "replace-with-a-local-dev-secret-of-32-or-more-chars";
export const jwtSecretSchema = z.string()
  .min(32, "JWT_SECRET must be at least 32 characters")
  .refine((value) => value !== PLACEHOLDER_JWT_SECRET, "JWT_SECRET is still the .env.example placeholder");

/** The .env.example value for the booking key secret; a server that still uses it must not start. */
export const PLACEHOLDER_BOOKING_KEY_SECRET = "replace-with-a-booking-key-secret-of-32-or-more-chars";
const bookingKeySecretSchema = z.string()
  .min(32, "booking key secrets must be at least 32 characters")
  .refine((value) => value !== PLACEHOLDER_BOOKING_KEY_SECRET, "booking key secret is still the .env.example placeholder");
/** Headers that hosting platforms overwrite, so a caller cannot choose the value. */
export const CLIENT_IP_HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "cf-connecting-ip", "fly-client-ip"] as const;
const rateLimit = z.coerce.number().int().min(1).max(1_000_000).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: jwtSecretSchema,
  JWT_ISSUER: z.string().min(1).optional(),
  // Default one hour, like Supabase Auth. Local dev raises it to accept the 7-day seed token.
  JWT_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600).default(3600),
  // How far a token's iat may lie ahead of this server's clock. Default one minute.
  JWT_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(60),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // public-intake.md P-2: signs booking page keys. Unset turns the public booking routes off.
  PUBLIC_BOOKING_KEY_SECRET: bookingKeySecretSchema.optional(),
  // The previous secret keeps verifying during a rotation; keys are re-signed with the current one.
  PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: bookingKeySecretSchema.optional(),
  // Origin of the hosted booking page and embed script; defaults to http://localhost:<PORT>.
  PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  // P-10: a header the host overwrites on every request (Vercel: x-vercel-forwarded-for or
  // x-real-ip), set only when the API is reachable through that host alone.
  PUBLIC_CLIENT_IP_HEADER: z.enum(CLIENT_IP_HEADERS).optional(),
  // Or: comma-separated CIDRs of the proxies whose X-Forwarded-For entries count.
  PUBLIC_TRUSTED_PROXIES: z.string().optional(),
  PUBLIC_RATE_ADDRESS_WRITES: rateLimit,
  PUBLIC_RATE_ADDRESS_READS: rateLimit,
  PUBLIC_RATE_TENANT_WRITES: rateLimit,
  // PEM of the CA that signs the database's TLS certificate (hosted Supabase: the Supabase
  // Root 2021 CA in supabase/hosted/). Set: TLS with full verification. Required for any
  // host other than loopback; only a loopback database may use plain TCP.
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // Longest wait for a pooled connection; node-postgres would otherwise wait forever.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  // Longest time one /v1 request may take; keep it under the dashboard proxy's 15 s.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
}).superRefine((env, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  let host: string;
  try {
    // The host pg will actually use: a query parameter such as host overrides the URL's.
    host = (parse(env.DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    // Never echo the value: it holds the password.
    issue("DATABASE_URL", "is not a valid connection string");
    return;
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && env.DATABASE_CA_CERT === undefined)
    issue("DATABASE_CA_CERT", "is required when DATABASE_URL is not a loopback host (127.0.0.1, ::1, localhost)");
  // pg lets URL options (ssl, sslmode, also percent-encoded) replace the ssl config, which
  // would drop the CA check or TLS itself, so a remote or verified URL carries no query string.
  if ((!loopback || env.DATABASE_CA_CERT !== undefined) && env.DATABASE_URL.includes("?"))
    issue("DATABASE_URL", "must not carry a query string when it is not a loopback host or DATABASE_CA_CERT is set");
});
export interface ServerEnv {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly jwtIssuer: string | undefined;
  readonly jwtMaxLifetimeSeconds: number;
  readonly jwtClockSkewSeconds: number;
  readonly allowedOrigins: string[];
  readonly port: number;
  readonly databaseCaCert: string | undefined;
  readonly databasePoolMax: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly publicIntake: PublicIntakeEnv | null;
}
export interface PublicIntakeEnv {
  readonly keySecrets: { readonly current: string; readonly previous?: string };
  readonly publicBaseUrl: string;
  readonly clientIp: ClientIpConfig;
  /** Per-window counts that override the P-10 defaults; windows stay fixed. */
  readonly limitOverrides: { readonly addressWrites?: number; readonly addressReads?: number; readonly tenantWrites?: number };
}

/** Parse an environment object passed in by an entry point; this module never reads process.env. */
export function parseServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  // A stale TRUST_PROXY=1 would otherwise be ignored silently and every caller share one bucket.
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== "0")
    throw new Error("Invalid environment: TRUST_PROXY was replaced by PUBLIC_CLIENT_IP_HEADER or PUBLIC_TRUSTED_PROXIES");
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtIssuer: parsed.data.JWT_ISSUER,
    jwtMaxLifetimeSeconds: parsed.data.JWT_MAX_TTL_SECONDS,
    jwtClockSkewSeconds: parsed.data.JWT_CLOCK_SKEW_SECONDS,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
    databaseCaCert: parsed.data.DATABASE_CA_CERT,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    connectTimeoutMs: parsed.data.DATABASE_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
    publicIntake: parsePublicIntake(parsed.data),
  };
}

function parseClientIp(data: z.infer<typeof envSchema>): ClientIpConfig {
  const proxies = (data.PUBLIC_TRUSTED_PROXIES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (data.PUBLIC_CLIENT_IP_HEADER !== undefined && proxies.length > 0)
    throw new Error("Invalid environment: set PUBLIC_CLIENT_IP_HEADER or PUBLIC_TRUSTED_PROXIES, not both");
  try {
    trustedProxyList(proxies);
  } catch (error) {
    throw new Error(`Invalid environment: PUBLIC_TRUSTED_PROXIES: ${(error as Error).message}`);
  }
  if (data.PUBLIC_CLIENT_IP_HEADER !== undefined) return { header: data.PUBLIC_CLIENT_IP_HEADER };
  return proxies.length > 0 ? { trustedProxies: proxies } : {};
}

function parsePublicIntake(data: z.infer<typeof envSchema>): PublicIntakeEnv | null {
  if (data.PUBLIC_BOOKING_KEY_SECRET === undefined) {
    if (data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET !== undefined)
      throw new Error("Invalid environment: PUBLIC_BOOKING_KEY_PREVIOUS_SECRET needs PUBLIC_BOOKING_KEY_SECRET");
    return null;
  }
  const limitOverrides = Object.fromEntries(Object.entries({
    addressWrites: data.PUBLIC_RATE_ADDRESS_WRITES,
    addressReads: data.PUBLIC_RATE_ADDRESS_READS,
    tenantWrites: data.PUBLIC_RATE_TENANT_WRITES,
  }).filter(([, value]) => value !== undefined));
  return {
    keySecrets: {
      current: data.PUBLIC_BOOKING_KEY_SECRET,
      ...(data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET === undefined ? {} : { previous: data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET }),
    },
    publicBaseUrl: trimTrailingSlashes(data.PUBLIC_BASE_URL ?? `http://localhost:${data.PORT}`),
    clientIp: parseClientIp(data),
    limitOverrides,
  };
}
