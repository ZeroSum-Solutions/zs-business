import type { Pool } from "pg";

/**
 * Startup guard for the API and MCP entry points: refuse a runtime pool whose login is a
 * superuser or has BYPASSRLS, directly or through a role it belongs to (service_role).
 * Walks from the authenticated backend user in pg_stat_activity, which SET SESSION
 * AUTHORIZATION and SET ROLE cannot change: a superuser that switched to the runtime role
 * could RESET back. session_user and current_user are checked too. Our own pg_stat_activity
 * row is always visible; if it is missing, the guard fails closed. Run it before listening,
 * so a misconfigured DATABASE_URL never serves a request.
 */
export async function assertRuntimeLogin(pool: Pool): Promise<void> {
  const login = (await pool.query<{ login: string | null; rolsuper: boolean | null; rolbypassrls: boolean | null }>(
    `WITH backend AS (
       SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()
     )
     SELECT (SELECT usesysid::text FROM backend) AS login,
            bool_or(rolsuper) AS rolsuper, bool_or(rolbypassrls) AS rolbypassrls
       FROM pg_catalog.pg_roles
      WHERE pg_catalog.pg_has_role((SELECT usesysid FROM backend), oid, 'MEMBER')
         OR pg_catalog.pg_has_role(session_user, oid, 'MEMBER')
         OR pg_catalog.pg_has_role(current_user, oid, 'MEMBER')`,
  )).rows[0];
  if (!login?.login || login.rolsuper !== false || login.rolbypassrls !== false)
    throw new Error("Refusing to start: DATABASE_URL must log in as an unprivileged runtime role, not a superuser or BYPASSRLS role");
}
