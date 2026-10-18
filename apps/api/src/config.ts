import { z } from "zod";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Dev scripts may only touch a loopback database: never Supabase or any shared host. */
export function assertLocalDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !LOOPBACK.has(url.hostname.toLowerCase()))
    throw new Error("Refusing to run: DATABASE_URL must point at 127.0.0.1 or localhost");
  return url;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});
export interface ServerEnv {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
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
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
  };
}
