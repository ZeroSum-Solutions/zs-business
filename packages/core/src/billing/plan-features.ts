// Plan-page features (plans.md PL-26). Original code. One read answers, for each feature the page may name, the
// facts the runtime decides it by, and `planFeatureSwitch` (contracts) turns them into on or the first reason
// it is off. Nothing here is a second copy of a rule: the agent switches, quiet hours and budget come from
// `agentKindStatus` (the function the Agents page and the runners' gate share), the template approval from
// `usableStandingApproval` (what a scheduled run checks before it queues), the text-back switch from the
// `voice_numbers` row the voice webhook reads, and runner liveness from the runners' own heartbeats.
import {
  PLAN_FEATURE_KINDS,
  planFeatureBlock,
  planFeatureRunners,
  planFeatureSwitch,
  type PlanFeatureBlock,
  type PlanFeatureKind,
  type PlanFeatureSwitch,
  type PlanRunner,
  type TemplatedKind,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { agentKindStatus } from "../agents/controls.js";
import { currentRevision, usableStandingApproval } from "../templates/store.js";

/** What the runtime reads for one feature, before the plan's own state (read-only) is applied. */
export interface PlanFeatureFacts {
  readonly running: boolean;
  readonly blockedBy: PlanFeatureBlock | null;
  readonly approved: boolean;
}

const TEMPLATED_FEATURES: readonly TemplatedKind[] = ["appointment_reminder", "review_request"];
const AGENT_FEATURES = ["inquiry_followup", ...TEMPLATED_FEATURES] as const;

/** The runners whose last beat is still inside the window the runner itself gave it (`runner_heartbeats`). */
export async function freshRunners(tx: Transaction, now: Date): Promise<ReadonlySet<PlanRunner>> {
  const rows = (await tx.query<{ runner: PlanRunner; beat_at: Date; fresh_for_seconds: number }>(
    "SELECT runner, beat_at, fresh_for_seconds FROM runner_heartbeats")).rows;
  // A beat written by a clock ahead of this one is not stale: only an old beat is.
  return new Set(rows.filter((row) => now.getTime() - row.beat_at.getTime() <= row.fresh_for_seconds * 1000).map((row) => row.runner));
}

/**
 * PL-26: for each feature, whether its runners are live, the first agent-control reason it may not act now
 * (support's pause, the tenant's off setting and kill switch, quiet hours, the kind's model budget: G-3, G-5,
 * G-15) and whether a message kind has a template a run may send. Read inside the caller's transaction, which the
 * session opens as one snapshot, so the answer cannot straddle a change.
 */
export async function planFeatureFacts(tx: Transaction, tenantId: string, now: Date): Promise<Record<PlanFeatureKind, PlanFeatureFacts>> {
  const runners = await freshRunners(tx, now);
  const live = (kind: PlanFeatureKind, channel: "email" | "sms" | null) => planFeatureRunners(kind, channel).every((runner) => runners.has(runner));
  const facts = {} as Record<PlanFeatureKind, PlanFeatureFacts>;
  for (const kind of AGENT_FEATURES) {
    const status = await agentKindStatus(tx, tenantId, kind, now);
    const blockedBy = planFeatureBlock(status.blockedBy);
    if (kind === "inquiry_followup") {
      facts[kind] = { running: live(kind, null), blockedBy, approved: true };
      continue;
    }
    // A run queues only from the current revision, under a standing approval that names its digest (G-19, A-15).
    const revision = await currentRevision(tx, tenantId, kind);
    const approved = revision !== null && (await usableStandingApproval(tx, tenantId, revision, now)) !== null;
    facts[kind] = { running: live(kind, revision?.channel ?? null), blockedBy, approved };
  }
  // Missed-call text back is no agent kind: the voice webhook reads the number's own switch, and support's agent
  // pause does not reach it. Its text goes out through the delivery worker's SMS provider.
  const voice = (await tx.query<{ textback_enabled: boolean }>(
    "SELECT textback_enabled FROM voice_numbers WHERE tenant_id=$1", [tenantId])).rows[0];
  facts.missed_call_textback = { running: live("missed_call_textback", null), blockedBy: voice?.textback_enabled ? null : "disabled", approved: true };
  return facts;
}

/** PL-26: every feature's switch from its facts; `readOnly` (PL-8) puts the whole list off, the runtime refusing every run. */
export function planFeatureSwitches(facts: Readonly<Record<PlanFeatureKind, PlanFeatureFacts>>, readOnly: boolean): Record<PlanFeatureKind, PlanFeatureSwitch> {
  return Object.fromEntries(PLAN_FEATURE_KINDS.map((kind) => [kind, planFeatureSwitch({ readOnly, ...facts[kind] })])) as Record<PlanFeatureKind, PlanFeatureSwitch>;
}
