// Approval actions (approvals.md A-5, A-6, A-8). Each runs through the shared dispatcher with
// a direct approval, like every member write; the edge checks the request permission first.
import {
  Conflict,
  TenantDenied,
  ValidationFailed,
  approveApprovalCommandSchema,
  rejectApprovalCommandSchema,
  requestApprovalCommandSchema,
  revokeApprovalCommandSchema,
  roleCan,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { idInUse, parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { PUBLIC_REQUEST_ACTION } from "../intake/public-request.js";
import { requireMember } from "../members/access.js";
import { cannotBeApproved } from "./policy.js";
import { approvalRecord, loadApproval, standing, type ApprovalRow } from "./records.js";

const notPending = () => new Conflict("The approval was already decided", { reason: "approval_not_pending" });
const expired = () => new Conflict("The approval has expired", { reason: "approval_expired" });

async function resolveExisting(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "approval") throw new ValidationFailed("Approval actions require an approval target");
  return (await loadApproval(tx, target.tenantId, target.id)) ? { tenantId: target.tenantId, type: "approval", id: target.id } : null;
}

/** The locked row after an update, with its executed action. */
async function reload(tx: Transaction, tenantId: string, id: string): Promise<ApprovalRow> {
  const row = await loadApproval(tx, tenantId, id);
  if (!row) throw new TenantDenied();
  return row;
}

export const requestApprovalHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "approval") throw new ValidationFailed("Approval actions require an approval target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadApproval(tx, target.tenantId, target.id)) throw idInUse("approval");
    return { tenantId: target.tenantId, type: "approval", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    // The edge checks the request permission (A-9); a dispatcher without it still needs a member.
    await requireMember(tx, binding.tenantId, binding.actorId, null);
    const { payload } = parseOrFail(requestApprovalCommandSchema, command);
    const { action } = payload;
    if (cannotBeApproved(action.actionType) || action.actionType === PUBLIC_REQUEST_ACTION)
      throw new ValidationFailed("That action cannot be approved");
    const expiresAt = new Date(now.getTime() + payload.expiresInMinutes * 60_000);
    await tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [binding.tenantId, payload.approvalId, action.actionType, action.target.type, action.target.id,
        JSON.stringify(action.payload), payload.summary, binding.actorId, now, expiresAt],
    );
    const record = approvalRecord(await reload(tx, binding.tenantId, payload.approvalId), now);
    return {
      result: record,
      event: { type: "approval.requested", payload: { approvalId: record.id, actionType: record.actionType, requestedBy: record.requestedBy } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "approvals_pkey")
      return new Conflict("The approval ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

function decide(decision: "approved" | "rejected"): ActionHandler {
  return {
    resolveTarget: resolveExisting,
    async handle({ tx, command, binding, clock }) {
      // A-6: owners decide, checked here too so a dispatcher without the edge hook cannot.
      await requireMember(tx, binding.tenantId, binding.actorId, "approve");
      const { payload } = decision === "approved"
        ? parseOrFail(approveApprovalCommandSchema, command)
        : parseOrFail(rejectApprovalCommandSchema, command);
      const row = (await loadApproval(tx, binding.tenantId, payload.approvalId, "update"))!;
      // A-3: read the clock once the lock is held, so a wait on the row counts toward expiry.
      const now = clock();
      if (row.status !== "pending") throw notPending();
      if (standing(row, now) === "expired") throw expired();
      await tx.query(
        "UPDATE approvals SET status=$3, decided_by=$4, decided_at=$5, decision_note=$6 WHERE tenant_id=$1 AND id=$2",
        [binding.tenantId, payload.approvalId, decision, binding.actorId, now, payload.note ?? null],
      );
      const record = approvalRecord(await reload(tx, binding.tenantId, payload.approvalId), now);
      return {
        result: record,
        event: { type: `approval.${decision}`, payload: { approvalId: record.id, actionType: record.actionType, decidedBy: binding.actorId } },
      };
    },
  };
}

export const approveApprovalHandler = decide("approved");
export const rejectApprovalHandler = decide("rejected");

export const revokeApprovalHandler: ActionHandler = {
  resolveTarget: resolveExisting,
  async handle({ tx, command, binding, now }) {
    const access = await requireMember(tx, binding.tenantId, binding.actorId, null);
    const { payload } = parseOrFail(revokeApprovalCommandSchema, command);
    const row = (await loadApproval(tx, binding.tenantId, payload.approvalId, "update"))!;
    // A-8: owners revoke pending or approved; a requester may withdraw their own pending request.
    const approver = roleCan(access.role, "approve");
    const allowed = row.status === "approved" ? approver
      : row.status === "pending" ? approver || row.requested_by === binding.actorId
      : null;
    if (allowed === null) throw new Conflict("The approval cannot be revoked", { reason: "approval_not_revocable" });
    if (!allowed) throw new TenantDenied();
    await tx.query(
      "UPDATE approvals SET status='revoked', revoked_by=$3, revoked_at=$4, revoke_note=$5 WHERE tenant_id=$1 AND id=$2",
      [binding.tenantId, payload.approvalId, binding.actorId, now, payload.note ?? null],
    );
    const record = approvalRecord(await reload(tx, binding.tenantId, payload.approvalId), now);
    return {
      result: record,
      event: { type: "approval.revoked", payload: { approvalId: record.id, actionType: record.actionType, revokedBy: binding.actorId } },
    };
  },
};

export const approvalHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  "approval.request": requestApprovalHandler,
  "approval.approve": approveApprovalHandler,
  "approval.reject": rejectApprovalHandler,
  "approval.revoke": revokeApprovalHandler,
});
