// M5 billing worker (docs/requirements/stripe.md S-4..S-6). Original code. It runs as the service
// role, claims stored Stripe events one at a time with SKIP LOCKED and applies each in its own
// transaction and savepoint. The tenant and top-up always come from our own wallet_topups row,
// never from the event alone.
import { z } from "zod";
import type { Transaction } from "@zs/db";
import { creditWallet, debitWallet, minorUnits, repayOwed } from "../wallet/index.js";

export const billingWorkerConfigSchema = z.strictObject({
  /** An event whose top-up is not known yet is retried this many times, then `orphaned`. */
  maxAttempts: z.number().int().min(1).max(100).default(12),
  backoffBaseMs: z.number().int().positive().default(30_000),
  backoffMaxMs: z.number().int().positive().default(60 * 60_000),
});
export type BillingWorkerConfig = z.input<typeof billingWorkerConfigSchema>;

export interface BillingWorkerDeps {
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config?: BillingWorkerConfig;
  readonly report?: (event: { readonly eventId: string; readonly type: string; readonly outcome: string }) => void;
}

/** What one event did. `wait` leaves it unprocessed for a later pass. */
export type BillingOutcome =
  | "credited" | "already_credited" | "mismatch" | "failed" | "expired" | "refund_debited" | "refund_seen"
  | "dispute_debited" | "dispute_reinstated" | "dispute_seen" | "ignored" | "not_ours" | "wait" | "orphaned" | "error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Stripe IDs are about 30 characters; the cap keeps ledger keys under their 200-character limit.
const STRIPE_ID = /^[A-Za-z0-9_]{1,100}$/;

interface TopUpRow {
  tenant_id: string;
  id: string;
  amount: string;
  currency: string;
  status: string;
  refunded: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
}
const COLUMNS = "tenant_id, id, amount, currency, status, refunded, stripe_checkout_session_id, stripe_payment_intent_id";

const text = (value: unknown): string | null => (typeof value === "string" && STRIPE_ID.test(value) ? value : null);
/** A Stripe field that may be an ID or an expanded object. */
const idOf = (value: unknown): string | null =>
  text(value) ?? (value && typeof value === "object" ? text((value as { id?: unknown }).id) : null);
const amountOf = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null);
const metadata = (object: Record<string, unknown>) => {
  const raw = object.metadata;
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
};

