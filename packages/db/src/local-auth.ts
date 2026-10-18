/**
 * Local stand-in for the two Supabase Auth tables the API reads: auth.users and auth.sessions,
 * with only the columns `auth_session_is_live` uses (plus email and app metadata, which a fake
 * auth server needs to mint tokens). Plain Postgres has no auth schema, so tests, the demo seed
 * and e2e:live install this stub; it is never part of a shipped migration.
 *
 * Every function here refuses a pool that is not on loopback, and installAuthStub refuses a
 * database that already holds a real Supabase auth schema.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function assertLoopbackPool(pool: Pool): void {
  const { connectionString } = pool.options;
  let host: string | undefined;
  try {
    host = connectionString ? new URL(connectionString).hostname.toLowerCase() : undefined;
  } catch {
    host = undefined;
  }
  if (!host || !LOOPBACK.has(host) || pool.options.host !== undefined)
    throw new Error("The local auth stub only runs against a loopback database built from a connection string");
}

/**
 * Idempotent; run as an administrative login. Before migrate() has created zs_session_reader the
 * stub is created without grants, and the migration grants on it as it would on Supabase.
 */
export async function installAuthStub(pool: Pool): Promise<void> {
  assertLoopbackPool(pool);
  const real = await pool.query<{ real: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin')
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('auth.users') AND attname = 'encrypted_password') AS real`);
  if (real.rows[0]?.real) throw new Error("Refusing to stub auth: this database has a real Supabase auth schema");
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    REVOKE ALL ON SCHEMA auth FROM PUBLIC;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      banned_until timestamptz,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS auth.sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      not_after timestamptz
    );
    REVOKE ALL ON auth.users, auth.sessions FROM PUBLIC;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zs_session_reader') THEN
        GRANT USAGE ON SCHEMA auth TO zs_session_reader;
        GRANT SELECT (id, user_id, not_after) ON auth.sessions TO zs_session_reader;
        GRANT SELECT (id, banned_until, deleted_at) ON auth.users TO zs_session_reader;
      END IF;
    END $$;
  `);
}

export interface LocalAuthUser {
  readonly id?: string;
  readonly email: string;
  /** Becomes the token's app_metadata, for example `{ tenant_id }`. */
  readonly appMetadata?: Record<string, unknown>;
}

/** Insert (or update) a user; returns its id. */
export async function upsertAuthUser(pool: Pool, user: LocalAuthUser): Promise<string> {
  assertLoopbackPool(pool);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ($1, lower($2), $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, raw_app_meta_data = EXCLUDED.raw_app_meta_data
     RETURNING id`,
    [user.id ?? randomUUID(), user.email, JSON.stringify(user.appMetadata ?? {})],
  );
  return rows[0]!.id;
}

/** Start a session for the user, as a sign-in does; returns the session id for the token's `session_id`. */
export async function startAuthSession(pool: Pool, userId: string, options: { id?: string; notAfter?: Date } = {}): Promise<string> {
  assertLoopbackPool(pool);
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO auth.sessions (id, user_id, not_after) VALUES ($1, $2, $3) RETURNING id",
    [options.id ?? randomUUID(), userId, options.notAfter ?? null],
  );
  return rows[0]!.id;
}

/** End a session, as Supabase signOut does: the row is deleted. */
export async function endAuthSession(pool: Pool, sessionId: string): Promise<void> {
  assertLoopbackPool(pool);
  await pool.query("DELETE FROM auth.sessions WHERE id = $1", [sessionId]);
}
