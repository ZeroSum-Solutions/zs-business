// Agent usage and the daily cost cap (agents.md G-15). Original code. Every model call is one
// `agent_model_calls` row. A call is reserved as `started` at its worst-case cost, under the
// kind's settings lock, so concurrent runs count it; after the call it settles to what the
// provider reported. Money is USD millionths ("micros"); no price is ever read from the environment.
import { ValidationFailed, type AgentKind, type AgentLane } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { derivedId } from "../edge/ids.js";
import { FAKE_MODEL_ID, type ModelUsage, type TextModelRequest } from "./model.js";

/** USD millionths per million tokens, so a price stays an integer: 0.35 USD per M tokens is 350000. */
export interface ModelPrice {
  readonly inputMicrosPerMillionTokens: number;
  readonly outputMicrosPerMillionTokens: number;
}
/** The injected price table (`modelPrices`), keyed by the model ID an adapter reports. */
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/** The fakes' price: the same shape as a real lane's, small enough that no test hits a cap by accident. */
export const FAKE_MODEL_PRICES: ModelPrices = Object.freeze({
  [FAKE_MODEL_ID]: Object.freeze({ inputMicrosPerMillionTokens: 350_000, outputMicrosPerMillionTokens: 750_000 }),
});

const COST_WINDOW_MS = 24 * 3_600_000;
/** Tokens never outnumber UTF-8 bytes; the framing a provider adds on top is a fixed allowance. */
const PROMPT_FRAMING_TOKENS = 64;

/** G-15: the price of a call. A model with no price is an error, never a free call. */
export function priceFor(prices: ModelPrices, model: string): ModelPrice {
  const price = prices[model];
  if (!price) throw new ValidationFailed(`The model ${model} has no price in modelPrices`);
  return price;
}

/** G-15: cost in micros, rounded up to a whole micro. */
export function priceUsage(prices: ModelPrices, model: string, usage: ModelUsage): number {
  const price = priceFor(prices, model);
  return Math.ceil(
    (usage.inputTokens * price.inputMicrosPerMillionTokens + usage.outputTokens * price.outputMicrosPerMillionTokens) / 1_000_000,
  );
}

export interface WorstCase extends ModelUsage {
  readonly costMicros: number;
}
/**
 * G-15: the most a request can cost: its input at one token per UTF-8 byte (plus a framing
 * allowance), and `maxOutputTokens` of output, priced.
 */
export function worstCase(prices: ModelPrices, model: string, request: TextModelRequest): WorstCase {
  const bytes = Buffer.byteLength(request.system, "utf8") + Buffer.byteLength(JSON.stringify(request.input) ?? "", "utf8");
  const usage = { inputTokens: bytes + PROMPT_FRAMING_TOKENS, outputTokens: request.maxOutputTokens };
  return { ...usage, costMicros: priceUsage(prices, model, usage) };
}

/** G-15: whether the cost has reached 80% of a cap. A zero cap has no warning line: it refuses every call. */
export const atWarningLine = (spent: number, cap: number) => cap > 0 && spent * 5 >= cap * 4;

/** G-15: the kind's model cost in the 24 hours before now. No upper bound, as for drafts (G-4). */
export async function costSpent(tx: Transaction, tenantId: string, kind: AgentKind, now: Date): Promise<number> {
  return Number((await tx.query<{ micros: string }>(
    `SELECT coalesce(sum(cost_micros), 0)::text AS micros FROM agent_model_calls
      WHERE tenant_id=$1 AND agent_kind=$2 AND created_at > $3`,
    [tenantId, kind, new Date(now.getTime() - COST_WINDOW_MS)],
  )).rows[0]!.micros);
}

export interface ModelCallRef {
  /** The step's key; the attempt number is appended, so a retry after a lost decision is a new, separately priced call. */
  readonly callKeyBase: string;
  readonly runId: string | null;
  readonly kind: AgentKind;
  readonly subjectId: string | null;
  readonly lane: AgentLane;
  readonly model: string;
}
export type Reservation =
  | { readonly status: "reserved"; readonly callKey: string; readonly spentBefore: number; readonly spentAfter: number; readonly capMicros: number }
  | { readonly status: "cost_cap"; readonly spent: number; readonly capMicros: number }
  | { readonly status: "exists" }
  /** G-16: the run was closed (stalled, finished) before this step; nothing is written. */
  | { readonly status: "run_closed" };

