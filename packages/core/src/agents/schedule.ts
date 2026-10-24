// M6 scheduled runs (agents.md G-13). Original code. A scheduler visits only tenants whose agent
// could draft now, least recently run first, and skips any whose run for this slot already ended.
// The draft action still re-checks every switch and cap under its locks (G-3..G-5); this list
// only keeps a tick from recording a stopped run for every switched-off tenant.
import type { AgentKind, TemplatedKind } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { controlsFromRow, gate, readGlobalKilled, SETTINGS_COLUMNS, type SettingsRow } from "./controls.js";
import { followUpRunId } from "./runner.js";

/** The idempotency key of a scheduled run; one run per tenant per slot. */
export const scheduledRunKey = (slot: string) => `schedule:${slot}`;

/** The slot `now` falls in: the start of its `slotMinutes` window, as an ISO instant. */
export function scheduleSlot(now: Date, slotMinutes: number): string {
  const size = slotMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / size) * size).toISOString();
}

export interface DueFollowUpTenants {
  readonly globalKilled: boolean;
  readonly tenantIds: readonly string[];
}

/** Service role: every tenant reads differently, and the runtime role sees one tenant only. */
export async function dueFollowUpTenants(tx: Transaction, now: Date, slot: string): Promise<DueFollowUpTenants> {
  if (await readGlobalKilled(tx, false)) return { globalKilled: true, tenantIds: [] };
  const rows = (await tx.query<SettingsRow & { tenant_id: string }>(
    `SELECT s.tenant_id, ${SETTINGS_COLUMNS} FROM agent_settings s
      WHERE s.agent_kind = 'inquiry_followup' AND s.enabled AND s.killed_at IS NULL
      ORDER BY (SELECT max(r.started_at) FROM agent_runs r WHERE r.tenant_id = s.tenant_id) ASC NULLS FIRST, s.tenant_id`,
  )).rows.filter((row) => gate(controlsFromRow(row), false, now) === null);
  if (rows.length === 0) return { globalKilled: false, tenantIds: [] };
  const key = scheduledRunKey(slot);
  const ended = new Set((await tx.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM agent_runs WHERE id = ANY($1::uuid[]) AND status <> 'running'",
    [rows.map((row) => followUpRunId(row.tenant_id, key))],
  )).rows.map((row) => row.tenant_id));
  return { globalKilled: false, tenantIds: rows.map((row) => row.tenant_id).filter((id) => !ended.has(id)) };
}

/** G-13, G-19: a templated kind's scheduled run is named by its kind as well as the slot. */
export const scheduledKindRunKey = (kind: TemplatedKind, slot: string) => `schedule:${kind}:${slot}`;

/** Service role, like `dueFollowUpTenants`, for one templated kind. */
export async function dueKindTenants(tx: Transaction, kind: TemplatedKind, now: Date, slot: string): Promise<DueFollowUpTenants> {
  if (await readGlobalKilled(tx, false)) return { globalKilled: true, tenantIds: [] };
  const rows = (await tx.query<SettingsRow & { tenant_id: string }>(
    `SELECT s.tenant_id, ${SETTINGS_COLUMNS} FROM agent_settings s
      WHERE s.agent_kind = $1 AND s.enabled AND s.killed_at IS NULL
      ORDER BY (SELECT max(r.started_at) FROM agent_runs r WHERE r.tenant_id = s.tenant_id AND r.agent = s.agent_kind) ASC NULLS FIRST, s.tenant_id`,
    [kind],
  )).rows.filter((row) => gate(controlsFromRow(row, kind), false, now) === null);
  if (rows.length === 0) return { globalKilled: false, tenantIds: [] };
  const key = scheduledKindRunKey(kind, slot);
  const ended = new Set((await tx.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM agent_runs WHERE id = ANY($1::uuid[]) AND status <> 'running'",
    [rows.map((row) => followUpRunId(row.tenant_id, key))],
  )).rows.map((row) => row.tenant_id));
  return { globalKilled: false, tenantIds: rows.map((row) => row.tenant_id).filter((id) => !ended.has(id)) };
}

export interface StalledRun {
  readonly tenantId: string;
  readonly runId: string;
  readonly agentKind: AgentKind;
}

/**
 * G-16: runs that have stayed `running` since before `now - stallAfterMs`, oldest first, up to
 * `limit`. Service role, like the due-tenant read; the closing itself is the kind's own action.
 */
export async function stalledRuns(tx: Transaction, now: Date, stallAfterMs: number, limit = 100): Promise<StalledRun[]> {
  return (await tx.query<{ tenant_id: string; id: string; agent: AgentKind }>(
    "SELECT tenant_id, id, agent FROM agent_runs WHERE status='running' AND started_at < $1 ORDER BY started_at, id LIMIT $2",
    [new Date(now.getTime() - stallAfterMs), limit],
  )).rows.map((row) => ({ tenantId: row.tenant_id, runId: row.id, agentKind: row.agent }));
}
