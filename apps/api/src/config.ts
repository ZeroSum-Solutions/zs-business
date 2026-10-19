import type { Pool } from "pg";
import { parse } from "pg-connection-string";
import { z } from "zod";
import { formatEnvIssues, jwtEnvSchema, type JwtConfig } from "@zs/core";

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

// The JWT_* variables (signing method, secret or JWKS URL, issuer, lifetime, skew) are parsed
// by the schema in @zs/core, shared with the MCP server.
export { jwtSecretSchema, PLACEHOLDER_JWT_SECRET } from "@zs/core";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});
export interface ServerEnv {
  readonly databaseUrl: string;
  /** How access tokens are verified: `JWT_VERIFIER=hs256` with JWT_SECRET, or `jwks` with JWT_JWKS_URL. */
  readonly jwt: JwtConfig;
  readonly allowedOrigins: string[];
  readonly port: number;
}

/** Parse an environment object passed in by an entry point; this module never reads process.env. */
export function parseServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  const parsed = envSchema.safeParse(env);
  const jwt = jwtEnvSchema.safeParse(env);
  if (!parsed.success || !jwt.success)
    throw new Error(formatEnvIssues([...(parsed.error?.issues ?? []), ...(jwt.error?.issues ?? [])]));
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwt: jwt.data,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
  };
}
