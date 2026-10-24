// Browser task actions an owner takes (BT-3, BT-9, BT-11, BT-12), through the one dispatcher. The
// runner's own writes are in service.ts. `browser.submit` is deliberately absent (BT-11).
import {
  Conflict, NotFound, ValidationFailed,
  killBrowserCommandSchema, requestBrowserRunCommandSchema, resumeBrowserCommandSchema, saveBrowserTargetCommandSchema,
  updateBrowserSettingsCommandSchema,
  type Permission, type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { readGlobalKilled } from "../agents/controls.js";
import { parseOrFail, tenantVisible } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import type { BrowserConfig } from "./config.js";
import { secretPrefix } from "./config.js";
import { browserStatus, dayFigures, getBrowserRun, getTarget, loadSettings } from "./rows.js";

export const BROWSER_SETTINGS_ACTION = "browser.settings.update";
export const BROWSER_TARGET_SAVE_ACTION = "browser.target.save";
export const BROWSER_KILL_ACTION = "browser.kill";
export const BROWSER_RESUME_ACTION = "browser.resume";
export const BROWSER_RUN_REQUEST_ACTION = "browser.run.request";

/** BT-3, BT-12: who may take each action. Merged into ACTION_PERMISSIONS; `browser.submit` is not here (BT-11). */
export const BROWSER_MEMBER_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  [BROWSER_SETTINGS_ACTION]: "agents",
  [BROWSER_TARGET_SAVE_ACTION]: "agents",
  [BROWSER_KILL_ACTION]: "inbox.drafts",
  [BROWSER_RESUME_ACTION]: "agents",
  [BROWSER_RUN_REQUEST_ACTION]: "agents",
});

/** The dispatcher's config for these actions: `{ browser }`. Without it the feature is off. */
function browserOf(config: unknown): BrowserConfig {
  const browser = (config as { browser?: BrowserConfig } | null)?.browser;
  if (!browser) throw new NotFound();
  return browser;
}

async function resolveSettings(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "browser_settings" || target.id !== target.tenantId || !(await tenantVisible(tx, target.tenantId))) return null;
  return target;
}

/** Insert the defaults when the tenant has no settings row yet, so a kill always has a row to engage. */
async function ensureSettings(tx: Transaction, tenantId: string, now: Date) {
  await tx.query(
    "INSERT INTO browser_task_settings (tenant_id, updated_at) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING", [tenantId, now]);
  return (await loadSettings(tx, tenantId, true))!;
}

const updateSettingsHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now, config }) {
    browserOf(config);
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(updateBrowserSettingsCommandSchema, command);
    const current = await loadSettings(tx, binding.tenantId, true);
    const revision = current?.revision ?? 0;
    if (payload.expectedRevision !== revision)
      throw new Conflict("The browser settings changed; reload and try again", { reason: "stale_revision", currentRevision: revision });
    if (!current)
      await tx.query(
        `INSERT INTO browser_task_settings (tenant_id, enabled, max_runs_per_day, max_cost_micros_per_day, updated_at) VALUES ($1,$2,$3,$4,$5)`,
        [binding.tenantId, payload.enabled, payload.maxRunsPerDay, payload.maxCostMicrosPerDay, now]);
    else
      await tx.query(
        `UPDATE browser_task_settings SET enabled=$2, max_runs_per_day=$3, max_cost_micros_per_day=$4, revision=revision+1, updated_at=$5
          WHERE tenant_id=$1`, [binding.tenantId, payload.enabled, payload.maxRunsPerDay, payload.maxCostMicrosPerDay, now]);
    return { result: JSON.parse(JSON.stringify(await browserStatus(tx, binding.tenantId, now))) };
  },
};

const killHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "inbox.drafts");
    const { payload } = parseOrFail(killBrowserCommandSchema, command);
    const current = await ensureSettings(tx, binding.tenantId, now);
    if (!current.killed_at)
      await tx.query("UPDATE browser_task_settings SET killed_at=$2, killed_by=$3, kill_note=$4, updated_at=$2 WHERE tenant_id=$1",
        [binding.tenantId, now, binding.actorId, payload.note ?? null]);
    return { result: JSON.parse(JSON.stringify(await browserStatus(tx, binding.tenantId, now))) };
  },
};

const resumeHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    parseOrFail(resumeBrowserCommandSchema, command);
    const current = await ensureSettings(tx, binding.tenantId, now);
    if (current.killed_at)
      await tx.query("UPDATE browser_task_settings SET killed_at=NULL, killed_by=NULL, kill_note=NULL, updated_at=$2 WHERE tenant_id=$1",
        [binding.tenantId, now]);
    return { result: JSON.parse(JSON.stringify(await browserStatus(tx, binding.tenantId, now))) };
  },
};

const saveTargetHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    return target.type === "browser_target" && (await tenantVisible(tx, target.tenantId)) ? target : null;
  },
  async handle({ tx, command, binding, now, config }) {
    const browser = browserOf(config);
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload, target } = parseOrFail(saveBrowserTargetCommandSchema, command);
    // The owner names the target to change in the payload; a new target takes the ID the edge derived.
    if (payload.targetId !== undefined && payload.targetId !== target.id) throw new ValidationFailed("Target must equal the target ID");
    for (const origin of payload.allowedOrigins)
      if (origin.startsWith("http://") && !browser.allowLoopback) throw new ValidationFailed("Targets must use https origins");
    const prefix = secretPrefix(binding.tenantId);
    if (payload.secretRef && !payload.secretRef.startsWith(prefix))
      throw new ValidationFailed(`A secret reference must start with ${prefix}`);
    const existing = (await tx.query<{ revision: number }>(
      "SELECT revision FROM browser_targets WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [binding.tenantId, target.id])).rows[0];
    // BT-3: the attestation is fresh with every enable and cleared when a target is turned off.
    const attestedBy = payload.enabled ? binding.actorId : null;
    const attestedAt = payload.enabled ? now : null;
    if (!existing) {
      if (payload.expectedRevision !== 0) throw new Conflict("The target does not exist", { reason: "stale_revision", currentRevision: 0 });
      await tx.query(
        `INSERT INTO browser_targets (tenant_id, id, name, task_kind, allowed_origins, allowed_paths, asset_paths, sign_in_path,
           enabled, attested_by, attested_at, revision, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
        [binding.tenantId, target.id, payload.name, payload.taskKind, payload.allowedOrigins, payload.allowedPaths, payload.assetPaths,
          payload.signInPath, payload.enabled, attestedBy, attestedAt, now]);
    } else {
      if (existing.revision !== payload.expectedRevision)
        throw new Conflict("The target changed; reload and try again", { reason: "stale_revision", currentRevision: existing.revision });
      await tx.query(
        `UPDATE browser_targets SET name=$3, task_kind=$4, allowed_origins=$5, allowed_paths=$6, asset_paths=$7, sign_in_path=$8,
           enabled=$9, attested_by=$10, attested_at=$11, revision=revision+1, updated_at=$12 WHERE tenant_id=$1 AND id=$2`,
        [binding.tenantId, target.id, payload.name, payload.taskKind, payload.allowedOrigins, payload.allowedPaths, payload.assetPaths,
          payload.signInPath, payload.enabled, attestedBy, attestedAt, now]);
    }
    if (payload.secretRef === null)
      await tx.query("DELETE FROM browser_credentials WHERE tenant_id=$1 AND target_id=$2", [binding.tenantId, target.id]);
    else if (payload.secretRef)
      await tx.query(
        `INSERT INTO browser_credentials (tenant_id, target_id, secret_ref, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, target_id) DO UPDATE SET secret_ref = EXCLUDED.secret_ref, updated_at = EXCLUDED.updated_at`,
        [binding.tenantId, target.id, payload.secretRef, now]);
    return { result: JSON.parse(JSON.stringify((await getTarget(tx, binding.tenantId, target.id))!)) };
  },
};

const requestRunHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    return target.type === "browser_run" && (await tenantVisible(tx, target.tenantId)) ? target : null;
  },
  async handle({ tx, command, binding, now, config }) {
    browserOf(config);
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload, target } = parseOrFail(requestBrowserRunCommandSchema, command);
    // Serialize requests of one tenant, so the daily counts below cannot both pass.
    const settings = await loadSettings(tx, binding.tenantId, true);
    const refuse = (reason: string) => new Conflict("A browser task cannot start now", { reason });
    if (await readGlobalKilled(tx, true)) throw refuse("global_killed");
    if (!settings?.enabled) throw refuse("disabled");
    if (settings.killed_at) throw refuse("tenant_killed");
    const found = await getTarget(tx, binding.tenantId, payload.targetId);
    if (!found) throw new NotFound();
    if (!found.enabled || !found.attestedBy) throw refuse("target_disabled");
    const figures = await dayFigures(tx, binding.tenantId, now);
    if (figures.runs >= settings.max_runs_per_day) throw refuse("daily_cap");
    if (figures.costMicros + figures.reservedMicros >= Number(settings.max_cost_micros_per_day)) throw refuse("cost_cap");
    await tx.query(
      `INSERT INTO browser_runs (tenant_id, id, target_id, task_kind, requested_by, requested_at, params, max_steps, deadline_ms, max_cost_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [binding.tenantId, target.id, found.id, found.taskKind, binding.actorId, now, JSON.stringify({ month: payload.month }),
        payload.maxSteps, payload.deadlineMs, payload.maxCostMicros]);
    return { result: JSON.parse(JSON.stringify((await getBrowserRun(tx, binding.tenantId, target.id))!)) };
  },
};

export const browserHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [BROWSER_SETTINGS_ACTION]: updateSettingsHandler,
  [BROWSER_TARGET_SAVE_ACTION]: saveTargetHandler,
  [BROWSER_KILL_ACTION]: killHandler,
  [BROWSER_RESUME_ACTION]: resumeHandler,
  [BROWSER_RUN_REQUEST_ACTION]: requestRunHandler,
});
