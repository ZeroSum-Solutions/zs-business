// M6 agent actions (agents.md G-2, G-3, G-6). Original code. Each runs through the shared
// dispatcher: the settings actions as a member, the run and decision actions as the tenant's
// agent principal (G-1). Nothing here approves or sends; a draft hands its send to an owner.
import {
  APPROVAL_DEFAULT_MINUTES,
  Conflict,
  draftFollowUpCommandSchema,
  finishFollowUpRunCommandSchema,
  killFollowUpCommandSchema,
  resumeFollowUpCommandSchema,
  skipFollowUpCommandSchema,
  startFollowUpRunCommandSchema,
  TenantDenied,
  updateFollowUpSettingsCommandSchema,
  ValidationFailed,
  type FollowUpSkipReason,
  type FollowUpStopReason,
  type Permission,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { idInUse, parseOrFail, tenantVisible } from "../crm/rows.js";
import { SEND_REPLY_ACTION } from "../inbox/replies.js";
import { requireMember } from "../members/access.js";
import { checkCandidate, loadInquiry } from "./candidates.js";
import {
  draftsToday,
  gate,
  loadControls,
  readGlobalKilled,
  statusRecord,
  type AgentControls,
} from "./controls.js";
import { loadDecision, loadRun } from "./records.js";

export const UPDATE_SETTINGS_ACTION = "agent.settings.update";
export const KILL_ACTION = "agent.kill";
export const RESUME_ACTION = "agent.resume";
export const START_RUN_ACTION = "agent.run.start";
export const FINISH_RUN_ACTION = "agent.run.finish";
export const SKIP_ACTION = "agent.followup.skip";
export const DRAFT_ACTION = "agent.followup.draft";

/** G-1: the only actions the agent principal may run. */
export const AGENT_ACTIONS: readonly string[] = Object.freeze([START_RUN_ACTION, FINISH_RUN_ACTION, SKIP_ACTION, DRAFT_ACTION]);
/** G-2, G-3: the member actions and the permission each needs. */
export const AGENT_MEMBER_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  [UPDATE_SETTINGS_ACTION]: "agents",
  [KILL_ACTION]: "inbox.drafts",
  [RESUME_ACTION]: "agents",
});

/** The settings target is the tenant itself: one settings row per tenant. */
async function resolveSettings(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_settings") throw new ValidationFailed("Agent settings actions require an agent_settings target");
  if (target.id !== target.tenantId || !(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: "agent_settings", id: target.id };
}

/** The status after a settings write, from the locked row; the daily count is read as of now. */
async function statusAfterWrite(tx: Transaction, tenantId: string, now: Date) {
  const controls = await loadControls(tx, tenantId, false);
  const globalKilled = await readGlobalKilled(tx, false);
  let blockedBy = gate(controls, globalKilled, now);
  if (!blockedBy && (await draftsToday(tx, tenantId, now)) >= controls.settings.maxDraftsPerDay) blockedBy = "daily_cap";
  return { result: statusRecord(controls, globalKilled, blockedBy) };
}

/** Insert the defaults when the tenant has no row yet, so a kill always has a row to engage. */
async function ensureRow(tx: Transaction, tenantId: string, now: Date): Promise<AgentControls> {
  await tx.query("INSERT INTO agent_settings (tenant_id, updated_at) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING", [tenantId, now]);
  return loadControls(tx, tenantId, true);
}

export const updateSettingsHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(updateFollowUpSettingsCommandSchema, command);
    const current = await loadControls(tx, binding.tenantId, true);
    if (current.revision !== payload.expectedRevision)
      throw new Conflict("The agent settings changed", { reason: "stale_revision", currentRevision: current.revision });
    const values = [payload.enabled, payload.maxDraftsPerDay, payload.maxDraftsPerContact, payload.contactWindowHours,
      payload.waitHours, payload.lookbackDays, payload.quietStartMinute, payload.quietEndMinute, payload.timeZone, binding.actorId, now];
    if (current.revision === 0) {
      // No row to lock yet: a concurrent first save (or a kill's default row) that commits first
      // makes this insert wait and then do nothing. Its row is then the current revision.
      const inserted = await tx.query(
        `INSERT INTO agent_settings (enabled, max_drafts_per_day, max_drafts_per_contact, contact_window_hours, wait_hours,
           lookback_days, quiet_start_minute, quiet_end_minute, time_zone, updated_by, updated_at, tenant_id, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1) ON CONFLICT (tenant_id) DO NOTHING`,
        [...values, binding.tenantId],
      );
      if (inserted.rowCount === 0)
        throw new Conflict("The agent settings changed", {
          reason: "stale_revision", currentRevision: (await loadControls(tx, binding.tenantId, false)).revision,
        });
    } else {
      await tx.query(
        `UPDATE agent_settings SET enabled=$1, max_drafts_per_day=$2, max_drafts_per_contact=$3, contact_window_hours=$4,
           wait_hours=$5, lookback_days=$6, quiet_start_minute=$7, quiet_end_minute=$8, time_zone=$9, updated_by=$10,
           updated_at=$11, revision=revision+1
         WHERE tenant_id=$12`,
        [...values, binding.tenantId],
      );
    }
    return statusAfterWrite(tx, binding.tenantId, now);
  },
};

