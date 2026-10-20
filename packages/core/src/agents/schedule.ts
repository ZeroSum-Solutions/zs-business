// M6 scheduled runs (agents.md G-13). Original code. A scheduler visits only tenants whose agent
// could draft now, least recently run first, and skips any whose run for this slot already ended.
// The draft action still re-checks every switch and cap under its locks (G-3..G-5); this list
// only keeps a tick from recording a stopped run for every switched-off tenant.
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
      WHERE s.enabled AND s.killed_at IS NULL
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
