// Template actions (agents.md G-19, approvals.md A-15). Original code. A member with `agents`
// writes a revision; an owner's approval runs the grant. Nothing edits a revision: the runtime
// role may only insert one and set its `standing_approval_id`.
//
// Lock order everywhere: approvals, then the template row, then the revision row. A new
// revision locks the old revision's grants first, so a send holding a grant FOR SHARE finishes
// before the grant is revoked, and every send after the commit finds the revision superseded.
import {
  Conflict,
  TEMPLATE_REVISION_CREATE_ACTION,
  TEMPLATE_STANDING_GRANT_ACTION,
  TenantDenied,
  ValidationFailed,
  parseTemplateDraft,
  templateRevisionCreateCommandSchema,
  templateStandingGrantCommandSchema,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { standing } from "../approvals/records.js";
import { requireMember } from "../members/access.js";
import { loadRevision, loadTemplate, loadTemplateState, templateDigest, templateIdFor } from "./store.js";

const staleRevision = (currentRevision: number) =>
  new Conflict("The template changed", { reason: "stale_revision", currentRevision });

/**
 * A-15, A-8: write the next revision of a kind's template and make it current. In the same
 * transaction every `pending` or `approved` grant of the previous revision is revoked with the
 * note `superseded`. A first revision creates the template (`expectedRevision` 0).
 */
export const templateRevisionCreateHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "message_template") throw new ValidationFailed("Template revision actions require a message_template target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    return { tenantId: target.tenantId, type: "message_template", id: target.id };
  },
  async handle({ tx, command, binding, clock }) {
    const tenantId = binding.tenantId;
    await requireMember(tx, tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(templateRevisionCreateCommandSchema, command);
    const kind = payload.agentKind;
    if (payload.templateId !== templateIdFor(tenantId, kind))
      throw new ValidationFailed("The template ID does not belong to this kind");
    const draft = parseTemplateDraft(kind, {
      channel: payload.channel, subject: payload.subject, body: payload.body, timingHours: payload.timingHours,
    });
    const digest = templateDigest({
      kind, channel: draft.channel, purpose: draft.purpose, subject: draft.subject, body: draft.body,
      variables: draft.variables, timingHours: draft.timingHours,
    });

    // The previous revision, read before any lock, names the grants to lock first (approvals, then template).
    const seen = await loadTemplate(tx, tenantId, kind);
    const previous = seen
      ? (await tx.query<{ id: string }>(
          "SELECT id FROM message_template_revisions WHERE tenant_id=$1 AND template_id=$2 AND revision=$3",
          [tenantId, seen.id, seen.current_revision])).rows[0]?.id ?? null
      : null;
    const grants = previous
      ? (await tx.query<{ id: string }>(
          `SELECT id FROM approvals
            WHERE tenant_id=$1 AND action_type=$2 AND target_type='message_template_revision' AND target_id=$3
              AND status IN ('pending','approved')
            ORDER BY id FOR UPDATE`,
          [tenantId, TEMPLATE_STANDING_GRANT_ACTION, previous])).rows.map((row) => row.id)
      : [];
    const template = await loadTemplate(tx, tenantId, kind, "update");
    const current = template?.current_revision ?? 0;
    // A first save that raced another leaves no row to lock above; the insert below catches that.
    if (current !== payload.expectedRevision || current !== (seen?.current_revision ?? 0)) throw staleRevision(current);
    // The clock is read after the locks, so a wait on them counts toward the revocation time.
    const now = clock();
    if (grants.length)
      await tx.query(
        `UPDATE approvals SET status='revoked', revoked_by=$3, revoked_at=$4, revoke_note='superseded'
          WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
        [tenantId, grants, binding.actorId, now],
      );
    const revision = current + 1;
    if (!template) {
      const inserted = await tx.query(
        `INSERT INTO message_templates (tenant_id, id, agent_kind, current_revision, created_at)
         VALUES ($1,$2,$3,1,$4) ON CONFLICT DO NOTHING`,
        [tenantId, payload.templateId, kind, now],
      );
      if (inserted.rowCount === 0) throw staleRevision((await loadTemplate(tx, tenantId, kind))?.current_revision ?? 0);
    }
    await tx.query(
      `INSERT INTO message_template_revisions
         (tenant_id, id, template_id, revision, channel, purpose, subject, body, variables, timing_hours, content_digest,
          created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, payload.revisionId, payload.templateId, revision, draft.channel, draft.purpose, draft.subject, draft.body,
        draft.variables, draft.timingHours, digest, binding.actorId, now],
    );
    if (template)
      await tx.query("UPDATE message_templates SET current_revision=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, payload.templateId, revision]);
    return {
      result: await loadTemplateState(tx, tenantId, kind, now),
      event: {
        type: "template.revision.created",
        payload: { templateId: payload.templateId, revisionId: payload.revisionId, revision, agentKind: kind, contentDigest: digest },
      },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "message_template_revisions_pkey")
      return new Conflict("The revision ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

/**
 * A-15: runs only under an owner's stored approval. The payload's digest must equal the
 * revision's (`template_changed`) and the revision must be the template's current one
 * (`template_superseded`). The approval becomes the revision's `standing_approval_id`; another
 * approval already recorded there is replaced only once it has expired or been revoked.
 */
export const templateStandingGrantHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "message_template_revision") throw new ValidationFailed("Template grants require a message_template_revision target");
    return (await loadRevision(tx, target.tenantId, target.id))
      ? { tenantId: target.tenantId, type: "message_template_revision", id: target.id }
      : null;
  },
  async handle({ tx, command, binding, clock }) {
    const tenantId = binding.tenantId;
    await requireMember(tx, tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(templateStandingGrantCommandSchema, command);
    const approvalId = command.approvalReference.id;
    // The dispatcher holds the approval FOR SHARE already; then the template, then the revision.
    const template = (await tx.query<{ id: string; agent_kind: string; current_revision: number }>(
      "SELECT id, agent_kind, current_revision FROM message_templates WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [tenantId, payload.templateId])).rows[0];
    const revision = await loadRevision(tx, tenantId, command.target.id, "update");
    if (!template || !revision || revision.template_id !== template.id) throw new TenantDenied();
    if (revision.revision !== payload.revision || revision.content_digest !== payload.contentDigest)
      throw new Conflict("The template changed since it was approved", { reason: "template_changed" });
    if (revision.revision !== template.current_revision)
      throw new Conflict("The revision is no longer the template's current one", { reason: "template_superseded" });
    if (revision.standing_approval_id && revision.standing_approval_id !== approvalId) {
      const recorded = (await tx.query<{ status: "pending" | "approved" | "rejected" | "revoked"; expires_at: Date }>(
        "SELECT status, expires_at FROM approvals WHERE tenant_id=$1 AND id=$2", [tenantId, revision.standing_approval_id])).rows[0];
      if (recorded && standing(recorded, clock()) === "approved")
        throw new Conflict("The revision already has a standing approval", { reason: "standing_approval_active" });
    }
    await tx.query("UPDATE message_template_revisions SET standing_approval_id=$3 WHERE tenant_id=$1 AND id=$2",
      [tenantId, revision.id, approvalId]);
    const result = {
      templateId: template.id, revisionId: revision.id, revision: revision.revision, contentDigest: revision.content_digest,
      standingApprovalId: approvalId,
    };
    return { result, event: { type: "template.standing.granted", payload: result } };
  },
};

export const templateHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [TEMPLATE_REVISION_CREATE_ACTION]: templateRevisionCreateHandler,
  [TEMPLATE_STANDING_GRANT_ACTION]: templateStandingGrantHandler,
});