export function createBillingWorker(deps: BillingWorkerDeps) {
  const config = billingWorkerConfigSchema.parse(deps.config ?? {});
  const now = () => new Date(deps.clock.now().getTime());

  const bySession = async (tx: Transaction, object: Record<string, unknown>): Promise<TopUpRow | null> => {
    const meta = metadata(object);
    const tenantId = typeof meta.zs_tenant === "string" && UUID.test(meta.zs_tenant) ? meta.zs_tenant : null;
    const topupId = typeof meta.zs_topup === "string" && UUID.test(meta.zs_topup) ? meta.zs_topup : null;
    if (!tenantId || !topupId) return null;
    return (await tx.query<TopUpRow>(`SELECT ${COLUMNS} FROM wallet_topups WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, topupId])).rows[0] ?? null;
  };
  const byIntent = async (tx: Transaction, intent: string | null): Promise<TopUpRow | null> =>
    intent === null ? null : (await tx.query<TopUpRow>(
      `SELECT ${COLUMNS} FROM wallet_topups WHERE stripe_payment_intent_id=$1 FOR UPDATE`, [intent])).rows[0] ?? null;

  /** Credits `amount`, then repays anything owed from it (S-6). */
  async function credit(tx: Transaction, row: TopUpRow, amount: number, key: string, note: string, at: Date) {
    const result = await creditWallet(tx, {
      tenantId: row.tenant_id, ledgerId: deps.generateId(), amount, idempotencyKey: key, note, currency: row.currency, now: at,
    });
    if (result.applied) await repayOwed(tx, { tenantId: row.tenant_id, ledgerId: deps.generateId(), now: at });
    return result.applied;
  }

  /** Records one refund step or dispute movement once; false when it was already recorded. */
  async function record(tx: Transaction, row: TopUpRow, kind: string, reference: string, amount: number, applied: number, at: Date) {
    const inserted = await tx.query(
      `INSERT INTO wallet_billing_events (tenant_id, id, topup_id, kind, reference, amount, applied, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, kind, reference) DO NOTHING`,
      [row.tenant_id, deps.generateId(), row.id, kind, reference.slice(0, 300), amount, applied, at]);
    return inserted.rowCount === 1;
  }
  const seen = async (tx: Transaction, row: TopUpRow, kind: string, reference: string) =>
    (await tx.query("SELECT 1 FROM wallet_billing_events WHERE tenant_id=$1 AND kind=$2 AND reference=$3",
      [row.tenant_id, kind, reference.slice(0, 300)])).rowCount === 1;

  async function paid(tx: Transaction, object: Record<string, unknown>, at: Date): Promise<BillingOutcome> {
    if (object.mode !== "payment") return "not_ours";
    const row = await bySession(tx, object);
    if (!row) return "not_ours";
    if (object.payment_status !== "paid") return "ignored";
    const sessionId = idOf(object.id);
    if (row.stripe_checkout_session_id !== null && row.stripe_checkout_session_id !== sessionId) return "not_ours";
    if (row.status === "paid") return "already_credited";
    const amount = amountOf(object.amount_total);
    if (row.status !== "pending") return "ignored";
    if (amount !== minorUnits(row.amount) || object.currency !== row.currency) {
      await tx.query(
        `UPDATE wallet_topups SET status='mismatch', stripe_checkout_session_id=$3, stripe_payment_intent_id=$5, updated_at=$4
          WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, sessionId, at, idOf(object.payment_intent)]);
      return "mismatch";
    }
    await tx.query(
      `UPDATE wallet_topups SET status='paid', paid_at=$3, stripe_checkout_session_id=$4, stripe_payment_intent_id=$5, updated_at=$3
        WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, at, sessionId, idOf(object.payment_intent)]);
    const applied = await credit(tx, row, amount, `stripe:topup:${row.id}`, "Stripe top-up", at);
    return applied ? "credited" : "already_credited";
  }

  async function closed(tx: Transaction, object: Record<string, unknown>, status: "failed" | "expired", at: Date): Promise<BillingOutcome> {
    const row = await bySession(tx, object);
    if (!row) return "not_ours";
    const updated = await tx.query(
      `UPDATE wallet_topups SET status=$3, stripe_checkout_session_id=coalesce(stripe_checkout_session_id,$4), updated_at=$5
        WHERE tenant_id=$1 AND id=$2 AND status='pending'`,
      [row.tenant_id, row.id, status, idOf(object.id), at]);
    return updated.rowCount === 1 ? status : "ignored";
  }

  async function refunded(tx: Transaction, object: Record<string, unknown>, at: Date): Promise<BillingOutcome> {
    const row = await byIntent(tx, idOf(object.payment_intent));
    // The payment may not be recorded yet: wait for checkout.session.completed.
    if (!row) return "wait";
    // Nothing was credited for a mismatched payment, so there is nothing to take back.
    if (row.status !== "paid") return "ignored";
    const total = amountOf(object.amount_refunded);
    if (total === null) return "ignored";
    const target = Math.min(total, minorUnits(row.amount));
    const delta = target - minorUnits(row.refunded);
    // An older, smaller running total arriving late changes nothing.
    if (delta <= 0) return "refund_seen";
    const reference = `${idOf(object.id) ?? "charge"}:${target}`;
    if (await seen(tx, row, "refund", reference)) return "refund_seen";
    const debit = await debitWallet(tx, {
      tenantId: row.tenant_id, ledgerId: deps.generateId(), amount: delta, idempotencyKey: `stripe:refund:${row.id}:${target}`,
      note: "Stripe refund", now: at,
    });
    await record(tx, row, "refund", reference, delta, debit.applied, at);
    await tx.query("UPDATE wallet_topups SET refunded=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, target, at]);
    return "refund_debited";
  }

  async function dispute(tx: Transaction, object: Record<string, unknown>, direction: "withdrawn" | "reinstated", at: Date): Promise<BillingOutcome> {
    const row = await byIntent(tx, idOf(object.payment_intent));
    if (!row) return "wait";
    if (row.status !== "paid") return "ignored";
    const disputeId = idOf(object.id);
    const amount = amountOf(object.amount);
    if (!disputeId || !amount) return "ignored";
    const capped = Math.min(amount, minorUnits(row.amount));
    if (direction === "withdrawn") {
      if (await seen(tx, row, "dispute_withdrawn", disputeId)) return "dispute_seen";
      const debit = await debitWallet(tx, {
        tenantId: row.tenant_id, ledgerId: deps.generateId(), amount: capped, idempotencyKey: `stripe:dispute:${disputeId}:withdrawn`,
        note: "Stripe dispute", now: at,
      });
      await record(tx, row, "dispute_withdrawn", disputeId, capped, debit.applied, at);
      return "dispute_debited";
    }
    // A reinstatement returns only what a recorded withdrawal took; out of order, it waits for it.
    if (!(await seen(tx, row, "dispute_withdrawn", disputeId))) return "wait";
    if (!(await record(tx, row, "dispute_reinstated", disputeId, capped, capped, at))) return "dispute_seen";
    await credit(tx, row, capped, `stripe:dispute:${disputeId}:reinstated`, "Stripe dispute reinstated", at);
    return "dispute_reinstated";
  }

  async function apply(tx: Transaction, type: string, object: Record<string, unknown>, at: Date): Promise<BillingOutcome> {
    switch (type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return paid(tx, object, at);
      case "checkout.session.async_payment_failed":
        return closed(tx, object, "failed", at);
      case "checkout.session.expired":
        return closed(tx, object, "expired", at);
      case "charge.refunded":
        return refunded(tx, object, at);
      case "charge.dispute.funds_withdrawn":
        return dispute(tx, object, "withdrawn", at);
      case "charge.dispute.funds_reinstated":
        return dispute(tx, object, "reinstated", at);
      default:
        return "ignored";
    }
  }

  /** One event: claims the oldest due one with SKIP LOCKED and applies it in a savepoint. */
  async function applyNext(at: Date): Promise<{ type: string; id: string; outcome: BillingOutcome } | null> {
    return deps.service(async (tx) => {
      const event = (await tx.query<{ id: string; type: string; payload: { data?: { object?: unknown } }; attempts: number }>(
        `SELECT id, type, payload, attempts FROM stripe_events WHERE processed_at IS NULL AND next_attempt_at <= $1
          ORDER BY received_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [at])).rows[0];
      if (!event) return null;
      const object = event.payload?.data?.object;
      let outcome: BillingOutcome;
      await tx.query("SAVEPOINT billing_event");
      try {
        outcome = object && typeof object === "object" ? await apply(tx, event.type, object as Record<string, unknown>, at) : "ignored";
        await tx.query("RELEASE SAVEPOINT billing_event");
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT billing_event");
        outcome = "error";
        const message = (error instanceof Error ? error.message : "error").replaceAll("\u0000", "").slice(0, 500) || "error";
        await tx.query("UPDATE stripe_events SET last_error=$2 WHERE id=$1", [event.id, message]);
      }
      const attempts = event.attempts + 1;
      if ((outcome === "wait" || outcome === "error") && attempts < config.maxAttempts) {
        const delay = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (attempts - 1));
        await tx.query("UPDATE stripe_events SET attempts=$2, next_attempt_at=$3 WHERE id=$1",
          [event.id, attempts, new Date(at.getTime() + delay)]);
      } else {
        if (outcome === "wait" || outcome === "error") outcome = "orphaned";
        await tx.query("UPDATE stripe_events SET attempts=$2, processed_at=$3, outcome=$4 WHERE id=$1",
          [event.id, attempts, at, outcome]);
      }
      return { id: event.id, type: event.type, outcome };
    });
  }

  /**
   * One pass: applies up to `limit` due events oldest first, each in its own transaction, so a
   * pass holds a top-up's and a wallet's locks only while it applies that one event and two
   * parallel passes cannot wait on each other's rows.
   */
  async function runOnce(limit = 50): Promise<{ claimed: number; outcomes: Record<string, number> }> {
    const at = now();
    const outcomes: Record<string, number> = {};
    let claimed = 0;
    while (claimed < limit) {
      const applied = await applyNext(at);
      if (applied === null) break;
      claimed += 1;
      outcomes[applied.outcome] = (outcomes[applied.outcome] ?? 0) + 1;
      deps.report?.({ eventId: applied.id, type: applied.type, outcome: applied.outcome });
    }
    // S-6: money that came back (a released reservation) repays what a wallet owes.
    await deps.service(async (tx) => {
      const owing = (await tx.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM wallets WHERE owed > 0 AND balance > reserved ORDER BY tenant_id LIMIT 100")).rows;
      for (const wallet of owing) await repayOwed(tx, { tenantId: wallet.tenant_id, ledgerId: deps.generateId(), now: at });
    });
    return { claimed, outcomes };
  }

  return { runOnce, config };
}
export type BillingWorker = ReturnType<typeof createBillingWorker>;
