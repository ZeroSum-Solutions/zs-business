import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { parse } from "pg-connection-string";

/** Supavisor hosts for hosted Supabase projects, for example aws-0-us-east-1.pooler.supabase.com. */
const POOLER_HOST = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const PROJECT_REF = /^[a-z]{20}$/;
const PLAIN_FIELDS = new Set(["user", "password", "host", "port", "database"]);

export interface HostedDatabaseTarget {
  readonly connectionString: string;
  readonly projectRef: string;
  /** The Postgres role, without the `.project_ref` suffix Supavisor needs. */
  readonly role: string;
  readonly host: string;
  readonly port: string;
}

function refuse(reason: string): never {
  throw new Error(`Refusing to run: ${reason}`);
}

/**
 * Owner-run hosted scripts may only reach a Supabase pooler URL for the one project named in
 * ZS_TARGET_REF, as the expected role. Query parameters are refused, so nothing can
 * override the host, the port or TLS; TLS is set from the pinned CA in hostedPool.
 */
export function assertHostedDatabaseUrl(value: string, expected: { projectRef: string; role: string }): HostedDatabaseTarget {
  if (!PROJECT_REF.test(expected.projectRef)) refuse("ZS_TARGET_REF must be a Supabase project ref");
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
  if (!POOLER_HOST.test(host)) refuse("database URL must point at a Supabase pooler host");
  if (config.user !== `${expected.role}.${expected.projectRef}`)
    refuse(`database URL must log in as ${expected.role} on project ${expected.projectRef}`);
  if ((config.database ?? "") !== "postgres") refuse("database URL must name the postgres database");
  return { connectionString: value, projectRef: expected.projectRef, role: expected.role, host, port: config.port || "5432" };
}

/** The Supabase Root 2021 CA, which signs every pooler certificate; committed next to the SQL. */
export function supabaseCa(): string {
  return readFileSync(new URL("../../../supabase/hosted/supabase-root-2021-ca.crt", import.meta.url), "utf8");
}

/** A pool for a checked hosted target, with full TLS verification against the pinned CA. */
export function hostedPool(target: HostedDatabaseTarget, max = 2): Pool {
  return new Pool({ connectionString: target.connectionString, max, ssl: { ca: supabaseCa(), rejectUnauthorized: true } });
}

/** Non-secret fields only, for logs and receipts. */
export function describeHosted(target: HostedDatabaseTarget): { projectRef: string; role: string; host: string; port: string } {
  return { projectRef: target.projectRef, role: target.role, host: target.host, port: target.port };
}