/** G-3: engage the tenant's switch. A switch already engaged keeps its first time and note. */
export const killHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "inbox.drafts");
    const { payload } = parseOrFail(killFollowUpCommandSchema, command);
    const current = await ensureRow(tx, binding.tenantId, now);
    if (!current.killed)
      await tx.query("UPDATE agent_settings SET killed_at=$2, killed_by=$3, kill_note=$4 WHERE tenant_id=$1",
        [binding.tenantId, now, binding.actorId, payload.note ?? null]);
    return statusAfterWrite(tx, binding.tenantId, now);
  },
};

/** G-3: release the tenant's switch; owners only. */
export const resumeHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    parseOrFail(resumeFollowUpCommandSchema, command);
    const current = await loadControls(tx, binding.tenantId, true);
    if (current.killed)
      await tx.query("UPDATE agent_settings SET killed_at=NULL, killed_by=NULL, kill_note=NULL WHERE tenant_id=$1", [binding.tenantId]);
    return statusAfterWrite(tx, binding.tenantId, now);
  },
};

async function resolveRun(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_run") throw new ValidationFailed("Agent run actions require an agent_run target");
  return (await loadRun(tx, target.tenantId, target.id)) ? { tenantId: target.tenantId, type: "agent_run", id: target.id } : null;
}

