// M6 run and decision records (agents.md G-10, G-11). Runs inside ScopedDatabase.tenant under
// the runtime role; RLS limits rows to the tenant and the tenant_id filters are defence in depth.
import type {
  FollowUpDecision,
  FollowUpRun,
  FollowUpRunDetail,
  FollowUpRunPage,
  FollowUpSkipReason,
  FollowUpStopReason,
  ListFollowUpRunsQuery,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "../reads/cursor.js";
import { page } from "../reads/page.js";

interface RunRow {
  id: string;
  requested_by: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: FollowUpRun["status"];
  stop_reason: FollowUpStopReason | null;
  considered: number;
  drafted: number;
  skipped: number;
}
interface DecisionRow {
  id: string;
  run_id: string;
  intake_item_id: string;
  contact_id: string;
  outcome: "drafted" | "skipped";
  reason: FollowUpSkipReason | null;
  reply_id: string | null;
  approval_id: string | null;
  created_at: Date;
}

const RUN_COLUMNS = "id, requested_by, started_at, finished_at, status, stop_reason, considered, drafted, skipped";
const DECISION_COLUMNS = "id, run_id, intake_item_id, contact_id, outcome, reason, reply_id, approval_id, created_at";

const runRecord = (row: RunRow): FollowUpRun => ({
  id: row.id,
  agent: "inquiry_followup",
  requestedBy: row.requested_by,
  startedAt: row.started_at.toISOString(),
  finishedAt: row.finished_at?.toISOString() ?? null,
  status: row.status,
  stopReason: row.stop_reason,
  considered: row.considered,
  drafted: row.drafted,
  skipped: row.skipped,
});
export const decisionRecord = (row: DecisionRow): FollowUpDecision => ({
  id: row.id,
  runId: row.run_id,
  intakeItemId: row.intake_item_id,
  contactId: row.contact_id,
  outcome: row.outcome,
  reason: row.reason,
  replyId: row.reply_id,
  approvalId: row.approval_id,
  createdAt: row.created_at.toISOString(),
});

export async function loadRun(tx: Transaction, tenantId: string, runId: string, lock = false): Promise<FollowUpRun | null> {
  const row = (await tx.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, runId],
  )).rows[0];
  return row ? runRecord(row) : null;
}

export async function loadDecision(tx: Transaction, tenantId: string, id: string): Promise<FollowUpDecision | null> {
  const row = (await tx.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM agent_followups WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
  )).rows[0];
  return row ? decisionRecord(row) : null;
}

/** A run with its decisions, oldest first, or null when the tenant has no such run. */
export async function getRun(tx: Transaction, tenantId: string, runId: string): Promise<FollowUpRunDetail | null> {
  const run = await loadRun(tx, tenantId, runId);
  if (!run) return null;
  const decisions = (await tx.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM agent_followups WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at, id`,
    [tenantId, runId],
  )).rows.map(decisionRecord);
  return { ...run, decisions };
}

/** G-11: runs, newest first, by keyset cursor (or offset). */
export async function listRuns(tx: Transaction, tenantId: string, query: ListFollowUpRunsQuery): Promise<FollowUpRunPage> {
  const after = decodeCursor("agents.runs", query);
  const rows = (await tx.query<RunRow & { position: string }>(
    `SELECT ${RUN_COLUMNS}, ${timestampToMicros("started_at")} AS position FROM agent_runs
      WHERE tenant_id=$1 ${after ? `AND (started_at, id) < (${microsToTimestamp("$4")}, $5::uuid)` : ""}
      ORDER BY started_at DESC, id DESC LIMIT $2 OFFSET $3`,
    after ? [tenantId, query.limit + 1, 0, after[0], after[1]] : [tenantId, query.limit + 1, query.offset],
  )).rows;
  return page(rows.map(runRecord), query, (index) => encodeCursor("agents.runs", [rows[index]!.position, rows[index]!.id]));
}
