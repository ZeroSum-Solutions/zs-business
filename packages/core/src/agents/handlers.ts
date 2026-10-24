// M6 agent actions (agents.md G-2, G-3, G-6, G-14..G-16). Original code. Each runs through the
// shared dispatcher: the settings actions as a member, the run and decision actions as the
// tenant's agent principal for the kind (G-1, G-14). Nothing here approves or sends; a draft
// hands its send to an owner.
import {
  APPROVAL_DEFAULT_MINUTES,
  Conflict,
  KIND_RUN_FINISH_ACTION,
  KIND_RUN_START_ACTION,
  KIND_SKIP_ACTION,
  REMINDER_QUEUE_ACTION,
  REVIEW_QUEUE_ACTION,
  TEMPLATE_REVISION_CREATE_ACTION,
  TEMPLATE_STANDING_GRANT_ACTION,
  agentKindConfigSchemas,
  costWarnCommandSchema,
  draftFollowUpCommandSchema,
  finishFollowUpRunCommandSchema,
  killAgentKindCommandSchema,
  killFollowUpCommandSchema,
  parseAgentKindConfig,
  resumeAgentKindCommandSchema,
  resumeFollowUpCommandSchema,
  skipFollowUpCommandSchema,
  stallRunCommandSchema,
  startFollowUpRunCommandSchema,
  TenantDenied,
  updateAgentKindSettingsCommandSchema,
  updateFollowUpSettingsCommandSchema,
  ValidationFailed,
  DEFAULT_MAX_COST_MICROS_PER_DAY,
  type AgentKind,
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
  agentKindStatus,
  draftsToday,
  followUpStatus,
  gate,
  loadControls,
  readGlobalKilled,
  type AgentControls,
} from "./controls.js";
import { costSpent } from "./cost.js";
import { loadDecision, loadRun } from "./records.js";

export const UPDATE_SETTINGS_ACTION = "agent.settings.update";
export const KILL_ACTION = "agent.kill";
export const RESUME_ACTION = "agent.resume";
/** G-14: settings, kill and resume for the kinds besides inquiry_followup. */
export const UPDATE_KIND_SETTINGS_ACTION = "agent.kind.settings.update";
export const KILL_KIND_ACTION = "agent.kind.kill";
export const RESUME_KIND_ACTION = "agent.kind.resume";
export const START_RUN_ACTION = "agent.run.start";
export const FINISH_RUN_ACTION = "agent.run.finish";
export const SKIP_ACTION = "agent.followup.skip";
export const DRAFT_ACTION = "agent.followup.draft";
/** G-16: the scheduler closes a run that stayed `running` too long. */
export const STALL_RUN_ACTION = "agent.run.stall";
/** G-15: the 80% warning. */
export const COST_WARN_ACTION = "agent.cost.warn";

/** G-14: the actions every kind's principal may run, each only for its own kind (the payload names it). */
export const AGENT_COMMON_ACTIONS: readonly string[] = Object.freeze([STALL_RUN_ACTION, COST_WARN_ACTION]);
/**
 * G-1, G-14: the actions each kind's principal may run besides the common ones. A kind built
 * later adds its own here; until then it runs nothing of its own.
 */
export const AGENT_KIND_ACTIONS: Readonly<Record<AgentKind, readonly string[]>> = Object.freeze({
  inquiry_followup: Object.freeze([START_RUN_ACTION, FINISH_RUN_ACTION, SKIP_ACTION, DRAFT_ACTION]),
  // G-19, G-20: the templated kinds run their own run, skip and queue actions.
  appointment_reminder: Object.freeze([REMINDER_QUEUE_ACTION, KIND_RUN_START_ACTION, KIND_RUN_FINISH_ACTION, KIND_SKIP_ACTION]),
  review_request: Object.freeze([REVIEW_QUEUE_ACTION, KIND_RUN_START_ACTION, KIND_RUN_FINISH_ACTION, KIND_SKIP_ACTION]),
  document_intake: Object.freeze([]),
  voice_receptionist: Object.freeze([]),
});
/** Every action any agent principal may run; a member session may run none of them. */
export const AGENT_ACTIONS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(AGENT_KIND_ACTIONS).flat(), ...AGENT_COMMON_ACTIONS]),
]);
/** G-2, G-3, G-14: the member actions and the permission each needs. */
export const AGENT_MEMBER_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  [UPDATE_SETTINGS_ACTION]: "agents",
  [KILL_ACTION]: "inbox.drafts",
  [RESUME_ACTION]: "agents",
  [UPDATE_KIND_SETTINGS_ACTION]: "agents",
  [KILL_KIND_ACTION]: "inbox.drafts",
  [RESUME_KIND_ACTION]: "agents",
  // G-19, A-15: a template revision is written by a member; its standing grant runs under an owner's approval.
  [TEMPLATE_REVISION_CREATE_ACTION]: "agents",
  [TEMPLATE_STANDING_GRANT_ACTION]: "agents",
});

