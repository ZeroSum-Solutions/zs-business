// Guards for anything that may only touch a loopback database: dev scripts, the demo seed and
// the local auth stub. Never Supabase or any shared host.
import type { Pool } from "pg";
import { parse } from "pg-connection-string";

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
