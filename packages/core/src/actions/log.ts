// The owner's action log (docs/direction.md rule 6, backlog B05). Reads committed actions under
// the runtime role and turns each into a redacted receipt: actor, type, target, approval, outcome
// and time. The payload and the result never leave this file. From the result only a status word on
// OUTCOMES, a notice code, and a committed contact's ID are read; nothing else can pass.
import {
  AGENT_KINDS,
  QUEUE_ACTIONS,
  actionLogEntrySchema,
  type ActionActor,
  type ActionLogEntry,
  type ActionLogPage,
  type ApprovalStatus,
  type ListActionsQuery,
  type MemberRole,
  type SystemActor,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { agentActorId } from "../agents/controls.js";
import { derivedId } from "../edge/ids.js";
import { outreachOperatorActorId } from "../edge/outreach-session.js";
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "../reads/cursor.js";
import { page } from "../reads/page.js";

/**
 * The derived actor IDs of the tenant's workers and webhooks, by the name each one passes to
 * derivedId (see the `*ActorId` helpers). Activepieces tokens derive one ID per token.
 */
const SYSTEM_ID_PARTS: ReadonlyArray<readonly [SystemActor, string]> = [
  ["public_intake", "public-intake"],
  ["unsubscribe", "public-unsubscribe"],
  ["inbound_sms", "inbound-sms"],
  ["sms_status", "sms-status"],
  ["email_feedback", "email-feedback"],
  ["voice", "twilio-voice"],
  ["enrichment", "enrichment"],
  ["outreach", "outreach"],
  ["transcription", "transcription-worker"],
  ["document_intake", "document-intake-worker"],
  ["images", "image-worker"],
];

type ServiceActor = Exclude<ActionActor, { kind: "person" }>;

async function serviceActors(tx: Transaction, tenantId: string): Promise<Map<string, ServiceActor>> {
  const actors = new Map<string, ServiceActor>();
  for (const agent of AGENT_KINDS) actors.set(agentActorId(tenantId, agent), { kind: "agent", agent });
  for (const [name, part] of SYSTEM_ID_PARTS) actors.set(derivedId(tenantId, part, "actor"), { kind: "system", name });
  actors.set(outreachOperatorActorId(tenantId), { kind: "system", name: "outreach" });
  const tokens = (await tx.query<{ id: string }>("SELECT id FROM automation_tokens WHERE tenant_id=$1", [tenantId])).rows;
  for (const token of tokens) actors.set(derivedId(tenantId, "activepieces", token.id, "actor"), { kind: "system", name: "automation" });
  return actors;
}

interface ActionLogRow {
  id: string;
  actor_id: string;
  action_type: string;
  target_type: string;
  target_id: string;
  approval_id: string | null;
  approval_status: ApprovalStatus | null;
  result_status: string | null;
  result_notice: string | null;
  member_id: string | null;
  member_role: MemberRole | null;
  created_at: Date;
  sort_value: string;
}

/**
 * The result words an owner may see as the outcome. A status is often a record's state; the list
 * keeps out anything a callback or provider could fill with free text.
 */
const OUTCOMES: ReadonlySet<string> = new Set([
  "queued", "sent", "delivered", "undelivered", "failed", "dead", "completed", "applied", "discarded",
  "confirmed", "cancelled", "approved", "rejected", "revoked", "expired", "published", "connected",
  "disconnected", "active", "invited", "granted", "denied", "skipped",
]);

const UUID_TEXT = "'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'";
const text = (path: string) => `CASE WHEN jsonb_typeof(${path}) = 'string' THEN left(${path} #>> '{}', 41) END`;

/**
 * Only these columns are read; `payload` and `result` are never selected whole.
 * - Approval: a row in `approvals`. Direct writes carry a derived approval_reference with no row, so
 *   the join leaves them null. A templated send (A-15) ran under the standing approval named in its
 *   payload; only that ID is read, to join on.
 * - Target: a contact create-or-find that matched an existing contact names it in the result; the
 *   requested ID was never written, so the receipt points to the matched one.
 * - Outcome: the result's top-level `status` and `notice` strings, cut to 41 characters.
 */
const SELECT = `
  SELECT x.id, x.actor_id, x.action_type, x.target->>'type' AS target_type,
         CASE WHEN x.target->>'type' = 'contact' AND jsonb_typeof(x.result) = 'object'
               AND jsonb_typeof(x.result->'contact') = 'object' AND (x.result->'contact'->>'id') ~ ${UUID_TEXT}
              THEN x.result->'contact'->>'id' ELSE x.target->>'id' END AS target_id,
         ap.id AS approval_id, ap.status AS approval_status,
         CASE WHEN jsonb_typeof(x.result) = 'object' THEN ${text("x.result->'status'")} END AS result_status,
         CASE WHEN jsonb_typeof(x.result) = 'object' THEN ${text("x.result->'notice'")} END AS result_notice,
         m.id AS member_id, m.role::text AS member_role, x.created_at, ${timestampToMicros("x.created_at")} AS sort_value
    FROM actions x
    LEFT JOIN approvals ap ON ap.tenant_id = x.tenant_id AND ap.id = (
      CASE WHEN x.action_type IN (${Object.values(QUEUE_ACTIONS).map((type) => `'${type}'`).join(", ")})
           THEN CASE WHEN (x.payload->>'standingApprovalId') ~ ${UUID_TEXT} THEN (x.payload->>'standingApprovalId')::uuid END
           WHEN (x.approval_reference->>'id') ~ ${UUID_TEXT} THEN (x.approval_reference->>'id')::uuid END)
    LEFT JOIN tenant_members m ON m.tenant_id = x.tenant_id AND m.user_id = x.actor_id`;

/**
 * How the action ended, in one allowlisted word. A notice other than "queued" means the action
 * committed but sent nothing (no customer, no email, already cancelled): "skipped".
 */
function outcomeOf(status: string | null, notice: string | null): string {
  if (status !== null && OUTCOMES.has(status)) return status;
  if (notice !== null) return notice === "queued" ? "queued" : "skipped";
  return "done";
}

/** Exported for the redaction tests: one row as the owner sees it. */
export function actionLogEntry(row: Omit<ActionLogRow, "sort_value">, services: ReadonlyMap<string, ServiceActor>): ActionLogEntry {
  const actor: ActionActor = services.get(row.actor_id) ??
    { kind: "person", memberId: row.member_id, role: row.member_role };
  const outcome = outcomeOf(row.result_status, row.result_notice);
  // Parse on the way out: a strict schema refuses any field this file did not mean to send.
  return actionLogEntrySchema.parse({
    id: row.id,
    actionType: row.action_type,
    actor,
    target: { type: row.target_type, id: row.target_id },
    approval: row.approval_id === null ? null : { id: row.approval_id, status: row.approval_status },
    outcome,
    createdAt: row.created_at.toISOString(),
  });
}

/** The tenant's actions, newest first, keyset paged on (created_at, id). */
export async function listActionLog(tx: Transaction, tenantId: string, query: ListActionsQuery): Promise<ActionLogPage> {
  const cursor = decodeCursor("actions.recent", query);
  const position = cursor
    ? `AND (x.created_at, x.id) < (${microsToTimestamp("$4")}, $5::uuid)`
    : "";
  const rows = (await tx.query<ActionLogRow>(
    `${SELECT} WHERE x.tenant_id=$1 ${position} ORDER BY x.created_at DESC, x.id DESC LIMIT $2 OFFSET $3`,
    [tenantId, query.limit + 1, query.offset, ...(cursor ?? [])],
  )).rows;
  const services = await serviceActors(tx, tenantId);
  return page(rows.map((row) => actionLogEntry(row, services)), query,
    (index) => encodeCursor("actions.recent", [rows[index]!.sort_value, rows[index]!.id]));
}

/** One receipt, or null when the tenant has no such action. */
export async function getActionReceipt(tx: Transaction, tenantId: string, actionId: string): Promise<ActionLogEntry | null> {
  const row = (await tx.query<ActionLogRow>(`${SELECT} WHERE x.tenant_id=$1 AND x.id=$2`, [tenantId, actionId])).rows[0];
  return row ? actionLogEntry(row, await serviceActors(tx, tenantId)) : null;
}