/** The settings target is the tenant itself: one target per tenant, a settings row per kind. */
async function resolveSettings(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_settings") throw new ValidationFailed("Agent settings actions require an agent_settings target");
  if (target.id !== target.tenantId || !(await tenantVisible(tx, target.tenantId))) return null;
  return { tenantId: target.tenantId, type: "agent_settings", id: target.id };
}

/** Insert the defaults when the kind has no row yet, so a kill always has a row to engage. */
async function ensureRow(tx: Transaction, tenantId: string, kind: AgentKind, now: Date): Promise<AgentControls> {
  await tx.query(
    "INSERT INTO agent_settings (tenant_id, agent_kind, config, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, agent_kind) DO NOTHING",
    [tenantId, kind, JSON.stringify(agentKindConfigSchemas[kind].parse({})), now],
  );
  return loadControls(tx, tenantId, true, kind);
}

async function killKind(tx: Transaction, tenantId: string, actorId: string, kind: AgentKind, note: string | null, now: Date) {
  const current = await ensureRow(tx, tenantId, kind, now);
  if (!current.killed)
    await tx.query("UPDATE agent_settings SET killed_at=$3, killed_by=$4, kill_note=$5 WHERE tenant_id=$1 AND agent_kind=$2",
      [tenantId, kind, now, actorId, note]);
}

