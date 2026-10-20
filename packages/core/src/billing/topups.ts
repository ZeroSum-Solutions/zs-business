// M5 wallet top-ups (docs/requirements/stripe.md S-1, S-2). Original code. The action records a
// pending top-up under the member's key; the Checkout Session is asked for after it commits,
// under a key derived from the top-up, so a retry replays both.
import {
  Conflict,
  createTopUpCommandSchema,
  topUpSchema,
  ValidationFailed,
  type ActionCommand,
  type ActionResult,
  type TopUp,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";
import type { StripeClient } from "./stripe.js";
import { WALLET_TOPUP_CREATE_ACTION } from "@zs/contracts";

/**
 * S-2: Checkout expires an hour after the top-up was created. Stripe refuses an expires_at less
 * than 30 minutes ahead, so a first request that never reached Stripe may only be retried while
 * at least 35 minutes remain: retries stop 25 minutes after creation.
 */
export const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;
export const CHECKOUT_RETRY_LIMIT_MS = 25 * 60 * 1000;

interface TopUpRow {
  id: string;
  amount: string;
  currency: string;
  status: TopUp["status"];
  refunded: string;
  created_at: Date;
  paid_at: Date | null;
}
const TOPUP_COLUMNS = "id, amount, currency, status, refunded, created_at, paid_at";

export const topUpFromRow = (row: TopUpRow): TopUp => topUpSchema.parse({
  id: row.id,
  amount: Number(row.amount),
  currency: row.currency,
  status: row.status,
  refunded: Number(row.refunded),
  createdAt: row.created_at.toISOString(),
  paidAt: row.paid_at ? row.paid_at.toISOString() : null,
});

export const createTopUpHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "wallet_topup") throw new ValidationFailed("Top-ups require a wallet_topup target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    return { tenantId, type: "wallet_topup", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(createTopUpCommandSchema, command);
    if (command.target.id !== payload.topupId) throw new ValidationFailed("Target must name the top-up");
    if (payload.amount < payload.minAmount || payload.amount > payload.maxAmount)
      throw new ValidationFailed(`Top-ups are between ${payload.minAmount} and ${payload.maxAmount} minor units`);
    const row = (await tx.query<TopUpRow>(
      `INSERT INTO wallet_topups (tenant_id, id, amount, currency, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING ${TOPUP_COLUMNS}`,
      [binding.tenantId, payload.topupId, payload.amount, payload.currency, binding.actorId, now])).rows[0]!;
    return { result: { ...topUpFromRow(row) } };
  },
};

export const topUpHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [WALLET_TOPUP_CREATE_ACTION]: createTopUpHandler,
});

export async function getTopUp(tx: Transaction, tenantId: string, topupId: string): Promise<TopUp | null> {
  const row = (await tx.query<TopUpRow>(
    `SELECT ${TOPUP_COLUMNS} FROM wallet_topups WHERE tenant_id=$1 AND id=$2`, [tenantId, topupId])).rows[0];
  return row ? topUpFromRow(row) : null;
}

export async function listTopUps(tx: Transaction, tenantId: string, limit = 20): Promise<TopUp[]> {
  return (await tx.query<TopUpRow>(
    `SELECT ${TOPUP_COLUMNS} FROM wallet_topups WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT $2`,
    [tenantId, limit])).rows.map(topUpFromRow);
}

/**
 * S-1, S-2: runs the action, then asks Stripe for the session. `read` loads the stored top-up
 * (a replayed action returns the first result, whose status may since have moved on).
 */
export async function startTopUp(input: {
  readonly command: ActionCommand;
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
  readonly read: (topupId: string) => Promise<TopUp | null>;
  readonly stripe: StripeClient;
  readonly tenantId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
}): Promise<{ topup: TopUp; checkoutUrl: string }> {
  const parsed = parseOrFail(createTopUpCommandSchema, input.command);
  await input.dispatch(parsed);
  const topup = await input.read(parsed.payload.topupId);
  if (!topup) throw new Conflict("The top-up is not available", { reason: "topup_closed" });
  const createdAt = Date.parse(topup.createdAt);
  if (topup.status !== "pending" || input.now.getTime() - createdAt > CHECKOUT_RETRY_LIMIT_MS)
    throw new Conflict("The top-up can no longer be paid; start a new one", { reason: "topup_closed" });
  const session = await input.stripe.createCheckoutSession({
    tenantId: input.tenantId,
    topupId: topup.id,
    amount: topup.amount,
    currency: topup.currency,
    expiresAt: Math.floor((createdAt + CHECKOUT_LIFETIME_MS) / 1000),
  }, input.signal ? { signal: input.signal } : {});
  return { topup, checkoutUrl: session.url };
}
