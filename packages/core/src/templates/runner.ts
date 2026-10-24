// Run loop of the templated kinds (agents.md G-19, G-20). Original code. It calls no model. Each
// step is its own dispatcher action, so a run that stops halfway keeps what committed and a retry
// with the same key continues it. The queue action re-checks every rule under its locks; the
// plan here only decides which action to call and spares work.
import {
  Conflict,
  KIND_RUN_FINISH_ACTION,
  KIND_RUN_START_ACTION,
  KIND_SKIP_ACTION,
  QUEUE_ACTIONS,
  kindDecisionOutputSchema,
  kindRunOutputSchema,
  type ActionCommand,
  type ActionResult,
  type TemplatedKind,
  type TemplatedSkipReason,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { loadControls } from "../agents/controls.js";
import { followUpRunId } from "../agents/runner.js";
import { parseOrFail } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import {
  STOP_REASONS,
  computeKindValues,
  findKindCandidates,
  kindDecisionId,
  loadBookingFact,
  loadKindDecision,
  loadKindRunDetail,
  queueMessageId,
  templatedSettings,
  type BookingFact,
  type BookingLinkProvider,
  type KindRunDetail,
} from "./send.js";
import { currentRevision, usableStandingApproval } from "./store.js";

export interface TemplatedRunDeps {
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  /** G-7: at most this many bookings per run. */
  readonly maxCandidatesPerRun: number;
  /** The tenant's booking-page link for `{booking_link}`, or null when it has none. */
  readonly bookingLink?: BookingLinkProvider;
  readonly report?: (event: { tenantId: string; runId: string; bookingId: string; error: unknown }) => void;
  /** Dispatches one command as the kind's principal (G-1). */
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}

/** The run ID derives from the caller's key, as for the follow-up kind (G-6). */
export const kindRunId = followUpRunId;

export async function runTemplatedKind(
  deps: TemplatedRunDeps, tenantId: string,
  input: { readonly kind: TemplatedKind; readonly key: string; readonly requestedBy: string | null },
): Promise<KindRunDetail> {
  const { kind } = input;
  const runId = kindRunId(tenantId, input.key);
  const read = <T>(work: (tx: Transaction) => Promise<T>) => deps.db.tenant(tenantId, work);
  const now = () => new Date(deps.clock.now().getTime());
  const command = (actionType: string, key: string, type: "agent_run" | "agent_decision", id: string, payload: Record<string, unknown>): ActionCommand => ({
    actionType, idempotencyKey: key, payload: payload as ActionCommand["payload"],
    target: { tenantId, type, id },
    approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
  });
  const detail = async () => (await read((tx) => loadKindRunDetail(tx, tenantId, runId, kind)))!;

  const existing = await read((tx) => loadKindRunDetail(tx, tenantId, runId, kind));
  if (!existing) {
    parseOrFail(kindRunOutputSchema, await deps.dispatch(command(KIND_RUN_START_ACTION, `agent:start:${runId}`, "agent_run", runId,
      { runId, agentKind: kind, requestedBy: input.requestedBy, maxDecisions: deps.maxCandidatesPerRun })));
  }
  const started = existing ?? (await detail());
  if (started.status !== "running") return started;
  const maxDecisions = (await read((tx) => tx.query<{ max_decisions: number }>(
    "SELECT max_decisions FROM agent_runs WHERE tenant_id=$1 AND id=$2", [tenantId, runId]))).rows[0]!.max_decisions;

  // A resumed run keeps its decisions: a stop it already met still stands.
  let stop: TemplatedSkipReason | null =
    (started.decisions.map((d) => d.reason).find((reason) => reason !== null && STOP_REASONS.has(reason)) ?? null) as TemplatedSkipReason | null;
  let failure: { error: unknown } | null = null;

  const plan = stop ? null : await read(async (tx) => {
    const controls = await loadControls(tx, tenantId, false, kind);
    const settings = templatedSettings(controls);
    const revision = await currentRevision(tx, tenantId, kind);
    const approvalId = revision ? await usableStandingApproval(tx, tenantId, revision, now()) : null;
    const window = { timingHours: revision?.timing_hours ?? settings.timingHours, lookbackDays: settings.lookbackDays };
    const candidates = await findKindCandidates(tx, tenantId, kind, window, now(), maxDecisions - started.decisions.length, runId);
    return { settings, revision, approvalId, candidates };
  });

  for (const candidate of plan?.candidates ?? []) {
    const decisionId = kindDecisionId(tenantId, runId, candidate.bookingId);
    const key = `agent:item:${runId}:${candidate.bookingId}`;
    const ref = { decisionId, runId, agentKind: kind, bookingId: candidate.bookingId, contactId: candidate.contactId };
    // Another call resuming the same run may have decided this booking already.
    const decidedElsewhere = async () => {
      const done = await read((tx) => loadKindDecision(tx, tenantId, decisionId));
      return done && { stop: done.reason && STOP_REASONS.has(done.reason) ? (done.reason as TemplatedSkipReason) : null };
    };
    const skip = async (reason: TemplatedSkipReason) =>
      parseOrFail(kindDecisionOutputSchema, await deps.dispatch(command(KIND_SKIP_ACTION, `${key}:skip`, "agent_decision", decisionId, { ...ref, reason }))).result;
    try {
      const done = await decidedElsewhere();
      if (done) {
        if (done.stop) { stop = done.stop; break; }
        continue;
      }
      if (!plan!.revision || !plan!.approvalId) { await skip("template_not_approved"); continue; }
      const values = await read(async (tx) => {
        const booking = await loadBookingFact(tx, tenantId, candidate.bookingId);
        if (!booking) return null;
        return (await computeKindValues(tx, tenantId, kind, booking, plan!.settings, (await deps.bookingLink?.(tx, tenantId)) ?? null))?.values ?? null;
      });
      if (!values) continue;
      let decision;
      try {
        decision = parseOrFail(kindDecisionOutputSchema, await deps.dispatch(command(QUEUE_ACTIONS[kind], `${key}:queue`, "agent_decision", decisionId, {
          decisionId, runId, bookingId: candidate.bookingId, contactId: candidate.contactId,
          messageId: queueMessageId(tenantId, decisionId), templateRevisionId: plan!.revision.id, standingApprovalId: plan!.approvalId, values,
        }))).result;
      } catch (error) {
        // The approval was withdrawn or the revision replaced between the plan and the queue: record it (G-19).
        if (error instanceof Conflict && error.details.reason === "template_not_approved") { await skip("template_not_approved"); continue; }
        throw error;
      }
      if (decision.reason && STOP_REASONS.has(decision.reason)) { stop = decision.reason as TemplatedSkipReason; break; }
    } catch (error) {
      if (error instanceof Conflict) {
        const reason = error.details.reason;
        // Another call resuming this run reached its limit or finished it: nothing is left to do.
        if (reason === "run_limit" || reason === "run_closed") break;
        // The booking changed under the plan, or was queued by another run: it is not ours to decide now.
        if (reason === "not_a_candidate" || reason === "already_queued" || reason === "values_changed") continue;
        const done = reason === "id_in_use" ? await decidedElsewhere().catch(() => null) : null;
        if (done) {
          if (done.stop) { stop = done.stop; break; }
          continue;
        }
      }
      deps.report?.({ tenantId, runId, bookingId: candidate.bookingId, error });
      failure ??= { error };
    }
  }
  // G-6: a booking left without a decision keeps the run open, so a retry with the same key
  // continues it. A stop ends the run either way.
  if (failure && !stop) throw failure.error;
  parseOrFail(kindRunOutputSchema,
    await deps.dispatch(command(KIND_RUN_FINISH_ACTION, `agent:finish:${runId}`, "agent_run", runId, { runId, agentKind: kind, stopReason: stop })));
  return detail();
}

export type { BookingFact };
