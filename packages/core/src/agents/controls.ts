// M6 agent controls (agents.md G-2..G-5, G-14, G-15): settings, the two kill switches, quiet hours,
// the caps and the daily cost cap. Original code. Every check reads time from the caller's
// injected clock. Each kind has its own settings row (G-14); the global switch stops them all.
import {
  DEFAULT_FOLLOW_UP_SETTINGS,
  DEFAULT_MAX_COST_MICROS_PER_DAY,
  agentKindConfigSchemas,
  ValidationFailed,
  type AgentKind,
  type AgentKindSettings,
  type AgentKindStatus,
  type FollowUpSettings,
  type FollowUpStatus,
  type FollowUpStopReason,
  type FollowUpSwitchReason,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { offsetAt } from "../booking/time-zone.js";
import { derivedId } from "../edge/ids.js";
import { atWarningLine, costSpent } from "./cost.js";

/**
 * G-1, G-14: the actor every action of one kind runs as, per tenant. No member has this ID.
 * `inquiry_followup` keeps G-1's `followup-agent` ID; every other kind derives its own.
 */
export const agentActorId = (tenantId: string, kind: AgentKind = "inquiry_followup") =>
  derivedId(tenantId, kind === "inquiry_followup" ? "followup-agent" : `${kind}-agent`, "actor");

export interface SettingsRow {
  agent_kind: AgentKind;
  config: AgentKindSettings["config"];
  max_cost_micros_per_day: number;
  enabled: boolean;
  max_drafts_per_day: number;
  max_drafts_per_contact: number;
  contact_window_hours: number;
  wait_hours: number;
  lookback_days: number;
  quiet_start_minute: number;
  quiet_end_minute: number;
  time_zone: string;
  killed_at: Date | null;
  killed_by: string | null;
  kill_note: string | null;
  revision: number;
  updated_at: Date;
}

export interface AgentControls {
  readonly settings: FollowUpSettings;
  readonly revision: number;
  readonly updatedAt: Date | null;
  readonly killed: { readonly at: Date; readonly by: string; readonly note: string | null } | null;
  /** G-14: the kind's own settings (`agentKindConfigSchemas`), defaults filled in. */
  readonly config: AgentKindSettings["config"];
  /** G-15: USD millionths the kind may spend on model calls in 24 hours. */
  readonly maxCostMicrosPerDay: number;
}

export const SETTINGS_COLUMNS = `agent_kind, config, max_cost_micros_per_day, enabled, max_drafts_per_day, max_drafts_per_contact,
  contact_window_hours, wait_hours, lookback_days, quiet_start_minute, quiet_end_minute, time_zone, killed_at, killed_by,
  kill_note, revision, updated_at`;

export function controlsFromRow(row: SettingsRow | undefined, kind: AgentKind = "inquiry_followup"): AgentControls {
  if (!row) {
    return {
      settings: DEFAULT_FOLLOW_UP_SETTINGS, revision: 0, updatedAt: null, killed: null,
      config: agentKindConfigSchemas[kind].parse({}) as AgentKindSettings["config"],
      maxCostMicrosPerDay: DEFAULT_MAX_COST_MICROS_PER_DAY,
    };
  }
  return {
    settings: {
      enabled: row.enabled,
      maxDraftsPerDay: row.max_drafts_per_day,
      maxDraftsPerContact: row.max_drafts_per_contact,
      contactWindowHours: row.contact_window_hours,
      waitHours: row.wait_hours,
      lookbackDays: row.lookback_days,
      quietStartMinute: row.quiet_start_minute,
      quietEndMinute: row.quiet_end_minute,
      timeZone: row.time_zone,
    },
    revision: row.revision,
    updatedAt: row.updated_at,
    killed: row.killed_at && row.killed_by ? { at: row.killed_at, by: row.killed_by, note: row.kill_note } : null,
    config: row.config,
    maxCostMicrosPerDay: row.max_cost_micros_per_day,
  };
}

/**
 * The kind's settings for the tenant. `lock` takes the row FOR UPDATE: every agent draft and
 * every kill, resume or settings write for the kind then serializes on it (G-3, G-4).
 */
export async function loadControls(
  tx: Transaction, tenantId: string, lock: boolean, kind: AgentKind = "inquiry_followup",
): Promise<AgentControls> {
  const row = (await tx.query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM agent_settings WHERE tenant_id=$1 AND agent_kind=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, kind],
  )).rows[0];
  return controlsFromRow(row, kind);
}

/**
 * G-3: the global switch. Drafts take this advisory lock shared and a flip takes it exclusively,
 * so a flip waits for drafts in flight and every draft after it sees it. The key is not a UUID,
 * so it never meets the dispatcher's `${tenantId}:${key}` locks.
 */
const GLOBAL_LOCK = "agent-global-switch";
export async function readGlobalKilled(tx: Transaction, lock: boolean): Promise<boolean> {
  if (lock) await tx.query("SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended($1, 0))", [GLOBAL_LOCK]);
  const row = (await tx.query<{ killed: boolean }>("SELECT killed FROM agent_global_switch WHERE id")).rows[0];
  // A missing row reads as killed: the migration always writes it, so this fails closed.
  return row?.killed ?? true;
}

/**
 * G-3: flip the global switch. Service role only (the operator's path; the hub calls it), so it
 * runs outside the dispatcher and any tenant.
 */
export async function setGlobalAgentSwitch(
  tx: Transaction, input: { readonly killed: boolean; readonly note?: string | null; readonly now: Date },
): Promise<void> {
  if (!Number.isFinite(input.now.getTime())) throw new ValidationFailed("Invalid time");
  await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [GLOBAL_LOCK]);
  await tx.query("UPDATE agent_global_switch SET killed=$1, note=$2, updated_at=$3 WHERE id",
    [input.killed, input.note ?? null, input.now]);
}

