// The owner's action log (docs/direction.md rule 6, backlog B05). Reads committed actions under
// the runtime role and turns each into a redacted receipt: actor, type, target, approval, outcome
// and time. The payload and the result never leave this file; only a short status word from the
// result does, and only when it matches ACTION_OUTCOME_PATTERN, so no text or address can pass.
import {
  ACTION_OUTCOME_PATTERN,
  AGENT_KINDS,
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
  member_id: string | null;
  member_role: MemberRole | null;
  created_at: Date;
  sort_value: string;
}

/**
 * Only these columns are read. `payload` and `result` are not selected; the result's top-level
 * `status`, when it is a string, is the one value taken from it.
 */
const SELECT = `
  SELECT x.id, x.actor_id, x.action_type, x.target->>'type' AS target_type, x.target->>'id' AS target_id,
         x.approval_reference->>'id' AS approval_id, ap.status AS approval_status,
         CASE WHEN jsonb_typeof(x.result) = 'object' AND jsonb_typeof(x.result->'status') = 'string'
              THEN left(x.result->>'status', 41) END AS result_status,
         m.id AS member_id, m.role::text AS member_role, x.created_at, ${timestampToMicros("x.created_at")} AS sort_value
    FROM actions x
    LEFT JOIN approvals ap ON ap.tenant_id = x.tenant_id AND x.approval_reference IS NOT NULL
     AND ap.id = (x.approval_reference->>'id')::uuid
    LEFT JOIN tenant_members m ON m.tenant_id = x.tenant_id AND m.user_id = x.actor_id`;

/** Exported for the redaction tests: one row as the owner sees it. */
export function actionLogEntry(row: Omit<ActionLogRow, "sort_value">, services: ReadonlyMap<string, ServiceActor>): ActionLogEntry {
  const actor: ActionActor = services.get(row.actor_id) ??
    { kind: "person", memberId: row.member_id, role: row.member_role };
  const outcome = row.result_status !== null && ACTION_OUTCOME_PATTERN.test(row.result_status) ? row.result_status : "done";
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
