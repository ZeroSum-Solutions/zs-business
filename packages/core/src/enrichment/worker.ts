// Enrichment worker (enrichment.md E-5, E-8..E-13, E-15, E-16). It runs as the service role and names
// tenant_id in every statement. Each request moves through three short transactions: claim (lease),
// prepare (re-check, caps, reserve, open the attempt) and settle. The Treg call happens between prepare
// and settle, outside any transaction. attempt.start, attempt.settle and result.record are these worker
// steps and not dispatcher actions: the dispatcher records through a runtime-role-only function, while
// the wallet and the approvals insert need the service role (docs/requirements/enrichment.md E-3).
import { z } from "zod";
import { ENRICHMENT_FIELDS, ValidationFailed, type EnrichmentField } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { backoffMs } from "../delivery/policy.js";
import { derivedId } from "../edge/ids.js";
import { captureReservation, heldReservationForJob, releaseReservation, reserveForJob } from "../wallet/index.js";
import { enrichmentConfigSchema, enrichmentEnabled, type EnrichmentConfigInput } from "./config.js";
import { minimizeField } from "./minimize.js";
import type { EnrichmentFields, EnrichmentLookup, EnrichmentOutcome, EnrichmentPort } from "./port.js";
import { refusedCountryInLocation } from "./region.js";
import { enrichmentVerdict } from "./rules.js";

const positiveMs = z.number().int().positive().max(7 * 24 * 60 * 60 * 1000);
export const enrichmentWorkerConfigSchema = z.strictObject({
  workerId: z.string().min(1).max(200),
  leaseMs: positiveMs.default(60_000),
  /** Longest wait for one Treg call; it must end well inside the lease. */
  providerTimeoutMs: positiveMs.default(15_000),
  maxAttempts: z.number().int().min(1).max(50).default(6),
  maxStepErrors: z.number().int().min(1).max(50).default(5),
  backoffBaseMs: positiveMs.default(30_000),
  backoffMaxMs: positiveMs.default(30 * 60_000),
  /** No call starts this close to the end of Treg's 24-hour key window (E-12). */
  dedupeMarginMs: positiveMs.default(10 * 60_000),
  /** E-13: how long a result stays proposable. */
  resultTtlMs: positiveMs.default(30 * 24 * 60 * 60 * 1000),
  /** E-16: below this balance (micro-USD) the operator is told; checked at most this often. */
  balanceLowMicro: z.number().int().positive().default(5_000_000),
  balanceCheckEveryMs: positiveMs.default(60 * 60 * 1000),
  whoamiEveryMs: positiveMs.default(24 * 60 * 60 * 1000),
  enrichment: enrichmentConfigSchema,
}).refine((config) => config.providerTimeoutMs * 2 <= config.leaseMs,
  "providerTimeoutMs must be at most half of leaseMs, so a lease outlives its provider call");
export type EnrichmentWorkerConfig = z.input<typeof enrichmentWorkerConfigSchema>;
type Config = z.infer<typeof enrichmentWorkerConfigSchema>;

/** Everything the operator hears; tenants hear none of it (E-16, E-17). `detail` is cut to 200 characters. */
export interface EnrichmentReport {
  readonly code:
    | "treg_balance_low" | "treg_balance_empty" | "treg_token_is_owner" | "treg_whoami_failed" | "treg_route_max_cost"
    | "treg_refused" | "treg_cost_over_cap" | "treg_balance_unreadable" | "step_failed" | "lost_lease" | "outcome_unknown";
  readonly tenantId?: string;
  readonly requestId?: string;
  readonly balanceMicro?: number;
  readonly detail?: string;
}

export interface EnrichmentWorkerDeps {
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly port: EnrichmentPort;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: Omit<EnrichmentWorkerConfig, "enrichment"> & { readonly enrichment: EnrichmentConfigInput };
  readonly report?: (event: EnrichmentReport) => void;
}

export interface Claim { readonly tenantId: string; readonly requestId: string; readonly leaseToken: string }

export type EnrichmentStepResult =
  | { readonly outcome: "succeeded" | "no_match" | "rejected" | "answer_lost" | "region_blocked_after_call"; readonly requestId: string }
  | { readonly outcome: "ended"; readonly status: string; readonly reason: string }
  | { readonly outcome: "retry"; readonly status: "pending" | "uncertain"; readonly reason: string }
  | { readonly outcome: "dead"; readonly reason: string }
  | { readonly outcome: "lost_lease" }
  | { readonly outcome: "error"; readonly error: string };

