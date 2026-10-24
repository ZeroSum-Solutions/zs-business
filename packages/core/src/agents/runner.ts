// M6 run loop (agents.md G-6..G-9). Original code. Each step is its own dispatcher action, so a
// run that stops halfway keeps what committed and a retry with the same key continues it. The
// model is called outside any transaction, and only for inquiries that passed the checks.
import {
  Conflict,
  followUpDraftSchema,
  type AgentKind,
  followUpDecisionOutputSchema,
  followUpRunOutputSchema,
  isStopReason,
  type ActionCommand,
  type ActionResult,
  type FollowUpRunDetail,
  type FollowUpSkipReason,
  type FollowUpStopReason,
  type FollowUpSwitchReason,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { isoDate, DAY_MS, offsetAt } from "../booking/time-zone.js";
import { buildPrompt, checkCandidate, findCandidates, type Candidate } from "./candidates.js";
import { draftsToday, gate, loadControls, readGlobalKilled } from "./controls.js";
import { atWarningLine, FAKE_MODEL_PRICES, priceFor, priceUsage, reserveModelCall, settleModelCall, worstCase, type ModelPrices } from "./cost.js";
import { COST_WARN_ACTION, DRAFT_ACTION, FINISH_RUN_ACTION, SKIP_ACTION, START_RUN_ACTION } from "./handlers.js";
import { abortable, type FollowUpModel, type TextModelResult } from "./model.js";
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
/** The timers a run uses for its model deadline and kill checks; tests inject their own. */
export interface RunTimers {
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const GLOBAL_TIMERS: RunTimers = { setTimeout: (work, ms) => setTimeout(work, ms), clearTimeout: (handle) => clearTimeout(handle as never) };
/** G-17: how long one model call may take when the caller sets no limit. */
export const DEFAULT_MODEL_TIMEOUT_MS = 5_000;

/** Aborts a model call that outlasted its deadline; the run records `model_error`. */
export class ModelTimedOut extends Error {
  constructor(ms: number) {
    super(`Model gave no draft within ${ms} ms`);
    this.name = "ModelTimedOut";
  }
}

const KIND: AgentKind = "inquiry_followup";

export interface FollowUpRunDeps {
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly model: FollowUpModel;
  readonly config: FollowUpRunConfig;
  readonly report?: (event: FollowUpRunReport) => void;
  /** G-15: the price table, keyed by model ID. The model's own ID must be in it. */
  readonly modelPrices?: ModelPrices;
  /** G-17: abort a model call after this long. */
  readonly modelTimeoutMs?: number;
  readonly timers?: RunTimers;
  /** While a model call is out, check the switches this often and abort it once the agent is stopped. Off when unset. */
  readonly killPollMs?: number;
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
  const prices = deps.modelPrices ?? FAKE_MODEL_PRICES;
  const timers = deps.timers ?? GLOBAL_TIMERS;
  const timeoutMs = deps.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  priceFor(prices, deps.model.model); // G-15: a model with no price runs nothing
  const command = (actionType: string, key: string, type: "agent_run" | "agent_followup" | "agent_settings", id: string, payload: ActionCommand["payload"]) => ({
    actionType, idempotencyKey: key, payload,
    target: { tenantId, type, id },
    approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
  });
  const decide = async (actionType: string, key: string, payload: Record<string, unknown> & { followupId: string }) =>
    parseOrFail(followUpDecisionOutputSchema,
      await deps.dispatch(command(actionType, key, "agent_followup", payload.followupId, payload as ActionCommand["payload"]))).result;

  // G-15: the call that takes the day's cost to 80% records one warning per local date in the tenant's zone.
  const warnCost = async (at: Date) => {
    try {
      const zone = (await read((tx) => loadControls(tx, tenantId, false))).settings.timeZone;
      const localDate = isoDate(Math.floor((at.getTime() + offsetAt(zone, at.getTime())) / DAY_MS));
      await deps.dispatch(command(COST_WARN_ACTION, `agent:${KIND}:cost-warn:${localDate}`, "agent_settings", tenantId, { agentKind: KIND, localDate }));
    } catch (error) {
      // The warning is a notice; a failure to record it must not stop the run.
      deps.report?.({ tenantId, runId, intakeItemId: "", error });
    }
  };

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
    .find((reason): reason is FollowUpSwitchReason => reason !== null && isStopReason(reason)) ?? null;
  let failure: { error: unknown } | null = null;
  const candidates = stop ? [] : await read(async (tx) =>
    findCandidates(tx, tenantId, (await loadControls(tx, tenantId, false)).settings, now(),
      maxDecisions - started.decisions.length, runId));
  for (const candidate of candidates) {
    const key = `agent:item:${runId}:${candidate.intakeItemId}`;
    const ids = stepIds(tenantId, key);
    const ref = { followupId: ids.followupId, runId, intakeItemId: candidate.intakeItemId, contactId: candidate.contactId };
    // Another call resuming the same run may have decided this inquiry already.
    const decidedElsewhere = async () => {
      const done = await read((tx) => loadDecision(tx, tenantId, ids.followupId));
      return done && { stop: done.reason && isStopReason(done.reason) ? done.reason : null };
    };
    try {
      const done = await decidedElsewhere();
      if (done) {
        if (done.stop) { stop = done.stop; break; }
        continue;
      }
      const checked = await read((tx) => precheck(tx, tenantId, candidate, now()));
      if (checked.stop) { stop = checked.stop; break; }
      if (checked.skip) { await decide(SKIP_ACTION, `${key}:skip`, { ...ref, reason: checked.skip }); continue; }

      const prompt = await read((tx) => buildPrompt(tx, tenantId, candidate));
      const request = deps.model.request(prompt);
      const worst = worstCase(prices, deps.model.model, request);
      const callKeyBase = `agent:${KIND}:model:${runId}:${candidate.intakeItemId}`;
      // G-15: reserve the call's worst case under the cap before it goes out; no room, no call.
      const reservation = await read((tx) => reserveModelCall(tx, tenantId, {
        callKeyBase, runId, kind: KIND,
        subjectId: candidate.intakeItemId, lane: deps.model.lane, model: deps.model.model,
      }, worst, now()));
      if (reservation.status === "cost_cap") { stop = "cost_cap"; break; }
      // Another call (or a crashed one) holds this step's model call: leave the run open, as a failure does.
      if (reservation.status === "exists") throw new Error("A model call for this inquiry is already out");
      if (atWarningLine(reservation.spentAfter, reservation.capMicros)) await warnCost(now());
      const answer = await askModel(deps, prompt, timers, timeoutMs, tenantId, read);
      await read((tx) => settleModelCall(tx, tenantId, reservation.callKey, answer.result
        ? { outcome: answer.draft ? "ok" : "invalid", providerRequestId: answer.result.providerRequestId,
            usage: { ...answer.result.usage, costMicros: priceUsage(prices, deps.model.model, answer.result.usage) } }
        : { outcome: "error" }));
      const drafted = answer.draft ?? answer.reason;
      if (typeof drafted === "string") { await decide(SKIP_ACTION, `${key}:skip`, { ...ref, reason: drafted }); continue; }
      const decision = await decide(DRAFT_ACTION, `${key}:draft`, {
        ...ref, replyId: ids.replyId, approvalId: ids.approvalId, subject: drafted.subject, body: drafted.body,
      });
      if (decision.reason && isStopReason(decision.reason)) { stop = decision.reason; break; }
    } catch (error) {
      if (error instanceof Conflict) {
        // Another call resuming this run reached its limit or finished it: nothing is left to do.
        if (error.details.reason === "run_limit" || error.details.reason === "run_closed") break;
        // Or it decided this inquiry between our check and our decision (a skip and a draft
        // carry different keys but one decision ID).
        const done = error.details.reason === "id_in_use" ? await decidedElsewhere().catch(() => null) : null;
        if (done) {
          if (done.stop) { stop = done.stop; break; }
          continue;
        }
      }
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

interface ModelAnswer {
  readonly draft: { subject: string; body: string } | null;
  readonly reason: Extract<FollowUpSkipReason, "model_error" | "model_invalid">;
  /** The provider's answer, with usage; null when the call failed, timed out or was aborted. */
  readonly result: TextModelResult | null;
}

const validUsage = (result: TextModelResult) =>
  Number.isInteger(result.usage.inputTokens) && result.usage.inputTokens >= 0 &&
  Number.isInteger(result.usage.outputTokens) && result.usage.outputTokens >= 0;

/**
 * G-8, G-9, G-17: the model's draft, trimmed and validated, or the reason there is none. The call
 * gets an abort signal that fires at the deadline, or once a kill or a switch stops the agent.
 */
async function askModel(
  deps: FollowUpRunDeps, prompt: Parameters<FollowUpModel["draft"]>[0], timers: RunTimers, timeoutMs: number,
  tenantId: string, read: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>,
): Promise<ModelAnswer> {
  const controller = new AbortController();
  const deadline = timers.setTimeout(() => controller.abort(new ModelTimedOut(timeoutMs)), timeoutMs);
  let poll: unknown;
  let polling = deps.killPollMs !== undefined;
  const watch = () => {
    poll = timers.setTimeout(() => {
      read(async (tx) => gate(await loadControls(tx, tenantId, false), await readGlobalKilled(tx, false), deps.clock.now()))
        .then((stopped) => { if (stopped) controller.abort(new Error(`Agent stopped: ${stopped}`)); })
        .catch(() => undefined)
        .finally(() => { if (polling && !controller.signal.aborted) watch(); });
    }, deps.killPollMs!);
  };
  if (polling) watch();
  try {
    const result = await abortable(deps.model.draft(prompt, controller.signal), controller.signal);
    if (!validUsage(result)) return { draft: null, reason: "model_error", result: null };
    const parsed = followUpDraftSchema.safeParse(result.output);
    return { draft: parsed.success ? parsed.data : null, reason: "model_invalid", result };
  } catch {
    return { draft: null, reason: "model_error", result: null };
  } finally {
    polling = false;
    timers.clearTimeout(deadline);
    timers.clearTimeout(poll);
  }
}
