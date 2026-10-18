// M2a authorization: every request maps the token's user to a tenant_members row, and every
// tenant transaction re-reads it before it reads or writes, so a removal or a role change
// takes effect on the next transaction. Runs as the runtime role under RLS.
import { TenantDenied, roleCan, type MemberRole, type Permission } from "@zs/contracts";
import type { Transaction } from "@zs/db";

export interface MemberAccess {
  readonly memberId: string;
  readonly role: MemberRole;
}

/**
 * Membership changes take this lock exclusively and every other transaction takes it shared
 * before reading the caller's role, so no write runs on a role that a committed removal or
 * demotion already took away. Always taken first in a transaction, before any other lock.
 */
export async function lockMembership(tx: Transaction, tenantId: string, mode: "shared" | "exclusive"): Promise<void> {
  const lock = mode === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
  await tx.query(`SELECT pg_catalog.${lock}(pg_catalog.hashtextextended($1, 0))`, [`${tenantId}:members`]);
}

/** The caller's membership in the tenant, or null. Pending invites (no user yet) never match. */
export async function findMembership(tx: Transaction, tenantId: string, userId: string): Promise<MemberAccess | null> {
  const row = (await tx.query<{ id: string; role: MemberRole }>(
    "SELECT id, role::text AS role FROM tenant_members WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, userId],
  )).rows[0];
  return row ? { memberId: row.id, role: row.role } : null;
}

/** Lock, then require a membership whose role grants `permission` (null: any member). */
export async function requireMember(
  tx: Transaction,
  tenantId: string,
  userId: string,
  permission: Permission | null,
  lock: "shared" | "exclusive" = "shared",
): Promise<MemberAccess> {
  await lockMembership(tx, tenantId, lock);
  const access = await findMembership(tx, tenantId, userId);
  if (!access || (permission !== null && !roleCan(access.role, permission))) throw new TenantDenied();
  return access;
}

/** True when the Supabase session behind a token is live: not signed out, expired or banned. */
export async function sessionIsLive(tx: Transaction, sessionId: string, userId: string, now: Date): Promise<boolean> {
  const row = (await tx.query<{ live: boolean }>(
    "SELECT public.auth_session_is_live($1, $2, $3) AS live", [sessionId, userId, now],
  )).rows[0];
  return row?.live === true;
}
