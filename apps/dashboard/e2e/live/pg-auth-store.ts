/**
 * The fake GoTrue's users and sessions, kept in the local auth stub (auth.users, auth.sessions)
 * of this run's throwaway database. The API asks the fake's GET /auth/v1/user, which reads
 * these rows, so a sign-out through the fake is refused by the API at once, as with real Supabase.
 */
import pg from "pg";
import type { AuthStore, FakeUser } from "./fake-gotrue";

interface UserRow {
  id: string;
  email: string;
  raw_app_meta_data: Record<string, unknown>;
}

const toUser = (row: UserRow | undefined): FakeUser | null =>
  row ? { id: row.id, email: row.email, appMetadata: row.raw_app_meta_data } : null;

export function pgAuthStore(pool: pg.Pool): AuthStore {
  const user = async (where: string, value: string) =>
    toUser((await pool.query<UserRow>(
      `SELECT id, email, raw_app_meta_data FROM auth.users
       WHERE ${where} = $1 AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until <= now())`,
      [value],
    )).rows[0]);
  return {
    userByEmail: (email) => user("email", email.toLowerCase()),
    userById: (id) => user("id::text", id),
    async startSession(userId) {
      const { rows } = await pool.query<{ id: string }>("INSERT INTO auth.sessions (id, user_id) VALUES (gen_random_uuid(), $1) RETURNING id", [userId]);
      return rows[0]!.id;
    },
    async sessionIsLive(sessionId) {
      const { rows } = await pool.query("SELECT 1 FROM auth.sessions WHERE id::text = $1 AND (not_after IS NULL OR not_after > now())", [sessionId]);
      return rows.length > 0;
    },
    async endSession(sessionId) {
      await pool.query("DELETE FROM auth.sessions WHERE id::text = $1", [sessionId]);
    },
    async endUserSessions(userId, keep) {
      await pool.query("DELETE FROM auth.sessions WHERE user_id::text = $1 AND id::text IS DISTINCT FROM $2", [userId, keep ?? null]);
    },
  };
}