export const startRunHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "agent_run") throw new ValidationFailed("Agent run actions require an agent_run target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadRun(tx, target.tenantId, target.id)) throw new Conflict("The run ID is already in use", { reason: "id_in_use" });
    return { tenantId: target.tenantId, type: "agent_run", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(startFollowUpRunCommandSchema, command);
    const tenantId = binding.tenantId;
    const controls = await loadControls(tx, tenantId, false);
    let stop: FollowUpStopReason | null = gate(controls, await readGlobalKilled(tx, false), now);
    if (!stop && (await draftsToday(tx, tenantId, now)) >= controls.settings.maxDraftsPerDay) stop = "daily_cap";
    await tx.query(
      `INSERT INTO agent_runs (tenant_id, id, requested_by, started_at, finished_at, status, stop_reason, max_decisions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, payload.runId, payload.requestedBy, now, stop ? now : null, stop ? "stopped" : "running", stop, payload.maxDecisions],
    );
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

/** Close a run with counts from its decisions. A closed run stays as it is. */
export const finishRunHandler: ActionHandler = {
  resolveTarget: resolveRun,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(finishFollowUpRunCommandSchema, command);
    const tenantId = binding.tenantId;
    const run = (await loadRun(tx, tenantId, payload.runId, true))!;
    if (run.status === "running") {
      await tx.query(
        `UPDATE agent_runs r SET finished_at=$3, status=$4, stop_reason=$5,
           considered=c.considered, drafted=c.drafted, skipped=c.skipped
           FROM (SELECT count(*)::int AS considered,
                        (count(*) FILTER (WHERE outcome='drafted'))::int AS drafted,
                        (count(*) FILTER (WHERE outcome='skipped'))::int AS skipped
                   FROM agent_followups WHERE tenant_id=$1 AND run_id=$2) c
          WHERE r.tenant_id=$1 AND r.id=$2`,
        [tenantId, payload.runId, now, payload.stopReason ? "stopped" : "completed", payload.stopReason],
      );
    }
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

async function resolveNewDecision(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_followup") throw new ValidationFailed("Agent decisions require an agent_followup target");
  if (!(await tenantVisible(tx, target.tenantId))) return null;
  if (await loadDecision(tx, target.tenantId, target.id)) throw new Conflict("The decision ID is already in use", { reason: "id_in_use" });
  return { tenantId: target.tenantId, type: "agent_followup", id: target.id };
}

/**
 * The decision's run must be this tenant's, still open and under its limit (G-7); its inquiry
 * must be this customer's. The run's row stays locked until the decision commits, so calls that
 * resume one run concurrently cannot together decide more than its limit.
 */
async function requireOpenRunAndInquiry(tx: Transaction, tenantId: string, input: { runId: string; intakeItemId: string; contactId: string }) {
  const inquiry = await loadInquiry(tx, tenantId, input.intakeItemId, input.contactId);
  const run = (await tx.query<{ status: string; max_decisions: number }>(
    "SELECT status, max_decisions FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, input.runId],
  )).rows[0];
  if (!inquiry || !run) throw new TenantDenied();
  if (run.status !== "running") throw new Conflict("The run has finished", { reason: "run_finished" });
  // Counted after the lock, in a statement of its own, so it sees every decision committed before.
  const decided = (await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agent_followups WHERE tenant_id=$1 AND run_id=$2", [tenantId, input.runId],
  )).rows[0]!.n;
  if (decided >= run.max_decisions) throw new Conflict("The run has decided its limit", { reason: "run_limit" });
  return inquiry;
}

async function recordSkip(
  tx: Transaction, tenantId: string, input: { followupId: string; runId: string; intakeItemId: string; contactId: string },
  reason: FollowUpSkipReason, now: Date,
) {
  await tx.query(
    `INSERT INTO agent_followups (tenant_id, id, run_id, intake_item_id, contact_id, outcome, reason, created_at)
     VALUES ($1,$2,$3,$4,$5,'skipped',$6,$7)`,
    [tenantId, input.followupId, input.runId, input.intakeItemId, input.contactId, reason, now],
  );
  const decision = (await loadDecision(tx, tenantId, input.followupId))!;
  return {
    result: decision,
    event: { type: "agent.followup.skipped", payload: { runId: input.runId, followupId: input.followupId, reason } },
  };
}

/** G-8: record a decision the run made before calling the model. */
export const skipHandler: ActionHandler = {
  resolveTarget: resolveNewDecision,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(skipFollowUpCommandSchema, command);
    await requireOpenRunAndInquiry(tx, binding.tenantId, payload);
    return recordSkip(tx, binding.tenantId, payload, payload.reason, now);
  },
};

/**
 * G-3..G-8: lock the switches and settings, check everything again, then write the reply, its
 * pending send proposal and the decision together, or record why not. The proposal is the same
 * row approval.request writes (approvals.md A-5), requested by the agent; only an owner decides
 * it, and the decider runs the send (A-6, A-7). No send event is written here.
 */
export const draftHandler: ActionHandler = {
  resolveTarget: resolveNewDecision,
  async handle({ tx, command, binding, clock }) {
    const { payload } = parseOrFail(draftFollowUpCommandSchema, command);
    const tenantId = binding.tenantId;
    // Lock order: global (shared advisory), then the tenant's settings row. Kills take the same.
    const globalKilled = await readGlobalKilled(tx, true);
    const controls = await loadControls(tx, tenantId, true);
    const inquiry = await requireOpenRunAndInquiry(tx, tenantId, payload);
    // G-7: hold the customer while checking that this is still their latest request. Linking a
    // request to them locks the same row, so none can land between the check and the draft.
    await tx.query("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, payload.contactId]);
    // Read the clock once the locks are held, so a wait on them counts toward quiet hours.
    const now = clock();
    let reason: FollowUpSkipReason | null = gate(controls, globalKilled, now);
    if (!reason && (await draftsToday(tx, tenantId, now)) >= controls.settings.maxDraftsPerDay) reason = "daily_cap";
    reason ??= await checkCandidate(tx, tenantId, inquiry, controls.settings, now);
    if (reason) return recordSkip(tx, tenantId, payload, reason, now);

    if ((await tx.query("SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND id=$2", [tenantId, payload.replyId])).rowCount)
      throw idInUse("reply");
    await tx.query(
      `INSERT INTO inbox_replies (tenant_id,id,contact_id,channel,subject,body,drafted_by,created_at)
       VALUES ($1,$2,$3,'email',$4,$5,$6,$7)`,
      [tenantId, payload.replyId, payload.contactId, payload.subject, payload.body, binding.actorId, now],
    );
    const summary = `Send the follow-up "${payload.subject}"`.slice(0, 500);
    await tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at)
       VALUES ($1,$2,$3,'inbox_reply',$4,$5,$6,$7,$8,$9)`,
      [tenantId, payload.approvalId, SEND_REPLY_ACTION, payload.replyId, JSON.stringify({ replyId: payload.replyId }), summary,
        binding.actorId, now, new Date(now.getTime() + APPROVAL_DEFAULT_MINUTES * 60_000)],
    );
    await tx.query(
      `INSERT INTO agent_followups (tenant_id, id, run_id, intake_item_id, contact_id, outcome, reply_id, approval_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'drafted',$6,$7,$8)`,
      [tenantId, payload.followupId, payload.runId, payload.intakeItemId, payload.contactId, payload.replyId, payload.approvalId, now],
    );
    const decision = (await loadDecision(tx, tenantId, payload.followupId))!;
    return {
      result: decision,
      event: {
        type: "agent.followup.drafted",
        payload: { runId: payload.runId, followupId: payload.followupId, replyId: payload.replyId, approvalId: payload.approvalId },
      },
    };
  },
};

export const agentHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [UPDATE_SETTINGS_ACTION]: updateSettingsHandler,
  [KILL_ACTION]: killHandler,
  [RESUME_ACTION]: resumeHandler,
  [START_RUN_ACTION]: startRunHandler,
  [FINISH_RUN_ACTION]: finishRunHandler,
  [SKIP_ACTION]: skipHandler,
  [DRAFT_ACTION]: draftHandler,
});

