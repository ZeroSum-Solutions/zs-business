// Inbox replies (inbox-home.md I-4..I-7). Original code. Every step runs inside the shared
// dispatcher transaction, so the reply row, the action row and its outbox event commit
// together or not at all. Nothing here sends: an approved send hands the reply to the outbox.
import {
  Conflict,
  discardReplyCommandSchema,
  draftReplyCommandSchema,
  MAX_SUBJECT_LENGTH,
  MESSAGE_SEND_REQUESTED,
  resumeReplyCommandSchema,
  sendReplyCommandSchema,
  uuidSchema,
  TenantDenied,
  ValidationFailed,
  type ReplySendRequested,
  type ReplyRecord,
  type ReplyStatus,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { idInUse, parseOrFail, pgCode } from "../crm/rows.js";
import { loadReply } from "../reads/inbox.js";

export const DRAFT_REPLY_ACTION = "inbox.reply.draft";
/** I-6: required by APPROVAL_POLICIES, so it runs only under an owner's stored approval. */
export const SEND_REPLY_ACTION = "inbox.reply.send";
export const DISCARD_REPLY_ACTION = "inbox.reply.discard";
export const RESUME_REPLY_ACTION = "inbox.reply.resume";

/** A placeholder address (crm_contacts' column default) is no address to reply to. */
const PLACEHOLDER_EMAIL = /@placeholder\.invalid$/;

/** I-6: email is the only reply channel in v1, so the customer needs a real address. */
export async function requireEmail(tx: Transaction, tenantId: string, contactId: string): Promise<void> {
  const email = (await tx.query<{ normalized_email: string | null }>(
    "SELECT normalized_email FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId],
  )).rows[0]?.normalized_email ?? null;
  if (email === null || PLACEHOLDER_EMAIL.test(email))
    throw new Conflict("The customer has no email address to reply to", { reason: "no_email" });
}

async function resolveReply(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "inbox_reply") throw new ValidationFailed("Inbox reply actions require an inbox_reply target");
  const owned = await tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
  return owned.rowCount === 1 ? { tenantId: target.tenantId, type: "inbox_reply", id: target.id } : null;
}

/** Lock the reply and require that it is still a draft (I-6, I-7). */
async function lockDraft(tx: Transaction, tenantId: string, replyId: string) {
  const row = (await tx.query<{ status: ReplyStatus; contact_id: string; subject: string; body: string }>(
    "SELECT status, contact_id, subject, body FROM inbox_replies WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, replyId],
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
    const subject = payload.subject ?? `Message from ${(await tx.query<{ name: string }>(
      "SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]!.name}`.slice(0, MAX_SUBJECT_LENGTH);
    try {
      await tx.query(
        `INSERT INTO inbox_replies (tenant_id,id,contact_id,channel,subject,body,drafted_by,created_at)
         VALUES ($1,$2,$3,'email',$4,$5,$6,$7)`,
        [tenantId, payload.replyId, payload.contactId, subject, payload.body, binding.actorId, now],
      );
    } catch (error) {
      if (pgCode(error) === "23505") throw idInUse("reply");
      throw error;
    }
    return replyResult(tx, tenantId, payload.replyId);
  },
};

/** I-6: the approved send. Its actor is the owner who decided the approval (approvals.md A-6). */
export const sendReplyHandler: ActionHandler = {
  resolveTarget: resolveReply,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(sendReplyCommandSchema, command);
    const tenantId = binding.tenantId;
    const draft = await lockDraft(tx, tenantId, payload.replyId);
    await requireEmail(tx, tenantId, draft.contact_id);
    await tx.query(
      "UPDATE inbox_replies SET status='approved', approved_by=$3, approved_at=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, payload.replyId, binding.actorId, now],
    );
    const event: ReplySendRequested = {
      messageId: payload.replyId, contactId: draft.contact_id, channel: "email", purpose: "transactional",
      subject: draft.subject, body: draft.body,
    };
    return { ...(await replyResult(tx, tenantId, payload.replyId)), event: { type: MESSAGE_SEND_REQUESTED, payload: { ...event } } };
  },
};

/**
 * I-6: records an owner's new call to finish a send they already approved (its earlier run
 * failed), so this call's key is bound to that approval. The send itself runs after, under the
 * approval's own key. Requires the reply to be a draft and the approval to be this owner's,
 * approved and not yet run.
 */
export const resumeReplyHandler: ActionHandler = {
  resolveTarget: resolveReply,
  async handle({ tx, command, binding }) {
    const { payload } = parseOrFail(resumeReplyCommandSchema, command);
    const tenantId = binding.tenantId;
    await lockDraft(tx, tenantId, payload.replyId);
    const approval = (await tx.query<{ status: string; decided_by: string | null; executed: boolean }>(
      `SELECT a.status, a.decided_by, EXISTS (
          SELECT 1 FROM actions x WHERE x.tenant_id = a.tenant_id AND (x.approval_reference->>'id')::uuid = a.id) AS executed
         FROM approvals a
        WHERE a.tenant_id=$1 AND a.id=$2 AND a.action_type=$3 AND a.target_type='inbox_reply' AND a.target_id=$4`,
      [tenantId, payload.approvalId, SEND_REPLY_ACTION, payload.replyId],
    )).rows[0];
    if (!approval || approval.status !== "approved" || approval.decided_by !== binding.actorId || approval.executed)
      throw new Conflict("The approval is not approved", { reason: "approval_not_approved" });
    return replyResult(tx, tenantId, payload.replyId);
  },
};

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

/** A proposal to send one reply that can still be decided or run (approvals.md A-3). */
export interface SendApproval {
  readonly id: string;
  readonly status: "pending" | "approved";
  readonly requestedBy: string;
  readonly decidedBy: string | null;
}

/** I-6: the newest unexpired pending or approved proposal to send this reply, if any. */
export async function openSendApproval(tx: Transaction, tenantId: string, replyId: string, now: Date): Promise<SendApproval | null> {
  const row = (await tx.query<{ id: string; status: "pending" | "approved"; requested_by: string; decided_by: string | null }>(
    `SELECT id, status, requested_by, decided_by FROM approvals
      WHERE tenant_id=$1 AND action_type=$2 AND target_type='inbox_reply' AND target_id=$3
        AND status IN ('pending','approved') AND expires_at > $4
      ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [tenantId, SEND_REPLY_ACTION, replyId, now],
  )).rows[0];
  return row ? { id: row.id, status: row.status, requestedBy: row.requested_by, decidedBy: row.decided_by } : null;
}

/**
 * I-6: the delivery worker's (M3d) settle hook. It runs inside the worker's settling transaction
 * with the service role (runtime holds no grant on settled_at), so it filters by tenant itself.
 * Returns false, changing nothing, for a message that is not an approved inbox reply: one already
 * settled, never approved, or another sender's message sharing the worker.
 */
export async function settleReplyDelivery(
  tx: Transaction, tenantId: string, replyId: string, outcome: "sent" | "failed", at: Date,
): Promise<boolean> {
  if (!Number.isFinite(at.getTime())) throw new ValidationFailed("Invalid settle time");
  // Another sender's message ID need not be a UUID; casting it would abort the worker's transaction.
  if (!uuidSchema.safeParse(replyId).success || !uuidSchema.safeParse(tenantId).success) return false;
  const updated = await tx.query(
    "UPDATE inbox_replies SET status=$3, settled_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='approved'",
    [tenantId, replyId, outcome, at],
  );
  return updated.rowCount === 1;
}
