// M6 run loop (agents.md G-6..G-9). Original code. Each step is its own dispatcher action, so a
// run that stops halfway keeps what committed and a retry with the same key continues it. The
// model is called outside any transaction, and only for inquiries that passed the checks.
import {
  Conflict,
  followUpDraftSchema,
  followUpDecisionOutputSchema,
  followUpRunOutputSchema,
  isStopReason,
  type ActionCommand,
  type ActionResult,
  type FollowUpRunDetail,
  type FollowUpSkipReason,
  type FollowUpStopReason,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { buildPrompt, checkCandidate, findCandidates, type Candidate } from "./candidates.js";
import { draftsToday, gate, loadControls, readGlobalKilled } from "./controls.js";
import { DRAFT_ACTION, FINISH_RUN_ACTION, SKIP_ACTION, START_RUN_ACTION } from "./handlers.js";
import type { FollowUpModel } from "./model.js";
import { getRun, loadDecision } from "./records.js";

export interface FollowUpRunConfig {
  /** G-7: at most this many inquiries per run. */
  readonly maxCandidatesPerRun: number;
}
/** Something the run could not finish for one inquiry; the run goes on with the next one. */
export interface FollowUpRunReport {
  readonly tenantId: string;
  readonly runId: string;
  readonly intakeItemId: string;
  readonly error: unknown;
}
export interface FollowUpRunDeps {
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly model: FollowUpModel;
  readonly config: FollowUpRunConfig;
  readonly report?: (event: FollowUpRunReport) => void;
  /** Dispatches one command as the tenant's agent principal (G-1). */
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}

/** G-6: the run's ID and every step's key derive from the caller's key. */
export const followUpRunId = (tenantId: string, key: string) => derivedId(tenantId, key, "agent-run");
const stepIds = (tenantId: string, key: string) => ({
  followupId: derivedId(tenantId, key, "agent-followup"),
  replyId: derivedId(tenantId, key, "inbox_reply"),
  approvalId: derivedId(tenantId, key, "approval-record"),
});

export async function runFollowUps(
  deps: FollowUpRunDeps, tenantId: string, input: { readonly key: string; readonly requestedBy: string | null },
): Promise<FollowUpRunDetail> {
  const runId = followUpRunId(tenantId, input.key);
  const read = <T>(work: (tx: Transaction) => Promise<T>) => deps.db.tenant(tenantId, work);
  const now = () => new Date(deps.clock.now().getTime());
  const command = (actionType: string, key: string, type: "agent_run" | "agent_followup", id: string, payload: ActionCommand["payload"]) => ({
    actionType, idempotencyKey: key, payload,
    target: { tenantId, type, id },
    approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
  });
  const decide = async (actionType: string, key: string, payload: Record<string, unknown> & { followupId: string }) =>
    parseOrFail(followUpDecisionOutputSchema,
      await deps.dispatch(command(actionType, key, "agent_followup", payload.followupId, payload as ActionCommand["payload"]))).result;

  // A resumed run keeps the limit it started with, so it starts only when it does not exist yet.
  let state = await read((tx) => runState(tx, tenantId, runId));
  if (!state) {
    parseOrFail(followUpRunOutputSchema, await deps.dispatch(command(START_RUN_ACTION, `agent:start:${runId}`, "agent_run", runId,
      { runId, requestedBy: input.requestedBy, maxDecisions: deps.config.maxCandidatesPerRun })));
    state = (await read((tx) => runState(tx, tenantId, runId)))!;
  }
  const { run: started, maxDecisions } = state;
  if (started.status !== "running") return started;

  // A resumed run keeps its decisions: a stop it already met still stands, and it decides at most
  // what is left of its limit (G-7), never asking the model twice for one inquiry. The decision
  // actions hold the limit under the run's lock; this only spares the model calls.
  let stop: FollowUpStopReason | null = started.decisions.map((d) => d.reason)
    .find((reason): reason is FollowUpStopReason => reason !== null && isStopReason(reason)) ?? null;
  let failure: { error: unknown } | null = null;
  const candidates = stop ? [] : await read(async (tx) =>
    findCandidates(tx, tenantId, (await loadControls(tx, tenantId, false)).settings, now(),
      maxDecisions - started.decisions.length, runId));
  for (const candidate of candidates) {
    const key = `agent:item:${runId}:${candidate.intakeItemId}`;
    const ids = stepIds(tenantId, key);
    const ref = { followupId: ids.followupId, runId, intakeItemId: candidate.intakeItemId, contactId: candidate.contactId };
    try {
      // Another call resuming the same run may have decided it meanwhile.
      const done = await read((tx) => loadDecision(tx, tenantId, ids.followupId));
      if (done) {
        if (done.reason && isStopReason(done.reason)) { stop = done.reason; break; }
        continue;
      }
      const checked = await read((tx) => precheck(tx, tenantId, candidate, now()));
      if (checked.stop) { stop = checked.stop; break; }
      if (checked.skip) { await decide(SKIP_ACTION, `${key}:skip`, { ...ref, reason: checked.skip }); continue; }

      const drafted = await askModel(deps.model, await read((tx) => buildPrompt(tx, tenantId, candidate)));
      if (typeof drafted === "string") { await decide(SKIP_ACTION, `${key}:skip`, { ...ref, reason: drafted }); continue; }
      const decision = await decide(DRAFT_ACTION, `${key}:draft`, {
        ...ref, replyId: ids.replyId, approvalId: ids.approvalId, subject: drafted.subject, body: drafted.body,
      });
      if (decision.reason && isStopReason(decision.reason)) { stop = decision.reason; break; }
    } catch (error) {
      // Another call resuming this run reached its limit or finished it: nothing is left to do.
      if (error instanceof Conflict && (error.details.reason === "run_limit" || error.details.reason === "run_finished")) break;
      deps.report?.({ tenantId, runId, intakeItemId: candidate.intakeItemId, error });
      failure ??= { error };
    }
  }
  // G-6: an inquiry left without a decision keeps the run open, so a retry with the same key
  // (or the next scheduled call in the slot) continues it. A stop ends the run either way.
  if (failure && !stop) throw failure.error;
  parseOrFail(followUpRunOutputSchema,
    await deps.dispatch(command(FINISH_RUN_ACTION, `agent:finish:${runId}`, "agent_run", runId, { runId, stopReason: stop })));
  return (await read((tx) => getRun(tx, tenantId, runId)))!;
}

async function runState(tx: Transaction, tenantId: string, runId: string) {
  const run = await getRun(tx, tenantId, runId);
  if (!run) return null;
  const { max_decisions: maxDecisions } = (await tx.query<{ max_decisions: number }>(
    "SELECT max_decisions FROM agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId])).rows[0]!;
  return { run, maxDecisions };
}

/** The same checks as the draft action, without its locks, before any model call (G-8). */
async function precheck(tx: Transaction, tenantId: string, candidate: Candidate, now: Date) {
  const controls = await loadControls(tx, tenantId, false);
  let stop = gate(controls, await readGlobalKilled(tx, false), now);
  if (!stop && (await draftsToday(tx, tenantId, now)) >= controls.settings.maxDraftsPerDay) stop = "daily_cap";
  if (stop) return { stop, skip: null };
  return { stop: null, skip: await checkCandidate(tx, tenantId, candidate, controls.settings, now) };
}

/** G-8, G-9: the model's draft, trimmed and validated, or the reason there is none. */
async function askModel(model: FollowUpModel, prompt: Parameters<FollowUpModel["draft"]>[0]):
  Promise<{ subject: string; body: string } | Extract<FollowUpSkipReason, "model_error" | "model_invalid">> {
  let answer: unknown;
  try { answer = await model.draft(prompt); }
  catch { return "model_error"; }
  const parsed = followUpDraftSchema.safeParse(answer);
  return parsed.success ? parsed.data : "model_invalid";
}
