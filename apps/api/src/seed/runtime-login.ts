import type { Pool } from "pg";

/**
 * Local dev only: make sure the API's runtime LOGIN role exists, is unprivileged and is a
 * member of `authenticated` only, the same rules the test harness applies.
 */
export async function ensureRuntimeLogin(admin: Pool, login: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login)) throw new Error("Runtime login must be a plain lowercase role name");
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('zs-business:test-logins',0))");
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN
        CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}' AND
        (NOT rolcanlogin OR NOT rolinherit OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
        OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='${login}'::regrole AND roleid <> 'authenticated'::regrole) THEN
        RAISE EXCEPTION 'Unsafe runtime login role ${login}';
      END IF;
    END $$; GRANT authenticated TO ${login};`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
