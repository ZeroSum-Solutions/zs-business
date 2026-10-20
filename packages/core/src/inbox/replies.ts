// Inbox replies (inbox-home.md I-4..I-7). Original code. Every step runs inside the shared
// dispatcher transaction, so the reply row, the action row and its outbox event commit
// together or not at all. Nothing here sends: an approval hands the reply to the outbox.
import {
  approveReplyCommandSchema,
  Conflict,
  discardReplyCommandSchema,
  draftReplyCommandSchema,
  REPLY_APPROVED_EVENT,
  TenantDenied,
  ValidationFailed,
  type ActionBinding,
  type ReplyApprovedEvent,
  type ReplyRecord,
  type ReplyStatus,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { idInUse, parseOrFail, pgCode } from "../crm/rows.js";
import { loadReply } from "../reads/inbox.js";

export const DRAFT_REPLY_ACTION = "inbox.reply.draft";
export const APPROVE_REPLY_ACTION = "inbox.reply.approve";
export const DISCARD_REPLY_ACTION = "inbox.reply.discard";

/**
 * Where an approval of a reply is recorded, inside the approving transaction after the reply
 * row is locked. The approval-record interface (M3b) plugs in here; `directReplyApprovals`
 * records nothing beyond the action row, which already holds the approver, the time and the
 * approved binding (the same direct approval every owner write uses).
 */
export interface ReplyApprovals {
  record(tx: Transaction, input: {
    readonly binding: ActionBinding;
    readonly approverId: string;
    readonly decidedAt: Date;
    readonly subject: { readonly type: "inbox_reply"; readonly id: string };
  }): Promise<void>;
}
export const directReplyApprovals: ReplyApprovals = Object.freeze({ record: async () => {} });

/** A placeholder address (crm_contacts' column default) is no address to reply to. */
const PLACEHOLDER_EMAIL = /@placeholder\.invalid$/;

async function resolveReply(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "inbox_reply") throw new ValidationFailed("Inbox reply actions require an inbox_reply target");
  const owned = await tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
  return owned.rowCount === 1 ? { tenantId: target.tenantId, type: "inbox_reply", id: target.id } : null;
}

/** Lock the reply and require that it is still a draft (I-6, I-7). */
async function lockDraft(tx: Transaction, tenantId: string, replyId: string): Promise<{ contact_id: string }> {
  const row = (await tx.query<{ status: ReplyStatus; contact_id: string }>(
    "SELECT status, contact_id FROM inbox_replies WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, replyId],
  )).rows[0];
  if (!row) throw new TenantDenied();
  if (row.status !== "draft") throw new Conflict("The reply is no longer a draft", { reason: "not_draft", status: row.status });
  return row;
}

async function replyResult(tx: Transaction, tenantId: string, replyId: string): Promise<{ result: ReplyRecord }> {
  const reply = await loadReply(tx, tenantId, replyId);
  if (!reply) throw new TenantDenied();
  return { result: reply };
}

export const draftReplyHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "inbox_reply") throw new ValidationFailed("Inbox reply actions require an inbox_reply target");
    const tenant = await tx.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [target.tenantId]);
    if (tenant.rowCount !== 1) return null;
    // A new reply's ID derives from the idempotency key; an existing one under another key is a conflict.
    if ((await tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id])).rowCount)
      throw idInUse("reply");
    return { tenantId: target.tenantId, type: "inbox_reply", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(draftReplyCommandSchema, command);
    const tenantId = binding.tenantId;
    // I-5: the customer must be this tenant's (the insert's FK then holds the contact row).
    const contact = await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, payload.contactId]);
    if (contact.rowCount !== 1) throw new TenantDenied("Contact is not owned by this tenant");
    try {
      await tx.query(
        `INSERT INTO inbox_replies (tenant_id,id,contact_id,channel,body,status,drafted_by,created_at)
         VALUES ($1,$2,$3,'email',$4,'draft',$5,$6)`,
        [tenantId, payload.replyId, payload.contactId, payload.body, binding.actorId, now],
      );
    } catch (error) {
      if (pgCode(error) === "23505") throw idInUse("reply");
      throw error;
    }
    return replyResult(tx, tenantId, payload.replyId);
  },
};

export function createApproveReplyHandler(approvals: ReplyApprovals): ActionHandler {
  return {
    resolveTarget: resolveReply,
    async handle({ tx, command, binding, now }) {
      const { payload } = parseOrFail(approveReplyCommandSchema, command);
      const tenantId = binding.tenantId;
      const draft = await lockDraft(tx, tenantId, payload.replyId);
      // I-6: email is the only reply channel in v1, so the customer needs a real address.
      const email = (await tx.query<{ normalized_email: string | null }>(
        "SELECT normalized_email FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, draft.contact_id],
      )).rows[0]?.normalized_email ?? null;
      if (email === null || PLACEHOLDER_EMAIL.test(email))
        throw new Conflict("The customer has no email address to reply to", { reason: "no_email" });
      await approvals.record(tx, {
        binding, approverId: binding.actorId, decidedAt: now, subject: { type: "inbox_reply", id: payload.replyId },
      });
      await tx.query(
        "UPDATE inbox_replies SET status='approved', approved_by=$3, approved_at=$4 WHERE tenant_id=$1 AND id=$2",
        [tenantId, payload.replyId, binding.actorId, now],
      );
      const event: ReplyApprovedEvent = { replyId: payload.replyId, contactId: draft.contact_id, channel: "email" };
      return { ...(await replyResult(tx, tenantId, payload.replyId)), event: { type: REPLY_APPROVED_EVENT, payload: { ...event } } };
    },
  };
}

export const discardReplyHandler: ActionHandler = {
  resolveTarget: resolveReply,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(discardReplyCommandSchema, command);
    const tenantId = binding.tenantId;
    await lockDraft(tx, tenantId, payload.replyId);
    await tx.query(
      "UPDATE inbox_replies SET status='discarded', discarded_by=$3, discarded_at=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, payload.replyId, binding.actorId, now],
    );
    return replyResult(tx, tenantId, payload.replyId);
  },
};

/**
 * I-6: the delivery worker (M3d) settles an approved reply once, in its own transaction, with
 * the service role (runtime holds no grant on settled_at). Returns false when the reply was not
 * waiting (already settled, or never approved), so a retried settle changes nothing.
 */
export async function settleReplyDelivery(
  tx: Transaction, tenantId: string, replyId: string, outcome: "sent" | "failed", at: Date,
): Promise<boolean> {
  if (!Number.isFinite(at.getTime())) throw new ValidationFailed("Invalid settle time");
  const updated = await tx.query(
    "UPDATE inbox_replies SET status=$3, settled_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='approved'",
    [tenantId, replyId, outcome, at],
  );
  return updated.rowCount === 1;
}
