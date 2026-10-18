import type { Pool } from "pg";

/**
 * Startup guard for the API and MCP entry points: refuse a runtime pool whose login is a
 * superuser or has BYPASSRLS, directly or through a role it belongs to (service_role).
 * Run it before listening, so a misconfigured DATABASE_URL never serves a request.
 */
export async function assertRuntimeLogin(pool: Pool): Promise<void> {
  const login = (await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT bool_or(rolsuper) AS rolsuper, bool_or(rolbypassrls) AS rolbypassrls
       FROM pg_roles WHERE pg_has_role(current_user, oid, 'MEMBER')`,
  )).rows[0];
  if (!login || login.rolsuper !== false || login.rolbypassrls !== false)
    throw new Error("Refusing to start: DATABASE_URL must log in as an unprivileged runtime role, not a superuser or BYPASSRLS role");
}