/** G-5: whether `now` falls in the quiet window, in the tenant's zone. Equal ends: no window. */
export function inQuietHours(settings: FollowUpSettings, now: Date): boolean {
  const { quietStartMinute: start, quietEndMinute: end } = settings;
  if (start === end) return false;
  const local = now.getTime() + offsetAt(settings.timeZone, now.getTime());
  const minute = Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** G-3, G-5: the first reason the agent may not draft now, or null. */
export function gate(controls: AgentControls, globalKilled: boolean, now: Date): FollowUpSwitchReason | null {
  if (globalKilled) return "global_killed";
  if (!controls.settings.enabled) return "disabled";
  if (controls.killed) return "tenant_killed";
  if (inQuietHours(controls.settings, now)) return "quiet_hours";
  return null;
}

const HOUR_MS = 3_600_000;

/**
 * G-4: agent drafts in the tenant in the 24 hours before now. No upper bound: a run whose clock
 * is behind another's must still count a draft that committed with a later time.
 */
export async function draftsToday(tx: Transaction, tenantId: string, now: Date): Promise<number> {
  return Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM agent_followups WHERE tenant_id=$1 AND outcome='drafted' AND created_at > $2",
    [tenantId, new Date(now.getTime() - 24 * HOUR_MS)],
  )).rows[0]!.n);
}

/** G-4: agent drafts for one customer in the settings' window before now; no upper bound, as above. */
export async function contactDrafts(tx: Transaction, tenantId: string, contactId: string, settings: FollowUpSettings, now: Date): Promise<number> {
  return Number((await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_followups
      WHERE tenant_id=$1 AND contact_id=$2 AND outcome='drafted' AND created_at > $3`,
    [tenantId, contactId, new Date(now.getTime() - settings.contactWindowHours * HOUR_MS)],
  )).rows[0]!.n);
}

/** G-15: a kind's cost against its cap. */
export interface CostFigures {
  readonly spent: number;
  readonly cap: number;
  /** At 80% of the cap or more. */
  readonly warning: boolean;
}
export async function costFigures(tx: Transaction, tenantId: string, kind: AgentKind, controls: AgentControls, now: Date): Promise<CostFigures> {
  const spent = await costSpent(tx, tenantId, kind, now);
  return { spent, cap: controls.maxCostMicrosPerDay, warning: atWarningLine(spent, controls.maxCostMicrosPerDay) };
}

/** G-11: the status a member reads. */
export async function followUpStatus(tx: Transaction, tenantId: string, now: Date): Promise<FollowUpStatus> {
  const controls = await loadControls(tx, tenantId, false);
  const globalKilled = await readGlobalKilled(tx, false);
  let blockedBy: FollowUpStopReason | null = gate(controls, globalKilled, now);
  if (!blockedBy && (await draftsToday(tx, tenantId, now)) >= controls.settings.maxDraftsPerDay) blockedBy = "daily_cap";
  const cost = await costFigures(tx, tenantId, "inquiry_followup", controls, now);
  if (!blockedBy && cost.spent >= cost.cap) blockedBy = "cost_cap";
  return statusRecord(controls, globalKilled, blockedBy, cost);
}

export function statusRecord(
  controls: AgentControls, globalKilled: boolean, blockedBy: FollowUpStopReason | null, cost: CostFigures,
): FollowUpStatus {
  return {
    settings: { ...controls.settings },
    revision: controls.revision,
    updatedAt: controls.updatedAt?.toISOString() ?? null,
    killed: controls.killed
      ? { at: controls.killed.at.toISOString(), by: controls.killed.by, note: controls.killed.note }
      : null,
    globalKilled,
    canDraft: blockedBy === null,
    blockedBy,
    costSpentMicros: cost.spent,
    costCapMicros: cost.cap,
    costWarning: cost.warning,
  };
}

/** G-14: a kind's settings as the generic routes show them. */
export function kindSettings(controls: AgentControls): AgentKindSettings {
  return {
    enabled: controls.settings.enabled,
    quietStartMinute: controls.settings.quietStartMinute,
    quietEndMinute: controls.settings.quietEndMinute,
    timeZone: controls.settings.timeZone,
    maxCostMicrosPerDay: controls.maxCostMicrosPerDay,
    config: controls.config,
  };
}

/** G-11, G-14: the status of any kind, with the first reason it may not act now. */
export async function agentKindStatus(tx: Transaction, tenantId: string, kind: AgentKind, now: Date): Promise<AgentKindStatus> {
  const controls = await loadControls(tx, tenantId, false, kind);
  const globalKilled = await readGlobalKilled(tx, false);
  let blockedBy: FollowUpStopReason | null = gate(controls, globalKilled, now);
  const cost = await costFigures(tx, tenantId, kind, controls, now);
  if (!blockedBy && cost.spent >= cost.cap) blockedBy = "cost_cap";
  return kindStatusRecord(kind, controls, globalKilled, blockedBy, cost);
}

export function kindStatusRecord(
  kind: AgentKind, controls: AgentControls, globalKilled: boolean, blockedBy: FollowUpStopReason | null, cost: CostFigures,
): AgentKindStatus {
  return {
    agentKind: kind,
    settings: kindSettings(controls),
    revision: controls.revision,
    updatedAt: controls.updatedAt?.toISOString() ?? null,
    killed: controls.killed
      ? { at: controls.killed.at.toISOString(), by: controls.killed.by, note: controls.killed.note }
      : null,
    globalKilled,
    canRun: blockedBy === null,
    blockedBy,
    costSpentMicros: cost.spent,
    costCapMicros: cost.cap,
    costWarning: cost.warning,
  };
}
