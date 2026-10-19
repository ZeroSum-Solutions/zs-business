/**
 * Local stand-in for Supabase Auth's two tables: auth.users and auth.sessions, with only the
 * columns a session check needs (plus email and app metadata, which a fake auth server needs to
 * mint tokens). Plain Postgres has no auth schema, so tests, the demo seed and e2e:live install
 * this stub; it is never part of a shipped migration. Like hosted Supabase, both tables have RLS
 * on and no policies, so only their owner reads them.
 *
 * zs_local_auth.session_is_live(session, user, now) answers the API's session check when it runs
 * with SESSION_CHECK=local-stub. It is SECURITY DEFINER, owned by the login that installs the
 * stub (the tables' owner), and the runtime role may only execute it. Hosted deploys ask
 * Supabase Auth instead (@zs/core createSupabaseSessionCheck).
 *
 * Every function here refuses a pool that is not on loopback (assertLocalPool: the effective
 * pg destination, so no query string can point it elsewhere), and installAuthStub refuses a
 * database that already holds a real Supabase auth schema.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { assertLocalPool } from "./local-target.js";

function assertLoopbackPool(pool: Pool): void {
  try {
    assertLocalPool(pool);
  } catch {
    throw new Error("The local auth stub only runs against a loopback database built from a plain connection string");
  }
}

/** Idempotent; run as an administrative login, after migrate() has created the runtime roles. */
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
    ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
    CREATE SCHEMA IF NOT EXISTS zs_local_auth;
    REVOKE ALL ON SCHEMA zs_local_auth FROM PUBLIC;
    CREATE OR REPLACE FUNCTION zs_local_auth.session_is_live(p_session uuid, p_user uuid, p_now timestamptz)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
      SELECT p_session IS NOT NULL AND p_user IS NOT NULL AND p_now IS NOT NULL AND EXISTS (
        SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
        WHERE s.id = p_session AND s.user_id = p_user
          AND (s.not_after IS NULL OR s.not_after > p_now)
          AND (u.banned_until IS NULL OR u.banned_until <= p_now)
          AND u.deleted_at IS NULL)
    $fn$;
    REVOKE ALL ON FUNCTION zs_local_auth.session_is_live(uuid, uuid, timestamptz) FROM PUBLIC;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT USAGE ON SCHEMA zs_local_auth TO authenticated;
        GRANT EXECUTE ON FUNCTION zs_local_auth.session_is_live(uuid, uuid, timestamptz) TO authenticated;
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