async function resumeKind(tx: Transaction, tenantId: string, kind: AgentKind) {
  const current = await loadControls(tx, tenantId, true, kind);
  if (current.killed)
    await tx.query("UPDATE agent_settings SET killed_at=NULL, killed_by=NULL, kill_note=NULL WHERE tenant_id=$1 AND agent_kind=$2",
      [tenantId, kind]);
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
           lookback_days, quiet_start_minute, quiet_end_minute, time_zone, updated_by, updated_at, tenant_id, revision,
           agent_kind, max_cost_micros_per_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,'inquiry_followup',$13) ON CONFLICT (tenant_id, agent_kind) DO NOTHING`,
        [...values, binding.tenantId, payload.maxCostMicrosPerDay ?? DEFAULT_MAX_COST_MICROS_PER_DAY],
      );
      if (inserted.rowCount === 0)
        throw new Conflict("The agent settings changed", {
          reason: "stale_revision", currentRevision: (await loadControls(tx, binding.tenantId, false)).revision,
        });
    } else {
      await tx.query(
        `UPDATE agent_settings SET enabled=$1, max_drafts_per_day=$2, max_drafts_per_contact=$3, contact_window_hours=$4,
           wait_hours=$5, lookback_days=$6, quiet_start_minute=$7, quiet_end_minute=$8, time_zone=$9, updated_by=$10,
           updated_at=$11, revision=revision+1, max_cost_micros_per_day=coalesce($13::integer, max_cost_micros_per_day)
         WHERE tenant_id=$12 AND agent_kind='inquiry_followup'`,
        [...values, binding.tenantId, payload.maxCostMicrosPerDay ?? null],
      );
    }
    return { result: await followUpStatus(tx, binding.tenantId, now) };
  },
};

/** G-3: engage the tenant's switch. A switch already engaged keeps its first time and note. */
export const killHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "inbox.drafts");
    const { payload } = parseOrFail(killFollowUpCommandSchema, command);
    await killKind(tx, binding.tenantId, binding.actorId, "inquiry_followup", payload.note ?? null, now);
    return { result: await followUpStatus(tx, binding.tenantId, now) };
  },
};

/** G-3: release the tenant's switch; owners only. */
export const resumeHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    parseOrFail(resumeFollowUpCommandSchema, command);
    await resumeKind(tx, binding.tenantId, "inquiry_followup");
    return { result: await followUpStatus(tx, binding.tenantId, now) };
  },
};

/** G-14: `inquiry_followup` has its own routes and columns; the generic actions serve the other kinds. */
function requireOtherKind(kind: AgentKind): void {
  if (kind === "inquiry_followup") throw new ValidationFailed("inquiry_followup settings use the follow-up routes");
}

/** G-14: replace one kind's settings; the kind's config is checked against its own schema. */
export const updateKindSettingsHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(updateAgentKindSettingsCommandSchema, command);
    const kind = payload.agentKind;
    requireOtherKind(kind);
    const config = parseAgentKindConfig(kind, payload.config);
    // G-21: a kind with no built path cannot be turned on. G-20: review requests need a review link.
    if (payload.enabled && kind === "document_intake")
      throw new Conflict("This agent kind is not available yet", { reason: "kind_not_available" });
    if (payload.enabled && kind === "review_request" && !(config as { reviewUrl?: string }).reviewUrl)
      throw new ValidationFailed("Review requests need a review link before they can be turned on");
    const current = await loadControls(tx, binding.tenantId, true, kind);
    if (current.revision !== payload.expectedRevision)
      throw new Conflict("The agent settings changed", { reason: "stale_revision", currentRevision: current.revision });
    const values = [payload.enabled, payload.quietStartMinute, payload.quietEndMinute, payload.timeZone,
      payload.maxCostMicrosPerDay, JSON.stringify(config), binding.actorId, now];
    if (current.revision === 0) {
      const inserted = await tx.query(
        `INSERT INTO agent_settings (enabled, quiet_start_minute, quiet_end_minute, time_zone, max_cost_micros_per_day, config,
           updated_by, updated_at, tenant_id, agent_kind, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1) ON CONFLICT (tenant_id, agent_kind) DO NOTHING`,
        [...values, binding.tenantId, kind],
      );
      if (inserted.rowCount === 0)
        throw new Conflict("The agent settings changed", {
          reason: "stale_revision", currentRevision: (await loadControls(tx, binding.tenantId, false, kind)).revision,
        });
    } else {
      await tx.query(
        `UPDATE agent_settings SET enabled=$1, quiet_start_minute=$2, quiet_end_minute=$3, time_zone=$4,
           max_cost_micros_per_day=$5, config=$6, updated_by=$7, updated_at=$8, revision=revision+1
         WHERE tenant_id=$9 AND agent_kind=$10`,
        [...values, binding.tenantId, kind],
      );
    }
    return { result: await agentKindStatus(tx, binding.tenantId, kind, now) };
  },
};

export const killKindHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "inbox.drafts");
    const { payload } = parseOrFail(killAgentKindCommandSchema, command);
    requireOtherKind(payload.agentKind);
    await killKind(tx, binding.tenantId, binding.actorId, payload.agentKind, payload.note ?? null, now);
    return { result: await agentKindStatus(tx, binding.tenantId, payload.agentKind, now) };
  },
};

export const resumeKindHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "agents");
    const { payload } = parseOrFail(resumeAgentKindCommandSchema, command);
    requireOtherKind(payload.agentKind);
    await resumeKind(tx, binding.tenantId, payload.agentKind);
    return { result: await agentKindStatus(tx, binding.tenantId, payload.agentKind, now) };
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
    // G-15: a kind that has spent its day's cap starts no run that would call a model.
    if (!stop && (await costSpent(tx, tenantId, "inquiry_followup", now)) >= controls.maxCostMicrosPerDay) stop = "cost_cap";
    await tx.query(
      `INSERT INTO agent_runs (tenant_id, id, requested_by, started_at, finished_at, status, stop_reason, max_decisions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, payload.runId, payload.requestedBy, now, stop ? now : null, stop ? "stopped" : "running", stop, payload.maxDecisions],
    );
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

/**
 * Close a running run (G-10, G-15, G-16): its counts come from the decisions that committed and
 * its usage from the model calls that were recorded for it. The run's row is locked by the caller.
 */
