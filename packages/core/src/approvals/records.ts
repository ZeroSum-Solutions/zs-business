// Approval rows and the checks every reader shares (approvals.md A-3, A-7, A-10, A-11).
// Runs as the runtime role inside ScopedDatabase.tenant; RLS limits rows to the tenant.
import {
  Conflict,
  TenantDenied,
  type ActionBinding,
  type ApprovalPage,
  type ApprovalRecord,
  type ApprovalStanding,
  type ApprovalStatus,
  type JsonValue,
  type ListApprovalsQuery,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "../reads/cursor.js";
import { page } from "../reads/page.js";

export interface ApprovalRow {
  id: string;
  tenant_id: string;
  action_type: string;
  target_type: string;
  target_id: string;
  payload: JsonValue;
  summary: string;
  status: ApprovalStatus;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_note: string | null;
  executed_action_id: string | null;
}

/** The action that ran under an approval, through the actions_tenant_approval index. */
const APPROVAL_SELECT = `
  SELECT a.id, a.tenant_id, a.action_type, a.target_type, a.target_id, a.payload, a.summary, a.status,
         a.requested_by, a.requested_at, a.expires_at, a.decided_by, a.decided_at, a.decision_note,
         a.revoked_by, a.revoked_at, a.revoke_note, x.id AS executed_action_id
    FROM approvals a
    LEFT JOIN actions x ON x.tenant_id = a.tenant_id AND x.approval_reference IS NOT NULL
     AND ((x.approval_reference->>'id')::uuid) = a.id`;

/** A-3: pending and approved approvals expire at `expires_at`; nothing writes that. */
export function standing(row: Pick<ApprovalRow, "status" | "expires_at">, now: Date): ApprovalStanding {
  if ((row.status === "pending" || row.status === "approved") && now.getTime() >= row.expires_at.getTime()) return "expired";
  return row.status;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

export function approvalRecord(row: ApprovalRow, now: Date): ApprovalRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionType: row.action_type,
    target: { tenantId: row.tenant_id, type: row.target_type, id: row.target_id },
    payload: row.payload,
    summary: row.summary,
    status: row.status,
    standing: standing(row, now),
    requestedBy: row.requested_by,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    decisionNote: row.decision_note,
    revokedBy: row.revoked_by,
    revokedAt: iso(row.revoked_at),
    revokeNote: row.revoke_note,
    executedActionId: row.executed_action_id,
  };
}

/** One approval; `lock` takes the row lock that decisions (FOR UPDATE) and runs (FOR SHARE) share. */
export async function loadApproval(
  tx: Transaction,
  tenantId: string,
  id: string,
  lock?: "update" | "share",
): Promise<ApprovalRow | null> {
  // Lock the approvals row only; the outer join's actions side cannot be locked.
  const suffix = lock ? ` FOR ${lock === "update" ? "UPDATE" : "SHARE"} OF a` : "";
  return (await tx.query<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.tenant_id=$1 AND a.id=$2${suffix}`, [tenantId, id])).rows[0] ?? null;
}

/** The binding an approved row authorizes: its decider runs exactly the stored action (A-6). */
export function approvedBinding(row: ApprovalRow): ActionBinding | null {
  if (row.status !== "approved" || row.decided_by === null) return null;
  return {
    tenantId: row.tenant_id,
    actorId: row.decided_by,
    actionType: row.action_type,
    target: { tenantId: row.tenant_id, type: row.target_type, id: row.target_id },
    payload: row.payload,
    approvalReference: { tenantId: row.tenant_id, id: row.id },
  };
}

/**
 * A-7 resolveApproval for a stored approval: under a shared row lock, the binding when the
 * approval is approved and unexpired. Its actor is the decider, so the dispatcher's binding
 * comparison refuses anyone else (BindingMismatch), as it refuses another target or payload.
 */
export async function resolveStoredApproval(
  tx: Transaction,
  tenantId: string,
  approvalId: string,
  now: Date,
): Promise<ActionBinding> {
  const row = await loadApproval(tx, tenantId, approvalId, "share");
  if (!row) throw new TenantDenied();
  const current = standing(row, now);
  if (current === "expired") throw new Conflict("The approval has expired", { reason: "approval_expired" });
  const binding = approvedBinding(row);
  if (current !== "approved" || !binding) throw new Conflict("The approval is not approved", { reason: "approval_not_approved" });
  return binding;
}

/** A-10: what a delivery re-checks before it sends. Direct approvals have no record. */
export type ApprovalCheck =
  | { readonly kind: "stored"; readonly standing: ApprovalStanding; readonly approval: ApprovalRecord; readonly binding: ActionBinding | null }
  | { readonly kind: "direct" };

export async function checkApproval(tx: Transaction, tenantId: string, approvalId: string, now: Date): Promise<ApprovalCheck> {
  const row = await loadApproval(tx, tenantId, approvalId);
  if (!row) return { kind: "direct" };
  const current = standing(row, now);
  return { kind: "stored", standing: current, approval: approvalRecord(row, now), binding: current === "approved" ? approvedBinding(row) : null };
}

/** A-10 from an action row (outbox.action_id); null when the tenant has no such action. */
export async function approvalForAction(tx: Transaction, tenantId: string, actionId: string, now: Date): Promise<ApprovalCheck | null> {
  const action = (await tx.query<{ approval_id: string | null }>(
    "SELECT approval_reference->>'id' AS approval_id FROM actions WHERE tenant_id=$1 AND id=$2", [tenantId, actionId],
  )).rows[0];
  if (!action) return null;
  if (action.approval_id === null) return { kind: "direct" };
  return checkApproval(tx, tenantId, action.approval_id, now);
}

/** A-11: newest first. `requestedBy` limits the list to one requester's approvals. */
export async function listApprovals(
  tx: Transaction,
  tenantId: string,
  query: ListApprovalsQuery,
  now: Date,
  requestedBy: string | null,
): Promise<ApprovalPage> {
  const cursor = decodeCursor("approvals.recent", query);
  const position = cursor
    ? `AND (a.requested_at < ${microsToTimestamp("$6")} OR (a.requested_at = ${microsToTimestamp("$6")} AND a.id > $7::uuid))`
    : "";
  const rows = (await tx.query<ApprovalRow & { sort_value: string }>(
    `${APPROVAL_SELECT.replace("x.id AS executed_action_id", `x.id AS executed_action_id, ${timestampToMicros("a.requested_at")} AS sort_value`)}
      WHERE a.tenant_id=$1 AND ($2::text IS NULL OR a.status=$2) AND ($3::uuid IS NULL OR a.requested_by=$3) ${position}
      ORDER BY a.requested_at DESC, a.id LIMIT $4 OFFSET $5`,
    [tenantId, query.status ?? null, requestedBy, query.limit + 1, query.offset, ...(cursor ?? [])],
  )).rows;
  return page(rows.map((row) => approvalRecord(row, now)), query,
    (index) => encodeCursor("approvals.recent", [rows[index]!.sort_value, rows[index]!.id]));
}
