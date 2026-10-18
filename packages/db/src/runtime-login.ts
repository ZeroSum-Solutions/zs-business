import type { Pool } from "pg";

/**
 * Startup guard for the API and MCP entry points: refuse a runtime pool whose login is a
 * superuser, has BYPASSRLS or CREATEROLE, or owns a table, view, sequence or function in
 * public or zs_internal (the migrator), directly or through a role it belongs to
 * (service_role, zs_dispatcher). Walks from the authenticated backend user in
 * pg_stat_activity, which SET SESSION AUTHORIZATION and SET ROLE cannot change: a superuser
 * that switched to the runtime role could RESET back. session_user and current_user are
 * checked too. Our own pg_stat_activity row is always visible; if it is missing, the guard
 * fails closed. Run it before listening, so a misconfigured DATABASE_URL never serves a request.
 */
export async function assertRuntimeLogin(pool: Pool): Promise<void> {
  const login = (await pool.query<{
    login: string | null; rolsuper: boolean | null; rolbypassrls: boolean | null;
    rolcreaterole: boolean | null; owns: boolean | null;
  }>(
    `WITH backend AS (
       SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid = pg_catalog.pg_backend_pid()
     ), reach AS (
       SELECT oid, rolsuper, rolbypassrls, rolcreaterole FROM pg_catalog.pg_roles
        WHERE pg_catalog.pg_has_role((SELECT usesysid FROM backend), oid, 'MEMBER')
           OR pg_catalog.pg_has_role(session_user, oid, 'MEMBER')
           OR pg_catalog.pg_has_role(current_user, oid, 'MEMBER')
     )
     SELECT (SELECT usesysid::text FROM backend) AS login,
            bool_or(rolsuper) AS rolsuper, bool_or(rolbypassrls) AS rolbypassrls,
            bool_or(rolcreaterole) AS rolcreaterole,
            EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                     WHERE c.relnamespace IN ('public'::regnamespace, coalesce(to_regnamespace('zs_internal'), 'public'::regnamespace))
                       AND c.relowner IN (SELECT oid FROM reach))
              OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                     WHERE p.pronamespace = 'public'::regnamespace AND p.proowner IN (SELECT oid FROM reach)) AS owns
       FROM reach`,
  )).rows[0];
  if (!login?.login || login.rolsuper !== false || login.rolbypassrls !== false || login.rolcreaterole !== false || login.owns !== false)
    throw new Error("Refusing to start: DATABASE_URL must log in as an unprivileged runtime role, not a superuser, BYPASSRLS, CREATEROLE or owner role");
}