export async function closeRun(
  tx: Transaction, tenantId: string, runId: string, kind: AgentKind, now: Date, stopReason: FollowUpStopReason | null,
): Promise<void> {
  const counts = kind === "inquiry_followup"
    ? `SELECT count(*)::int AS considered,
              (count(*) FILTER (WHERE outcome='drafted'))::int AS drafted,
              (count(*) FILTER (WHERE outcome='skipped'))::int AS skipped
         FROM agent_followups WHERE tenant_id=$1 AND run_id=$2`
    : `SELECT count(*)::int AS considered,
              (count(*) FILTER (WHERE outcome<>'skipped'))::int AS drafted,
              (count(*) FILTER (WHERE outcome='skipped'))::int AS skipped
         FROM agent_decisions WHERE tenant_id=$1 AND run_id=$2`;
  await tx.query(
    `UPDATE agent_runs r SET finished_at=$3, status=$4, stop_reason=$5,
       considered=c.considered, drafted=c.drafted, skipped=c.skipped,
       model=u.model, input_tokens=u.input_tokens, output_tokens=u.output_tokens, cost_micros=u.cost_micros
       FROM (${counts}) c,
            (SELECT min(model) AS model, coalesce(sum(input_tokens), 0)::int AS input_tokens,
                    coalesce(sum(output_tokens), 0)::int AS output_tokens, coalesce(sum(cost_micros), 0)::bigint AS cost_micros
               FROM agent_model_calls WHERE tenant_id=$1 AND run_id=$2) u
      WHERE r.tenant_id=$1 AND r.id=$2`,
    [tenantId, runId, now, stopReason ? "stopped" : "completed", stopReason],
  );
}

/** Close a run with counts from its decisions. A closed run stays as it is. */
export const finishRunHandler: ActionHandler = {
  resolveTarget: resolveRun,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(finishFollowUpRunCommandSchema, command);
    const tenantId = binding.tenantId;
    const run = (await loadRun(tx, tenantId, payload.runId, true))!;
    if (run.agent !== "inquiry_followup") throw new TenantDenied();
    if (run.status === "running") await closeRun(tx, tenantId, payload.runId, run.agent, now, payload.stopReason);
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

/**
 * G-16: close a run that stayed `running` too long: `stopped`, stop reason `stalled`, counts from
 * the decisions that committed. A run that is already closed stays as it is, so a retry with the
 * same key (or a run that finished first) returns the closed run. The run's row is locked, so a
 * decision racing the stall either commits first and counts, or finds the run closed (`run_closed`).
 */
export const stallRunHandler: ActionHandler = {
  resolveTarget: resolveRun,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(stallRunCommandSchema, command);
    const tenantId = binding.tenantId;
    const run = (await loadRun(tx, tenantId, payload.runId, true))!;
    if (run.agent !== payload.agentKind) throw new TenantDenied();
    if (run.status === "running") await closeRun(tx, tenantId, payload.runId, run.agent, now, "stalled");
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

/**
 * G-15: record that a kind's model cost reached 80% of its cap. The key carries the local date,
 * so one warning commits per date; the figures in the event are read here, not taken from the caller.
 */
export const costWarnHandler: ActionHandler = {
  resolveTarget: resolveSettings,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(costWarnCommandSchema, command);
    const tenantId = binding.tenantId;
    const controls = await loadControls(tx, tenantId, false, payload.agentKind);
    const result = {
      agentKind: payload.agentKind,
      localDate: payload.localDate,
      spentMicros: await costSpent(tx, tenantId, payload.agentKind, now),
      capMicros: controls.maxCostMicrosPerDay,
    };
    return { result, event: { type: "agent.cost_warning", payload: result } };
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
 * resume one run concurrently cannot together decide more than its limit, and a run that a stall
 * closed (G-16) refuses a late step.
 */
async function requireOpenRunAndInquiry(tx: Transaction, tenantId: string, input: { runId: string; intakeItemId: string; contactId: string }) {
  const inquiry = await loadInquiry(tx, tenantId, input.intakeItemId, input.contactId);
  const run = (await tx.query<{ status: string; max_decisions: number; agent: string }>(
    "SELECT status, max_decisions, agent FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, input.runId],
  )).rows[0];
  if (!inquiry || !run || run.agent !== "inquiry_followup") throw new TenantDenied();
  if (run.status !== "running") throw new Conflict("The run is closed", { reason: "run_closed" });
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
  [UPDATE_KIND_SETTINGS_ACTION]: updateKindSettingsHandler,
  [KILL_KIND_ACTION]: killKindHandler,
  [RESUME_KIND_ACTION]: resumeKindHandler,
  [START_RUN_ACTION]: startRunHandler,
  [FINISH_RUN_ACTION]: finishRunHandler,
  [STALL_RUN_ACTION]: stallRunHandler,
  [COST_WARN_ACTION]: costWarnHandler,
  [SKIP_ACTION]: skipHandler,
  [DRAFT_ACTION]: draftHandler,
});