interface RequestRow {
  tenant_id: string;
  id: string;
  contact_id: string;
  domain: string;
  price_cents: number;
  attempts: number;
  outcome_unknown: boolean;
  first_attempt_at: Date | null;
  treg_call_id: string | null;
  step_errors: number;
}
const ROW_COLUMNS = "tenant_id, id, contact_id, domain, price_cents, attempts, outcome_unknown, first_attempt_at, treg_call_id, step_errors";

type Terminal = { readonly status: "blocked" | "failed" | "daily_cap" | "insufficient_funds"; readonly reason: string };
type Plan =
  | { readonly kind: "done"; readonly result: EnrichmentStepResult }
  | { readonly kind: "call"; readonly call: Parameters<EnrichmentPort["run"]>[0] }
  | { readonly kind: "lookup"; readonly onNotFound: Terminal };

const FIELD_LABELS: Readonly<Record<EnrichmentField, string>> = {
  name: "name", domain: "website", industry: "industry", description: "description", employees: "employee count",
  founded: "founding year", location: "location", linkedin_url: "LinkedIn page",
};
const errorText = (text: string) => (text.replaceAll("\u0000", "").trim() || "unknown").slice(0, 200);
const utcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

export function createEnrichmentWorker(deps: EnrichmentWorkerDeps) {
  const parsed = enrichmentWorkerConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new ValidationFailed(`Invalid enrichment worker config: ${parsed.error.message}`);
  const config: Config = parsed.data;
  const now = () => new Date(readClock(deps.clock));
  const port = deps.port;
  const report = (event: EnrichmentReport) => deps.report?.(event.detail === undefined ? event : { ...event, detail: errorText(event.detail) });

  async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, onError: (code: string) => T): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<T>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(onError("provider_timeout")); }, config.providerTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)).catch((error: unknown) => onError(error instanceof Error ? "provider_error" : "provider_error")),
        timedOut,
      ]);
    } finally { clearTimeout(timer); }
  }

  // E-5: the token's role, read at start and daily. Unknown fails closed for the attempt (not the request).
  let role: { value: string | null; at: number } = { value: null, at: Number.NEGATIVE_INFINITY };
  async function tokenRole(): Promise<string | null> {
    const t = now().getTime();
    if (role.value !== null && t - role.at < config.whoamiEveryMs) return role.value;
    const result = await withDeadline<{ role: string } | null>((signal) => port.whoami({ signal }), () => null);
    if (result === null) { report({ code: "treg_whoami_failed" }); return role.value; }
    role = { value: result.role, at: t };
    if (result.role === "owner") report({ code: "treg_token_is_owner" });
    return result.role;
  }

  async function claim(limit = 10): Promise<Claim[]> {
    return deps.service(async (tx) => {
      const at = now();
      const token = deps.generateId();
      const rows = (await tx.query<{ tenant_id: string; id: string }>(
        `WITH due AS (
           SELECT tenant_id, id FROM enrichment_requests
            WHERE (status IN ('pending','uncertain') AND next_attempt_at <= $1)
               OR (status = 'leased' AND lease_expires_at <= $1)
            ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE enrichment_requests r SET status='leased', lease_token=$3, lease_owner=$4, lease_expires_at=$5, updated_at=$1
           FROM due WHERE r.tenant_id=due.tenant_id AND r.id=due.id
         RETURNING r.tenant_id, r.id`,
        [at, limit, token, config.workerId, new Date(at.getTime() + config.leaseMs)])).rows;
      return rows.map((row) => ({ tenantId: row.tenant_id, requestId: row.id, leaseToken: token }));
    });
  }

  const lockLeased = async (tx: Transaction, lease: Claim): Promise<RequestRow | undefined> =>
    (await tx.query<RequestRow>(
      `SELECT ${ROW_COLUMNS} FROM enrichment_requests WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='leased' FOR UPDATE`,
      [lease.tenantId, lease.requestId, lease.leaseToken])).rows[0];

  const release = async (tx: Transaction, row: RequestRow, at: Date) => {
    const held = await heldReservationForJob(tx, row.tenant_id, "enrichment", row.id);
    if (held) await releaseReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, now: at });
  };

  async function end(tx: Transaction, row: RequestRow, status: string, reason: string | null, at: Date, extra: { callId?: string | null; provider?: string | null; costMicro?: number } = {}): Promise<void> {
    await tx.query(
      `UPDATE enrichment_requests SET status=$3, final_reason=$4, outcome_unknown=false, lease_token=NULL, lease_owner=NULL,
         lease_expires_at=NULL, treg_call_id=coalesce($5, treg_call_id), provider=coalesce($6, provider),
         treg_cost_micro=coalesce($7, treg_cost_micro), updated_at=$8 WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, status, reason, extra.callId ?? null, extra.provider ?? null, extra.costMicro ?? null, at]);
  }

  async function endWithRelease(tx: Transaction, row: RequestRow, terminal: Terminal, at: Date): Promise<EnrichmentStepResult> {
    await release(tx, row, at);
    await end(tx, row, terminal.status, terminal.reason, at);
    return { outcome: "ended", status: terminal.status, reason: terminal.reason };
  }

  async function retryLater(tx: Transaction, row: RequestRow, status: "pending" | "uncertain", reason: string, delayMs: number, at: Date,
    extra: { callId?: string | null; costMicro?: number; attempts?: number } = {}): Promise<EnrichmentStepResult> {
    await tx.query(
      `UPDATE enrichment_requests SET status=$3, next_attempt_at=$4, last_error=$5, lease_token=NULL, lease_owner=NULL,
         lease_expires_at=NULL, treg_call_id=coalesce($6, treg_call_id), treg_cost_micro=coalesce($7, treg_cost_micro), updated_at=$8
        WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, status, new Date(at.getTime() + delayMs), errorText(reason), extra.callId ?? null, extra.costMicro ?? null, at]);
    return { outcome: "retry", status, reason };
  }

  async function deadLetterHeld(tx: Transaction, row: RequestRow, reason: "outcome_unknown" | "worker_error", error: string, at: Date): Promise<EnrichmentStepResult> {
    await tx.query(
      `UPDATE enrichment_requests SET status='dead', final_reason=$3, last_error=$4, lease_token=NULL, lease_owner=NULL,
         lease_expires_at=NULL, updated_at=$5 WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, reason, errorText(error), at]);
    report({ code: reason === "outcome_unknown" ? "outcome_unknown" : "step_failed", tenantId: row.tenant_id, requestId: row.id, detail: error });
    return { outcome: "dead", reason };
  }

  /** E-10 attempt.start: re-check, cap, reserve, open the attempt. */
  async function prepare(lease: Claim, tokenRoleValue: string | null): Promise<Plan> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { kind: "done", result: { outcome: "lost_lease" } };
      const at = now();
      await tx.query("UPDATE enrichment_requests SET lease_expires_at=$3 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, new Date(at.getTime() + config.leaseMs)]);
      if (row.step_errors >= config.maxStepErrors)
        return { kind: "done", result: await deadLetterHeld(tx, row, "worker_error", "step_errors", at) };

      // E-5, E-6, E-7 against current rows.
      let terminal: Terminal | null = null;
      if (!enrichmentEnabled(config.enrichment) || tokenRoleValue === "owner")
        terminal = { status: "blocked", reason: "enrichment_unavailable" };
      else {
        const verdict = await enrichmentVerdict(tx, { tenantId: row.tenant_id, contactId: row.contact_id, sentDomain: row.domain });
        if (verdict === "no_contact") terminal = { status: "blocked", reason: "enrichment_blocked" };
        else if (verdict.code !== null) terminal = { status: "blocked", reason: verdict.code };
      }
      // An attempt whose answer never arrived may have been billed: ask Treg before ending it (E-12).
      if (terminal && row.outcome_unknown) return { kind: "lookup", onNotFound: terminal };
      if (terminal) return { kind: "done", result: await endWithRelease(tx, row, terminal, at) };
      if (tokenRoleValue === null)
        return { kind: "done", result: await retryLater(tx, row, row.outcome_unknown ? "uncertain" : "pending", "whoami_unavailable", config.backoffBaseMs, at) };

      const checkedAt = now();
      const windowEnd = row.first_attempt_at ? row.first_attempt_at.getTime() + port.dedupeWindowMs - config.dedupeMarginMs : Number.POSITIVE_INFINITY;
      const windowOpen = checkedAt.getTime() + config.providerTimeoutMs <= windowEnd;
      if (!windowOpen || row.attempts >= config.maxAttempts) {
        const ending: Terminal = { status: "failed", reason: windowOpen ? "max_attempts" : "dedupe_window_expired" };
        if (row.outcome_unknown) return { kind: "lookup", onNotFound: ending };
        return { kind: "done", result: await endWithRelease(tx, row, ending, at) };
      }

      if (row.first_attempt_at === null) {
        // E-9: the global cap, counted under one lock for all tenants; the first attempt is stamped in this transaction.
        await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", ["enrichment-global-day"]);
        const day = utcDay(at);
        const started = (await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM enrichment_requests
            WHERE first_attempt_at >= $1 AND first_attempt_at < $1::timestamptz + interval '1 day' AND tenant_id IS NOT NULL`,
          [day.toISOString()])).rows[0]!.n;
        if (started >= config.enrichment.globalDailyCap) {
          await end(tx, row, "daily_cap", "enrichment_daily_cap", at);
          return { kind: "done", result: { outcome: "ended", status: "daily_cap", reason: "enrichment_daily_cap" } };
        }
      }
      // E-8: one hold per request, reused by every retry (D-11's index refuses a second).
      if (!(await heldReservationForJob(tx, row.tenant_id, "enrichment", row.id)) && !row.outcome_unknown) {
        const reserved = await reserveForJob(tx, {
          tenantId: row.tenant_id, jobKind: "enrichment", jobId: row.id, reservationId: deps.generateId(),
          amount: row.price_cents, currency: "usd", now: at,
        });
        if (!reserved) {
          await end(tx, row, "insufficient_funds", "insufficient_funds", at);
          return { kind: "done", result: { outcome: "ended", status: "insufficient_funds", reason: "insufficient_funds" } };
        }
      }
      await tx.query(
        `UPDATE enrichment_requests SET attempts=attempts+1, outcome_unknown=true, first_attempt_at=coalesce(first_attempt_at,$3),
           provider=$4, updated_at=$3 WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, at, port.name]);
      return {
        kind: "call",
        call: { op: "company.enrich", domain: row.domain, idempotencyKey: `enrichment:${row.id}`, priceCents: row.price_cents, tenantId: row.tenant_id },
      };
    });
  }

  /** E-13 result.record: one immutable row and one pending approval per kept field. */
  async function recordResults(tx: Transaction, row: RequestRow, fields: EnrichmentFields, callId: string, provider: string, at: Date): Promise<number> {
    const actor = derivedId(row.tenant_id, "enrichment", "actor");
    const expires = new Date(at.getTime() + config.resultTtlMs);
    let written = 0;
    for (const field of ENRICHMENT_FIELDS) {
      const value = fields[field];
      if (value === undefined) continue;
      const resultId = deps.generateId();
      const approvalId = deps.generateId();
      // The request row is locked by this lease, so a result for this field cannot appear meanwhile.
      if ((await tx.query("SELECT 1 FROM enrichment_results WHERE tenant_id=$1 AND request_id=$2 AND field=$3", [row.tenant_id, row.id, field])).rowCount === 1) continue;
      // E-14: a proposal naming the field, never its value; ids only in the payload.
      await tx.query(
        `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at)
         VALUES ($1,$2,'contact.profile.apply','contact',$3,$4,$5,$6,$7,$8)`,
        [row.tenant_id, approvalId, row.contact_id, JSON.stringify({ contactId: row.contact_id, resultId }),
          `Save the company ${FIELD_LABELS[field]} found for this contact`, actor, at, expires]);
      await tx.query(
        `INSERT INTO enrichment_results (tenant_id, id, request_id, contact_id, field, value, provider, treg_call_id, approval_id, fetched_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [row.tenant_id, resultId, row.id, row.contact_id, field, value, provider, callId, approvalId, at, expires]);
      written += 1;
    }
    return written;
  }

  /** E-11 attempt.settle for one definite or uncertain answer. */
  async function settle(lease: Claim, outcome: EnrichmentOutcome): Promise<EnrichmentStepResult> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { outcome: "lost_lease" };
      const at = now();
      const cost = "costMicro" in outcome ? outcome.costMicro : undefined;
      if (cost !== undefined && cost > row.price_cents * 10_000)
        report({ code: "treg_cost_over_cap", tenantId: row.tenant_id, requestId: row.id, detail: `cost ${cost} micro over cap ${row.price_cents * 10_000}` });
      switch (outcome.status) {
        case "hit": {
          // Defence in depth: whatever a port hands over is bounded again here.
          const fields: Partial<Record<EnrichmentField, string>> = {};
          for (const field of ENRICHMENT_FIELDS) {
            const kept = outcome.fields[field] === undefined ? null : minimizeField(field, outcome.fields[field], at);
            if (kept !== null) fields[field] = kept;
          }
          if (Object.keys(fields).length === 0) {
            await release(tx, row, at);
            await end(tx, row, "no_match", "no_match", at, { callId: outcome.callId, provider: outcome.provider, costMicro: outcome.costMicro });
            return { outcome: "no_match", requestId: row.id };
          }
          const country = fields.location ? refusedCountryInLocation(fields.location) : null;
          if (country) {
            // E-13: a refused-region answer is discarded, not stored; the contact learns its country.
            await release(tx, row, at);
            await tx.query(
              `INSERT INTO crm_contact_profile (tenant_id, contact_id, country, updated_at) VALUES ($1,$2,$3,$4)
               ON CONFLICT (tenant_id, contact_id) DO UPDATE SET country=EXCLUDED.country, revision=crm_contact_profile.revision+1, updated_at=EXCLUDED.updated_at`,
              [row.tenant_id, row.contact_id, country, at]);
            await end(tx, row, "region_blocked_after_call", "enrichment_region_blocked", at, { callId: outcome.callId, provider: outcome.provider, costMicro: outcome.costMicro });
            return { outcome: "region_blocked_after_call", requestId: row.id };
          }
          // The tenant pays for the lookup, whatever the owner later decides about the fields.
          const held = await heldReservationForJob(tx, row.tenant_id, "enrichment", row.id);
          if (held) await captureReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, ledgerId: deps.generateId(), now: at });
          await recordResults(tx, row, fields, outcome.callId, outcome.provider, at);
          await end(tx, row, "succeeded", null, at, { callId: outcome.callId, provider: outcome.provider, costMicro: outcome.costMicro });
          return { outcome: "succeeded", requestId: row.id };
        }
        case "miss":
          await release(tx, row, at);
          await end(tx, row, "no_match", "no_match", at, { callId: outcome.callId, provider: outcome.provider, costMicro: outcome.costMicro });
          return { outcome: "no_match", requestId: row.id };
        case "rejected":
          await release(tx, row, at);
          await end(tx, row, "rejected", "rejected", at, { callId: outcome.callId, costMicro: outcome.costMicro });
          return { outcome: "rejected", requestId: row.id };
        case "failed": {
          if (outcome.kind === "route_max_cost" || outcome.kind === "insufficient_balance") {
            report({ code: outcome.kind === "insufficient_balance" ? "treg_balance_empty" : "treg_route_max_cost", tenantId: row.tenant_id, requestId: row.id, detail: outcome.code });
            await release(tx, row, at);
            await end(tx, row, "failed", "enrichment_unavailable", at, { callId: outcome.callId, costMicro: outcome.costMicro });
            return { outcome: "ended", status: "failed", reason: "enrichment_unavailable" };
          }
          if (outcome.kind === "refused") report({ code: "treg_refused", tenantId: row.tenant_id, requestId: row.id, detail: outcome.code });
          // 429, 5xx or a refusal: the hold stays; the same key is sent again after the delay.
          if (row.attempts >= config.maxAttempts) {
            await release(tx, row, at);
            await end(tx, row, "failed", "enrichment_unavailable", at, { callId: outcome.callId, costMicro: outcome.costMicro });
            return { outcome: "ended", status: "failed", reason: "enrichment_unavailable" };
          }
          await tx.query("UPDATE enrichment_requests SET outcome_unknown=false WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
          const delay = Math.max(backoffMs(row.attempts, config.backoffBaseMs, config.backoffMaxMs), (outcome.retryAfterS ?? 0) * 1000);
          return retryLater(tx, row, "pending", outcome.code, delay, at, { callId: outcome.callId, costMicro: outcome.costMicro });
        }
        case "uncertain":
          return retryLater(tx, row, "uncertain", outcome.code, backoffMs(row.attempts, config.backoffBaseMs, config.backoffMaxMs), at);
        case "key_expired":
          // Handled by the caller (a lookup); a stray one is an unknown outcome that waits.
          return retryLater(tx, row, "uncertain", "key_expired", config.backoffBaseMs, at);
      }
    });
  }

  /** E-12: what a lookup proved about an attempt whose answer was lost. */
  async function settleLookup(lease: Claim, outcome: EnrichmentLookup, onNotFound: Terminal): Promise<EnrichmentStepResult> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { outcome: "lost_lease" };
      const at = now();
      if (outcome.status === "charged") {
        // The answer is lost and the cost is ours: the hold goes back.
        await release(tx, row, at);
        await end(tx, row, "answer_lost", "enrichment_unavailable", at, { callId: outcome.callId });
        return { outcome: "answer_lost", requestId: row.id };
      }
      if (outcome.status === "not_found") return endWithRelease(tx, row, onNotFound, at);
      return deadLetterHeld(tx, row, "outcome_unknown", outcome.code, at);
    });
  }

  let lastBalanceCheck = Number.NEGATIVE_INFINITY;
  /** E-16: at most once an hour, after a settled call. The operator hears; no tenant row does. */
  async function checkBalance(): Promise<void> {
    const t = now().getTime();
    if (t - lastBalanceCheck < config.balanceCheckEveryMs) return;
    lastBalanceCheck = t;
    const result = await withDeadline<{ balanceMicro: number } | null>((signal) => port.balance({ signal }), () => null);
    if (result === null) { report({ code: "treg_balance_unreadable" }); return; }
    if (result.balanceMicro < config.balanceLowMicro) report({ code: "treg_balance_low", balanceMicro: result.balanceMicro });
  }

  async function step(lease: Claim): Promise<EnrichmentStepResult> {
    const roleValue = await tokenRole();
    const plan = await prepare(lease, roleValue);
    let result: EnrichmentStepResult;
    let called = false;
    if (plan.kind === "done") result = plan.result;
    else if (plan.kind === "call") {
      const outcome = await withDeadline<EnrichmentOutcome>((signal) => port.run(plan.call, { signal }), (code) => ({ status: "uncertain", code }));
      called = true;
      if (outcome.status === "key_expired") {
        const looked = await withDeadline<EnrichmentLookup>(
          (signal) => port.lookup({ callId: outcome.callId, idempotencyKey: plan.call.idempotencyKey }, { signal }),
          (code) => ({ status: "unknown", code }));
        result = await settleLookup(lease, looked, { status: "failed", reason: "enrichment_unavailable" });
      } else result = await settle(lease, outcome);
    } else {
      const key = `enrichment:${lease.requestId}`;
      const callId = await deps.service(async (tx) =>
        (await tx.query<{ treg_call_id: string | null }>(
          "SELECT treg_call_id FROM enrichment_requests WHERE tenant_id=$1 AND id=$2", [lease.tenantId, lease.requestId])).rows[0]?.treg_call_id ?? null);
      const looked = await withDeadline<EnrichmentLookup>(
        (signal) => port.lookup({ callId, idempotencyKey: key }, { signal }), (code) => ({ status: "unknown", code }));
      result = await settleLookup(lease, looked, plan.onNotFound);
    }
    if (result.outcome === "lost_lease") report({ code: "lost_lease", tenantId: lease.tenantId, requestId: lease.requestId });
    if (called && result.outcome !== "lost_lease") await checkBalance().catch(() => report({ code: "treg_balance_unreadable" }));
    return result;
  }

  async function noteStepError(lease: Claim, error: unknown): Promise<EnrichmentStepResult> {
    const text = errorText(error instanceof Error ? error.message : "step_failed");
    report({ code: "step_failed", tenantId: lease.tenantId, requestId: lease.requestId, detail: text });
    try {
      await deps.service(async (tx) => {
        const at = now();
        await tx.query(
          `UPDATE enrichment_requests SET step_errors=step_errors+1,
             status=CASE WHEN outcome_unknown THEN 'uncertain' ELSE 'pending' END, next_attempt_at=$4, last_error=$5,
             lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=$3
            WHERE tenant_id=$1 AND id=$2 AND lease_token=$6 AND status='leased'`,
          [lease.tenantId, lease.requestId, at, new Date(at.getTime() + config.backoffBaseMs), text, lease.leaseToken]);
      });
    } catch { /* the lease runs out on its own */ }
    return { outcome: "error", error: text };
  }

  async function runOnce(options: { claimLimit?: number } = {}) {
    const leases = await claim(options.claimLimit ?? 10);
    const results: EnrichmentStepResult[] = [];
    for (const lease of leases) results.push(await step(lease).catch((error: unknown) => noteStepError(lease, error)));
    return { claimed: leases.length, results };
  }

  /** E-15: deletes results past `expires_at`; applied values live on in the profile. */
  async function purgeExpired(limit = 1000): Promise<number> {
    return deps.service(async (tx) => (await tx.query(
      `DELETE FROM enrichment_results WHERE (tenant_id, id) IN (
         SELECT tenant_id, id FROM enrichment_results WHERE expires_at <= $1 ORDER BY expires_at LIMIT $2)`,
      [now(), limit])).rowCount ?? 0);
  }

  return { claim, step, runOnce, purgeExpired, checkBalance, config };
}
export type EnrichmentWorker = ReturnType<typeof createEnrichmentWorker>;
