import { parse } from "pg-connection-string";
import { z } from "zod";

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

/** Non-secret fields only, for logs: never the password or the raw URL. */
export function describeDatabase(target: LocalDatabaseTarget): { host: string; port: string; database: string } {
  return { host: target.host, port: target.port, database: target.database };
}

/** The value shipped in .env.example; a server that still uses it must not start. */
export const PLACEHOLDER_JWT_SECRET = "replace-with-a-local-dev-secret-of-32-or-more-chars";
export const jwtSecretSchema = z.string()
  .min(32, "JWT_SECRET must be at least 32 characters")
  .refine((value) => value !== PLACEHOLDER_JWT_SECRET, "JWT_SECRET is still the .env.example placeholder");

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: jwtSecretSchema,
  JWT_ISSUER: z.string().min(1).optional(),
  // Default one hour, like Supabase Auth. Local dev raises it to accept the 7-day seed token.
  JWT_MAX_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600).default(3600),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});
export interface ServerEnv {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly jwtIssuer: string | undefined;
  readonly jwtMaxLifetimeSeconds: number;
  readonly allowedOrigins: string[];
  readonly port: number;
}

/** Parse an environment object passed in by an entry point; this module never reads process.env. */
export function parseServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    jwtIssuer: parsed.data.JWT_ISSUER,
    jwtMaxLifetimeSeconds: parsed.data.JWT_MAX_TTL_SECONDS,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
  };
}