/**
 * G-16: share-lock the run's row and say whether it is still running. A close (finish, stall) takes
 * the same row for update, so a model call reserved or settled here either lands before the close
 * counts it, or finds the run closed and writes nothing. Taken after the settings lock, the order the draft decision uses.
 */
async function runIsOpen(tx: Transaction, tenantId: string, runId: string | null): Promise<boolean> {
  if (runId === null) return true;
  const row = (await tx.query<{ status: string }>(
    "SELECT status FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR SHARE", [tenantId, runId])).rows[0];
  return row?.status === "running";
}

/**
 * G-15: under the kind's settings lock, add the 24-hour cost to this call's worst case. Above the
 * cap, nothing is written and the caller must not call the model. Otherwise insert the call as
 * `started` at the worst case. A call for this step that is still out (`started`) means another
 * caller has it: nothing is written, and the caller must not call the model a second time.
 */
export async function reserveModelCall(
  tx: Transaction, tenantId: string, call: ModelCallRef, worst: WorstCase, now: Date,
): Promise<Reservation> {
  const settings = (await tx.query<{ max_cost_micros_per_day: number }>(
    "SELECT max_cost_micros_per_day FROM agent_settings WHERE tenant_id=$1 AND agent_kind=$2 FOR UPDATE", [tenantId, call.kind],
  )).rows[0];
  // The run's row second, as the draft decision does (settings, then run): one lock order, no deadlock.
  if (!(await runIsOpen(tx, tenantId, call.runId))) return { status: "run_closed" };
  // A kind that reaches a model call has a row (the gate stops a kind that is off); no row reads as the default cap.
  const capMicros = settings?.max_cost_micros_per_day ?? 1_000_000;
  // A call for this step still out (or cut off by a crash) blocks another: never pay twice at once.
  const prior = (await tx.query<{ outcome: string }>(
    `SELECT outcome FROM agent_model_calls WHERE tenant_id=$1 AND agent_kind=$2
        AND run_id IS NOT DISTINCT FROM $3 AND subject_id IS NOT DISTINCT FROM $4`,
    [tenantId, call.kind, call.runId, call.subjectId],
  )).rows;
  if (prior.some((row) => row.outcome === "started")) return { status: "exists" };
  const callKey = `${call.callKeyBase}:${prior.length}`;
  const spentBefore = await costSpent(tx, tenantId, call.kind, now);
  if (spentBefore + worst.costMicros > capMicros) return { status: "cost_cap", spent: spentBefore, capMicros };
  const inserted = await tx.query(
    `INSERT INTO agent_model_calls (tenant_id, id, call_key, run_id, agent_kind, subject_id, lane, model,
       input_tokens, output_tokens, cost_micros, outcome, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'started',$12) ON CONFLICT (tenant_id, call_key) DO NOTHING`,
    [tenantId, derivedId(tenantId, callKey, "agent-model-call"), callKey, call.runId, call.kind, call.subjectId, call.lane, call.model,
      worst.inputTokens, worst.outputTokens, worst.costMicros, now],
  );
  if (inserted.rowCount === 0) return { status: "exists" };
  return { status: "reserved", callKey, spentBefore, spentAfter: spentBefore + worst.costMicros, capMicros };
}

/**
 * G-15: record what the call came to. With usage, the provider's numbers priced from the table;
 * without (a failure or an abort), the reserved worst case stands. A row settles once, and not
 * after its run closed (G-16).
 */
export async function settleModelCall(
  tx: Transaction, tenantId: string, callKey: string, runId: string | null,
  result: {
    readonly outcome: "ok" | "error" | "invalid";
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly costMicros: number };
    readonly providerRequestId?: string | undefined;
  },
): Promise<void> {
  // G-16: a run closed meanwhile already counted this call at its reserved worst case; that stands.
  if (!(await runIsOpen(tx, tenantId, runId))) return;
  const requestId = result.providerRequestId?.slice(0, 200) || null;
  if (result.usage)
    await tx.query(
      `UPDATE agent_model_calls SET outcome=$3, input_tokens=$4, output_tokens=$5, cost_micros=$6, provider_request_id=$7
        WHERE tenant_id=$1 AND call_key=$2 AND outcome='started'`,
      [tenantId, callKey, result.outcome, result.usage.inputTokens, result.usage.outputTokens, result.usage.costMicros, requestId],
    );
  else
    await tx.query(
      "UPDATE agent_model_calls SET outcome=$3, provider_request_id=$4 WHERE tenant_id=$1 AND call_key=$2 AND outcome='started'",
      [tenantId, callKey, result.outcome, requestId],
    );
}
