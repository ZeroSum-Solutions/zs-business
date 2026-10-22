// M5 wallet top-ups (docs/requirements/stripe.md S-1, S-2). Original code. The action records a
// pending top-up under the member's key, with the Checkout parameters that come from config; the
// Checkout Session is asked for after it commits, under a key derived from the top-up, so a retry
// replays both.
import {
  Conflict,
  createTopUpCommandSchema,
  NotFound,
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
import type { CheckoutSessionRequest, StripeClient } from "./stripe.js";
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

/**
 * S-1: the server's top-up terms. They reach the handler as dispatch config, never in the stored
 * payload, so a caller cannot choose them and a retry after a change replays the first request.
 */
export interface TopUpTerms {
  readonly currency: string;
  readonly minAmount: number;
  readonly maxAmount: number;
  /** S-2: stored with the top-up, so every Checkout request for it is the first one. */
  readonly checkout: CheckoutTerms;
}
export type CheckoutTerms = Pick<CheckoutSessionRequest, "successUrl" | "cancelUrl" | "productName">;
export type TopUpDispatchConfig = { readonly topUp?: TopUpTerms };

export const createTopUpHandler: ActionHandler<TopUpDispatchConfig> = {
  async resolveTarget(tx, target) {
    if (target.type !== "wallet_topup") throw new ValidationFailed("Top-ups require a wallet_topup target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    return { tenantId, type: "wallet_topup", id: target.id };
  },
  async handle({ tx, command, binding, now, config }) {
    const { payload } = parseOrFail(createTopUpCommandSchema, command);
    if (command.target.id !== payload.topupId) throw new ValidationFailed("Target must name the top-up");
    // Only the member session's top-up route passes the terms; nothing else may create one.
    const terms = config.topUp;
    if (!terms) throw new NotFound();
    if (payload.amount < terms.minAmount || payload.amount > terms.maxAmount)
      throw new ValidationFailed(`Top-ups are between ${terms.minAmount} and ${terms.maxAmount} minor units`);
    // A wallet's currency is fixed by its first credit; a payment in another could never be credited.
    const wallet = (await tx.query<{ currency: string }>("SELECT currency FROM wallets WHERE tenant_id=$1", [binding.tenantId])).rows[0];
    if (wallet && wallet.currency !== terms.currency)
      throw new Conflict("The wallet holds another currency than top-ups are taken in", { reason: "wallet_currency" });
    const row = (await tx.query<TopUpRow>(
      `INSERT INTO wallet_topups (tenant_id, id, amount, currency, created_by, created_at, updated_at,
         checkout_success_url, checkout_cancel_url, checkout_product_name)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) RETURNING ${TOPUP_COLUMNS}`,
      [binding.tenantId, payload.topupId, payload.amount, terms.currency, binding.actorId, now,
        terms.checkout.successUrl, terms.checkout.cancelUrl, terms.checkout.productName])).rows[0]!;
    return { result: { ...topUpFromRow(row) } };
  },
};

export const topUpHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [WALLET_TOPUP_CREATE_ACTION]: createTopUpHandler as ActionHandler,
});

export async function getTopUp(tx: Transaction, tenantId: string, topupId: string): Promise<TopUp | null> {
  const row = (await tx.query<TopUpRow>(
    `SELECT ${TOPUP_COLUMNS} FROM wallet_topups WHERE tenant_id=$1 AND id=$2`, [tenantId, topupId])).rows[0];
  return row ? topUpFromRow(row) : null;
}

export interface TopUpForCheckout {
  readonly topup: TopUp;
  /** The wallet's currency now (null before the first credit). */
  readonly walletCurrency: string | null;
  /** S-2: the stored Checkout parameters; null for a top-up stored before they were. */
  readonly checkout: CheckoutTerms | null;
  /** S-2: the session URL Stripe answered, once one was stored. */
  readonly checkoutUrl: string | null;
}

