// Browser task reads and row mapping (BT-3, BT-9, BT-12). Reads run under the runtime role and RLS.
import type {
  BrowserArtifact, BrowserRun, BrowserRunDetail, BrowserRunEvent, BrowserStatus, BrowserStopReason, BrowserTarget,
} from "@zs/contracts";
import { BROWSER_LIMITS } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readGlobalKilled } from "../agents/controls.js";

export interface RunRow {
  tenant_id: string; id: string; target_id: string; task_kind: BrowserRun["taskKind"]; status: BrowserRun["status"];
  stop_reason: BrowserStopReason | null; requested_by: string; requested_at: Date; started_at: Date | null;
  finished_at: Date | null; params: { month?: string }; max_steps: number; deadline_ms: number; max_cost_micros: string | number;
  steps: number; cost_micros: string | number; attempt: number; lease_hash: string | null; lease_until: Date | null;
  artifact_count?: string | number;
}
export const RUN_COLUMNS = `tenant_id, id, target_id, task_kind, status, stop_reason, requested_by, requested_at, started_at,
  finished_at, params, max_steps, deadline_ms, max_cost_micros, steps, cost_micros, attempt, lease_hash, lease_until`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function mapRun(row: RunRow): BrowserRun {
  return {
    id: row.id, targetId: row.target_id, taskKind: row.task_kind, status: row.status, stopReason: row.stop_reason,
    requestedBy: row.requested_by, requestedAt: row.requested_at.toISOString(), startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at), month: row.params.month ?? "2026-01", maxSteps: row.max_steps, deadlineMs: row.deadline_ms,
    maxCostMicros: Number(row.max_cost_micros), steps: row.steps, costMicros: Number(row.cost_micros), attempt: row.attempt,
    artifactCount: Number(row.artifact_count ?? 0),
  };
}

interface TargetRow {
  id: string; name: string; task_kind: BrowserTarget["taskKind"]; allowed_origins: string[]; allowed_paths: string[];
  asset_paths: string[]; sign_in_path: string | null; enabled: boolean; attested_by: string | null; attested_at: Date | null;
  revision: number; updated_at: Date; has_credentials: boolean;
}
export const TARGET_SELECT = `SELECT t.id, t.name, t.task_kind, t.allowed_origins, t.allowed_paths, t.asset_paths, t.sign_in_path,
  t.enabled, t.attested_by, t.attested_at, t.revision, t.updated_at,
  EXISTS(SELECT 1 FROM browser_credentials c WHERE c.tenant_id = t.tenant_id AND c.target_id = t.id) AS has_credentials
  FROM browser_targets t`;
export function mapTarget(row: TargetRow): BrowserTarget {
  return {
    id: row.id, name: row.name, taskKind: row.task_kind, allowedOrigins: row.allowed_origins, allowedPaths: row.allowed_paths,
    assetPaths: row.asset_paths, signInPath: row.sign_in_path, enabled: row.enabled, attestedBy: row.attested_by,
    attestedAt: iso(row.attested_at), revision: row.revision, updatedAt: row.updated_at.toISOString(), hasCredentials: row.has_credentials,
  };
}
export async function getTarget(tx: Transaction, tenantId: string, id: string): Promise<BrowserTarget | null> {
  const row = (await tx.query<TargetRow>(`${TARGET_SELECT} WHERE t.tenant_id=$1 AND t.id=$2`, [tenantId, id])).rows[0];
  return row ? mapTarget(row) : null;
}

export interface SettingsRow {
  enabled: boolean; max_runs_per_day: number; max_cost_micros_per_day: string | number; killed_at: Date | null;
  killed_by: string | null; kill_note: string | null; revision: number; updated_at: Date;
}
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false, maxRunsPerDay: BROWSER_LIMITS.maxRunsPerDayDefault, maxCostMicrosPerDay: BROWSER_LIMITS.maxCostMicrosPerDayDefault,
});
export async function loadSettings(tx: Transaction, tenantId: string, lock: boolean): Promise<SettingsRow | null> {
  return (await tx.query<SettingsRow>(
    `SELECT enabled, max_runs_per_day, max_cost_micros_per_day, killed_at, killed_by, kill_note, revision, updated_at
       FROM browser_task_settings WHERE tenant_id=$1${lock ? " FOR UPDATE" : ""}`, [tenantId])).rows[0] ?? null;
}

const DAY_MS = 24 * 3_600_000;
/** BT-9: runs requested and cost recorded in the 24 hours before `now`. */
export async function dayFigures(tx: Transaction, tenantId: string, now: Date): Promise<{ runs: number; costMicros: number }> {
  const row = (await tx.query<{ runs: string; cost: string }>(
    `SELECT count(*)::text AS runs, coalesce(sum(cost_micros), 0)::text AS cost FROM browser_runs
      WHERE tenant_id=$1 AND requested_at > $2`, [tenantId, new Date(now.getTime() - DAY_MS)])).rows[0]!;
  return { runs: Number(row.runs), costMicros: Number(row.cost) };
}

