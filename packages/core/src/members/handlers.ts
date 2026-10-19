// Member actions: invite, change role, remove. Owners only (the edge checks the "members"
// permission inside the same transaction, under the exclusive membership lock).
import {
  Conflict,
  changeMemberRoleCommandSchema,
  inviteMemberCommandSchema,
  removeMemberCommandSchema,
  type MemberRecord,
  type MemberRole,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { idInUse, iso, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { lockMembership, requireMember } from "./access.js";

interface MemberRow {
  id: string;
  tenant_id: string;
  email: string;
  user_id: string | null;
  role: MemberRole;
  created_at: Date;
  updated_at: Date;
}
export const memberColumns = "id,tenant_id,email,user_id,role::text AS role,created_at,updated_at";

export function memberRecord(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    userId: row.user_id,
    role: row.role,
    status: row.user_id === null ? "invited" : "active",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function loadMember(tx: Transaction, tenantId: string, memberId: string): Promise<MemberRow | undefined> {
  return (await tx.query<MemberRow>(
    `SELECT ${memberColumns} FROM tenant_members WHERE tenant_id=$1 AND id=$2`, [tenantId, memberId],
  )).rows[0];
}

/** Owners who have signed in. Pending owner invites do not count: they may never be accepted. */
async function activeOwners(tx: Transaction, tenantId: string): Promise<number> {
  return Number((await tx.query<{ n: string }>(
    "SELECT count(*) AS n FROM tenant_members WHERE tenant_id=$1 AND role='owner' AND user_id IS NOT NULL", [tenantId],
  )).rows[0]!.n);
}

/**
 * Owners only, checked by the handler too: a dispatcher built without the edge's authorize
 * hook still cannot change members. The edge already holds the exclusive lock; taking it again
 * in the same transaction is a no-op.
 */
const requireOwner = (tx: Transaction, tenantId: string, actorId: string) =>
  requireMember(tx, tenantId, actorId, "members", "exclusive");

const lastOwner = () => new Conflict("A business needs at least one owner", { reason: "last_owner" });

/** An existing member of this tenant, under the exclusive membership lock. */
const resolveExistingMember: ActionHandler["resolveTarget"] = async (tx, target) => {
  if (target.type !== "member") return null;
  await lockMembership(tx, target.tenantId, "exclusive");
  return (await loadMember(tx, target.tenantId, target.id)) ? { tenantId: target.tenantId, type: "member", id: target.id } : null;
};

export const inviteMemberHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "member" || !(await tenantVisible(tx, target.tenantId))) return null;
    await lockMembership(tx, target.tenantId, "exclusive");
    if (await loadMember(tx, target.tenantId, target.id)) throw idInUse("member");
    return { tenantId: target.tenantId, type: "member", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    await requireOwner(tx, binding.tenantId, binding.actorId);
    const { payload } = parseOrFail(inviteMemberCommandSchema, command);
    const taken = await tx.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND email=$2", [binding.tenantId, payload.email]);
    if (taken.rowCount) throw new Conflict("That email is already a member", { reason: "member_exists" });
    const row = (await tx.query<MemberRow>(
      `INSERT INTO tenant_members (tenant_id,id,email,role,invited_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING ${memberColumns}`,
      [binding.tenantId, payload.memberId, payload.email, payload.role, binding.actorId, now],
    )).rows[0]!;
    // The outbox event carries the invite to the worker that emails it and binds the account.
    const record = memberRecord(row);
    return { result: record, event: { type: "member.invited", payload: { memberId: record.id, email: record.email, role: record.role } } };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "tenant_members_tenant_email")
      return new Conflict("That email is already a member", { reason: "member_exists" });
    if (pgCode(error) === "23505" && pgConstraint(error) === "tenant_members_pkey")
      return new Conflict("The member ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

export const changeMemberRoleHandler: ActionHandler = {
  resolveTarget: resolveExistingMember,
  async handle({ tx, command, binding, now }) {
    await requireOwner(tx, binding.tenantId, binding.actorId);
    const { payload } = parseOrFail(changeMemberRoleCommandSchema, command);
    const member = (await loadMember(tx, binding.tenantId, payload.memberId))!;
    if (member.role === payload.role) return { result: memberRecord(member) };
    if (member.role === "owner" && member.user_id !== null && (await activeOwners(tx, binding.tenantId)) < 2) throw lastOwner();
    const row = (await tx.query<MemberRow>(
      `UPDATE tenant_members SET role=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 RETURNING ${memberColumns}`,
      [binding.tenantId, payload.memberId, payload.role, now],
    )).rows[0]!;
    return { result: memberRecord(row) };
  },
};

export const removeMemberHandler: ActionHandler = {
  resolveTarget: resolveExistingMember,
  async handle({ tx, command, binding }) {
    await requireOwner(tx, binding.tenantId, binding.actorId);
    const { payload } = parseOrFail(removeMemberCommandSchema, command);
    const member = (await loadMember(tx, binding.tenantId, payload.memberId))!;
    if (member.role === "owner" && member.user_id !== null && (await activeOwners(tx, binding.tenantId)) < 2) throw lastOwner();
    await tx.query("DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.memberId]);
    return { result: { id: payload.memberId, removed: true } };
  },
};

export const memberHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "member.invite": inviteMemberHandler,
  "member.change-role": changeMemberRoleHandler,
  "member.remove": removeMemberHandler,
});

export async function listMembers(tx: Transaction, tenantId: string): Promise<MemberRecord[]> {
  return (await tx.query<MemberRow>(
    `SELECT ${memberColumns} FROM tenant_members WHERE tenant_id=$1 ORDER BY created_at, email`, [tenantId],
  )).rows.map(memberRecord);
}