/** A stored top-up with what its Checkout request needs. */
export async function getTopUpForCheckout(tx: Transaction, tenantId: string, topupId: string): Promise<TopUpForCheckout | null> {
  const row = (await tx.query<TopUpRow & {
    wallet_currency: string | null;
    checkout_success_url: string | null;
    checkout_cancel_url: string | null;
    checkout_product_name: string | null;
    checkout_url: string | null;
  }>(
    `SELECT ${TOPUP_COLUMNS.split(",").map((column) => `t.${column.trim()}`).join(", ")}, w.currency AS wallet_currency,
            t.checkout_success_url, t.checkout_cancel_url, t.checkout_product_name, t.checkout_url
       FROM wallet_topups t LEFT JOIN wallets w ON w.tenant_id=t.tenant_id
      WHERE t.tenant_id=$1 AND t.id=$2`, [tenantId, topupId])).rows[0];
  if (!row) return null;
  // The migration's check keeps the three set or unset together.
  const checkout = row.checkout_success_url !== null && row.checkout_cancel_url !== null && row.checkout_product_name !== null
    ? { successUrl: row.checkout_success_url, cancelUrl: row.checkout_cancel_url, productName: row.checkout_product_name }
    : null;
  return { topup: topUpFromRow(row), walletCurrency: row.wallet_currency, checkout, checkoutUrl: row.checkout_url };
}

/** S-2: records the session URL Stripe answered; the first one stays. */
export async function rememberCheckoutUrl(tx: Transaction, tenantId: string, topupId: string, url: string): Promise<void> {
  await tx.query("UPDATE wallet_topups SET checkout_url=$3 WHERE tenant_id=$1 AND id=$2 AND checkout_url IS NULL", [tenantId, topupId, url]);
}

export async function listTopUps(tx: Transaction, tenantId: string, limit = 20): Promise<TopUp[]> {
  return (await tx.query<TopUpRow>(
    `SELECT ${TOPUP_COLUMNS} FROM wallet_topups WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT $2`,
    [tenantId, limit])).rows.map(topUpFromRow);
}

/**
 * S-1, S-2: runs the action, then asks Stripe for the session with the stored parameters and
 * records its URL. `read` loads the stored top-up (a replayed action returns the first result,
 * whose status may since have moved on); a retry after the URL was recorded returns it.
 */
export async function startTopUp(input: {
  readonly command: ActionCommand;
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
  readonly read: (topupId: string) => Promise<TopUpForCheckout | null>;
  readonly remember: (topupId: string, url: string) => Promise<void>;
  readonly stripe: StripeClient;
  readonly tenantId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
}): Promise<{ topup: TopUp; checkoutUrl: string }> {
  const parsed = parseOrFail(createTopUpCommandSchema, input.command);
  await input.dispatch(parsed);
  const found = await input.read(parsed.payload.topupId);
  if (!found) throw new Conflict("The top-up is not available", { reason: "topup_closed" });
  const { topup } = found;
  const createdAt = Date.parse(topup.createdAt);
  if (topup.status !== "pending" || input.now.getTime() - createdAt > CHECKOUT_RETRY_LIMIT_MS)
    throw new Conflict("The top-up can no longer be paid; start a new one", { reason: "topup_closed" });
  // S-1: checked again before every Stripe call, a replay included: the wallet may have been
  // created in another currency since this top-up was stored, and its payment could never be credited.
  if (found.walletCurrency !== null && found.walletCurrency !== topup.currency)
    throw new Conflict("The wallet holds another currency than this top-up", { reason: "wallet_currency" });
  if (found.checkoutUrl !== null) return { topup, checkoutUrl: found.checkoutUrl };
  const { successUrl, cancelUrl, productName } = found.checkout ?? input.stripe.config;
  const session = await input.stripe.createCheckoutSession({
    tenantId: input.tenantId,
    topupId: topup.id,
    amount: topup.amount,
    currency: topup.currency,
    successUrl,
    cancelUrl,
    productName,
    expiresAt: Math.floor((createdAt + CHECKOUT_LIFETIME_MS) / 1000),
  }, input.signal ? { signal: input.signal } : {});
  await input.remember(topup.id, session.url);
  return { topup, checkoutUrl: session.url };
}