/** BT-12: the status an owner reads, with the first reason a run cannot start now. */
export async function browserStatus(tx: Transaction, tenantId: string, now: Date): Promise<BrowserStatus> {
  const settings = await loadSettings(tx, tenantId, false);
  const globalKilled = await readGlobalKilled(tx, false);
  const figures = await dayFigures(tx, tenantId, now);
  const maxRuns = settings?.max_runs_per_day ?? DEFAULT_SETTINGS.maxRunsPerDay;
  const maxCost = Number(settings?.max_cost_micros_per_day ?? DEFAULT_SETTINGS.maxCostMicrosPerDay);
  let blockedBy: BrowserStatus["blockedBy"] = null;
  if (globalKilled) blockedBy = "global_killed";
  else if (!settings?.enabled) blockedBy = "disabled";
  else if (settings.killed_at) blockedBy = "tenant_killed";
  else if (figures.runs >= maxRuns) blockedBy = "daily_cap";
  else if (figures.costMicros >= maxCost) blockedBy = "cost_cap";
  const targets = (await tx.query<TargetRow>(`${TARGET_SELECT} WHERE t.tenant_id=$1 ORDER BY t.name, t.id`, [tenantId])).rows.map(mapTarget);
  return {
    settings: { enabled: settings?.enabled ?? false, maxRunsPerDay: maxRuns, maxCostMicrosPerDay: maxCost },
    revision: settings?.revision ?? 0,
    updatedAt: iso(settings?.updated_at ?? null),
    killed: settings?.killed_at ? { at: settings.killed_at.toISOString(), by: settings.killed_by!, note: settings.kill_note } : null,
    globalKilled, blockedBy, runsToday: figures.runs, costTodayMicros: figures.costMicros, targets,
  };
}

const RUN_WITH_COUNT = `SELECT ${RUN_COLUMNS.split(",").map((column) => `r.${column.trim()}`).join(", ")},
  (SELECT count(*) FROM browser_run_artifacts a WHERE a.tenant_id = r.tenant_id AND a.run_id = r.id AND a.kind = 'invoice_pdf') AS artifact_count
  FROM browser_runs r`;
export async function listBrowserRuns(tx: Transaction, tenantId: string, limit = 20): Promise<BrowserRun[]> {
  return (await tx.query<RunRow>(`${RUN_WITH_COUNT} WHERE r.tenant_id=$1 ORDER BY r.requested_at DESC, r.id LIMIT $2`, [tenantId, limit])).rows.map(mapRun);
}
export async function getBrowserRun(tx: Transaction, tenantId: string, runId: string): Promise<BrowserRun | null> {
  const row = (await tx.query<RunRow>(`${RUN_WITH_COUNT} WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, runId])).rows[0];
  return row ? mapRun(row) : null;
}

export async function getBrowserRunDetail(tx: Transaction, tenantId: string, runId: string): Promise<BrowserRunDetail | null> {
  const run = await getBrowserRun(tx, tenantId, runId);
  if (!run) return null;
  const events = (await tx.query<{
    seq: number; origin: string | null; path: string | null; action: BrowserRunEvent["action"]; screenshot_ref: string | null;
    model: string | null; input_tokens: number; output_tokens: number; cost_micros: string | number; created_at: Date;
  }>(`SELECT seq, origin, path, action, screenshot_ref, model, input_tokens, output_tokens, cost_micros, created_at
        FROM browser_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY seq`, [tenantId, runId])).rows.map((row): BrowserRunEvent => ({
    seq: row.seq, origin: row.origin, path: row.path, action: row.action, screenshotRef: row.screenshot_ref, model: row.model,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens, costMicros: Number(row.cost_micros), createdAt: row.created_at.toISOString(),
  }));
  const artifacts = (await tx.query<{ id: string; kind: BrowserArtifact["kind"]; name: string; bytes: number; sha256: string; created_at: Date }>(
    `SELECT id, kind, name, bytes, sha256, created_at FROM browser_run_artifacts WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at, id`,
    [tenantId, runId])).rows.map((row): BrowserArtifact => ({
    id: row.id, kind: row.kind, name: row.name, bytes: row.bytes, sha256: row.sha256, createdAt: row.created_at.toISOString(),
  }));
  return { run, events, artifacts };
}

export async function getArtifactKey(tx: Transaction, tenantId: string, runId: string, artifactId: string):
  Promise<{ key: string; name: string; kind: BrowserArtifact["kind"] } | null> {
  const row = (await tx.query<{ storage_key: string; name: string; kind: BrowserArtifact["kind"] }>(
    "SELECT storage_key, name, kind FROM browser_run_artifacts WHERE tenant_id=$1 AND run_id=$2 AND id=$3", [tenantId, runId, artifactId])).rows[0];
  return row ? { key: row.storage_key, name: row.name, kind: row.kind } : null;
}
