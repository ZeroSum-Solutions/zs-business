// Message template rows and reads (agents.md G-19, approvals.md A-15). Original code. Runs as
// the runtime role inside ScopedDatabase.tenant; RLS limits rows to the tenant.
import { createHash } from "node:crypto";
import {
  Conflict,
  TEMPLATE_PURPOSES,
  TEMPLATE_REVISIONS_SHOWN,
  TEMPLATE_STANDING_GRANT_ACTION,
  TEMPLATE_VARIABLES,
  type DeliveryChannel,
  type DeliveryPurpose,
  type TemplateRevision,
  type TemplateState,
  type TemplatedKind,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { loadApproval, standing } from "../approvals/records.js";
import { derivedId } from "../edge/ids.js";

export { renderedContent, sendDigest } from "./render.js";

/** One template per kind and tenant, so its ID derives from them. */
export const templateIdFor = (tenantId: string, kind: TemplatedKind) => derivedId(tenantId, kind, "message-template");

export interface DigestInput {
  readonly kind: TemplatedKind;
  readonly channel: DeliveryChannel;
  readonly purpose: DeliveryPurpose;
  readonly subject: string | null;
  readonly body: string;
  readonly variables: readonly string[];
  readonly timingHours: number;
}
/** A-15: SHA-256 over kind, channel, purpose, subject, body, variable names and timing. */
export function templateDigest(input: DigestInput): string {
  const canonical = JSON.stringify(["zs-template-v1", input.kind, input.channel, input.purpose, input.subject, input.body,
    [...input.variables].sort(), input.timingHours]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RevisionRow {
  id: string;
  template_id: string;
  revision: number;
  channel: DeliveryChannel;
  purpose: DeliveryPurpose;
  subject: string | null;
  body: string;
  variables: string[];
  timing_hours: number;
  content_digest: string;
  standing_approval_id: string | null;
  created_by: string;
  created_at: Date;
}
export const REVISION_COLUMNS = `r.id, r.template_id, r.revision, r.channel, r.purpose, r.subject, r.body, r.variables, r.timing_hours,
  r.content_digest, r.standing_approval_id, r.created_by, r.created_at`;

export interface TemplateRow {
  id: string;
  agent_kind: TemplatedKind;
  current_revision: number;
}

export async function loadTemplate(
  tx: Transaction, tenantId: string, kind: TemplatedKind, lock?: "update" | "share",
): Promise<TemplateRow | null> {
  const suffix = lock ? ` FOR ${lock === "update" ? "UPDATE" : "SHARE"}` : "";
  return (await tx.query<TemplateRow>(
    `SELECT id, agent_kind, current_revision FROM message_templates WHERE tenant_id=$1 AND agent_kind=$2${suffix}`, [tenantId, kind],
  )).rows[0] ?? null;
}

export async function loadRevision(tx: Transaction, tenantId: string, id: string, lock?: "share" | "update"): Promise<RevisionRow | null> {
  const suffix = lock ? ` FOR ${lock === "update" ? "UPDATE" : "SHARE"}` : "";
  return (await tx.query<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM message_template_revisions r WHERE r.tenant_id=$1 AND r.id=$2${suffix}`,
    [tenantId, id],
  )).rows[0] ?? null;
}

interface StateRow extends RevisionRow {
  approval_status: "pending" | "approved" | "rejected" | "revoked" | null;
  approval_expires_at: Date | null;
  sends: number;
  pending_approval_id: string | null;
}

/** G-19, A-11: the template with its newest revisions, each with its standing approval and the sends it covered. */
export async function loadTemplateState(tx: Transaction, tenantId: string, kind: TemplatedKind, now: Date): Promise<TemplateState> {
  const template = await loadTemplate(tx, tenantId, kind);
  const base = {
    agentKind: kind, templateId: templateIdFor(tenantId, kind), purpose: TEMPLATE_PURPOSES[kind],
    variables: [...TEMPLATE_VARIABLES[kind]],
  };
  if (!template) return { ...base, currentRevision: 0, revisions: [] };
  const rows = (await tx.query<StateRow>(
    `SELECT ${REVISION_COLUMNS}, a.status AS approval_status, a.expires_at AS approval_expires_at,
            (SELECT count(*)::int FROM agent_decisions d
              WHERE d.tenant_id = r.tenant_id AND d.approval_id = r.standing_approval_id AND d.outcome = 'queued') AS sends,
            (SELECT p.id FROM approvals p
              WHERE p.tenant_id = r.tenant_id AND p.action_type = $4 AND p.target_type = 'message_template_revision'
                AND p.target_id = r.id AND p.status = 'pending' AND p.expires_at > $5
              ORDER BY p.requested_at DESC, p.id LIMIT 1) AS pending_approval_id
       FROM message_template_revisions r
       LEFT JOIN approvals a ON a.tenant_id = r.tenant_id AND a.id = r.standing_approval_id
      WHERE r.tenant_id=$1 AND r.template_id=$2
      ORDER BY r.revision DESC LIMIT $3`,
    [tenantId, template.id, TEMPLATE_REVISIONS_SHOWN, TEMPLATE_STANDING_GRANT_ACTION, now],
  )).rows;
  return {
    ...base,
    currentRevision: template.current_revision,
    revisions: rows.map((row): TemplateRevision => {
      const current = row.revision === template.current_revision;
      const stands = row.standing_approval_id && row.approval_status && row.approval_expires_at
        ? { approvalId: row.standing_approval_id,
            standing: standing({ status: row.approval_status, expires_at: row.approval_expires_at }, now),
            expiresAt: row.approval_expires_at.toISOString(), sends: row.sends }
        : null;
      return {
        id: row.id, revision: row.revision, channel: row.channel, purpose: row.purpose, subject: row.subject, body: row.body,
        variables: row.variables, timingHours: row.timing_hours, contentDigest: row.content_digest,
        createdBy: row.created_by, createdAt: row.created_at.toISOString(), current, standing: stands,
        pendingApprovalId: row.pending_approval_id, approved: current && stands?.standing === "approved",
      };
    }),
  };
}

/** The current revision of a kind's template, or null. No lock: for planning a run. */
export async function currentRevision(tx: Transaction, tenantId: string, kind: TemplatedKind): Promise<RevisionRow | null> {
  return (await tx.query<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM message_templates t
       JOIN message_template_revisions r ON r.tenant_id = t.tenant_id AND r.template_id = t.id AND r.revision = t.current_revision
      WHERE t.tenant_id=$1 AND t.agent_kind=$2`, [tenantId, kind],
  )).rows[0] ?? null;
}

interface GrantPayload { templateId?: unknown; revision?: unknown; contentDigest?: unknown }

/**
 * Plan-time read (no lock): the approval ID a send from this revision could use, or null. The queue
 * action checks the same things again under its locks (`requireStandingApproval`).
 */
export async function usableStandingApproval(
  tx: Transaction, tenantId: string, revision: RevisionRow, now: Date,
): Promise<string | null> {
  if (!revision.standing_approval_id) return null;
  const approval = await loadApproval(tx, tenantId, revision.standing_approval_id);
  const grant = (approval?.payload ?? {}) as GrantPayload;
  if (!approval || standing(approval, now) !== "approved" || grant.contentDigest !== revision.content_digest) return null;
  return approval.id;
}

/**
 * A-15: lock the rows a send depends on FOR SHARE, in the order approval, template, revision (the
 * order the grant and a new revision use), and refuse with `Conflict` `template_not_approved`
 * unless the approval is `approved` and unexpired, names this revision and its digest, and the
 * revision is the template's current one and records this approval.
 */
export async function requireStandingApproval(
  tx: Transaction, tenantId: string, kind: TemplatedKind, input: { approvalId: string; revisionId: string }, now: () => Date,
): Promise<RevisionRow> {
  const notApproved = () => new Conflict("The template is not approved for sending", { reason: "template_not_approved" });
  const approval = await loadApproval(tx, tenantId, input.approvalId, "share");
  const template = await loadTemplate(tx, tenantId, kind, "share");
  const revision = await loadRevision(tx, tenantId, input.revisionId, "share");
  if (!approval || !template || !revision) throw notApproved();
  const grant = (approval.payload ?? {}) as GrantPayload;
  // The clock is read after the locks, so a wait on a revoke or a new revision counts toward expiry.
  if (standing(approval, now()) !== "approved" || approval.action_type !== TEMPLATE_STANDING_GRANT_ACTION ||
      approval.target_type !== "message_template_revision" || approval.target_id !== revision.id ||
      grant.contentDigest !== revision.content_digest || grant.templateId !== template.id || grant.revision !== revision.revision ||
      revision.template_id !== template.id || revision.revision !== template.current_revision ||
      revision.standing_approval_id !== approval.id)
    throw notApproved();
  return revision;
}
