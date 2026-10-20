// M3d prepaid wallet (delivery.md D-4, D-5, D-8). Original code. Every function runs inside a
// service-role transaction the caller owns and names tenant_id in each statement. Lock order
// is reservation row, then wallet row, so settlement and reservation never wait on each other
// in opposite orders; a credit locks only the wallet row.
import { Conflict, ValidationFailed, type WalletSummary } from "@zs/contracts";
import type { Transaction } from "@zs/db";

/** Minor units travel as bigint text from Postgres; every amount here fits a safe integer. */
export function minorUnits(value: string | number): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(amount)) throw new ValidationFailed("Amount is outside the safe integer range");
  return amount;
}

function positiveAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ValidationFailed("Amount must be a positive whole number of minor units");
  return amount;
}

/** The tenant's wallet; a tenant that never had a credit has an empty one. */
export async function getWallet(tx: Transaction, tenantId: string, currency = "usd"): Promise<WalletSummary> {
  const row = (await tx.query<{ currency: string; balance: string; reserved: string }>(
    "SELECT currency, balance, reserved FROM wallets WHERE tenant_id=$1", [tenantId])).rows[0];
  if (!row) return { currency, balance: 0, reserved: 0, available: 0 };
  const balance = minorUnits(row.balance);
  const reserved = minorUnits(row.reserved);
  return { currency: row.currency, balance, reserved, available: balance - reserved };
}

export interface CreditInput {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly amount: number;
  /** One credit per key: a retried top-up webhook applies once. */
  readonly idempotencyKey: string;
  readonly note?: string;
  readonly currency?: string;
  readonly now: Date;
}

/**
 * Adds funds (a top-up). Creates the wallet on first use. A repeat of the same key with the
 * same amount returns the stored credit; another amount under that key is a conflict.
 */
export async function creditWallet(tx: Transaction, input: CreditInput): Promise<{ applied: boolean; wallet: WalletSummary }> {
  const amount = positiveAmount(input.amount);
  const currency = input.currency ?? "usd";
  await tx.query(
    "INSERT INTO wallets (tenant_id, currency, updated_at) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO NOTHING",
    [input.tenantId, currency, input.now]);
  const wallet = (await tx.query<{ currency: string }>(
    "SELECT currency FROM wallets WHERE tenant_id=$1 FOR UPDATE", [input.tenantId])).rows[0]!;
  if (wallet.currency !== currency) throw new Conflict("The wallet holds another currency", { reason: "currency_mismatch" });
  const inserted = await tx.query(
    `INSERT INTO wallet_ledger (tenant_id, id, kind, amount, idempotency_key, note, created_at)
     VALUES ($1,$2,'credit',$3,$4,$5,$6) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [input.tenantId, input.ledgerId, amount, input.idempotencyKey, input.note ?? null, input.now]);
  if (inserted.rowCount === 0) {
    const stored = (await tx.query<{ kind: string; amount: string }>(
      "SELECT kind, amount FROM wallet_ledger WHERE tenant_id=$1 AND idempotency_key=$2",
      [input.tenantId, input.idempotencyKey])).rows[0]!;
    if (stored.kind !== "credit" || minorUnits(stored.amount) !== amount)
      throw new Conflict("The credit key was used with another amount", { reason: "idempotency_conflict" });
    return { applied: false, wallet: await getWallet(tx, input.tenantId) };
  }
  await tx.query("UPDATE wallets SET balance = balance + $2, updated_at = $3 WHERE tenant_id=$1",
    [input.tenantId, amount, input.now]);
  return { applied: true, wallet: await getWallet(tx, input.tenantId) };
}

export interface Reservation {
  readonly id: string;
  readonly amount: number;
}

/**
 * D-5: holds `amount` for one delivery, or returns null when the wallet cannot cover it (no
 * wallet, too little available, another currency, or money owed after a refund or dispute,
 * stripe.md S-6). The
 * conditional UPDATE takes the wallet row lock; a concurrent reservation waits for it and then
 * re-reads the committed balance, so two reservations can never spend the same funds. The
 * table constraints refuse any overdraw even if this condition were wrong.
 */
export async function reserveFunds(tx: Transaction, input: {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly reservationId: string;
  readonly amount: number;
  /** A price in another currency than the wallet's is never covered. */
  readonly currency?: string;
  readonly now: Date;
}): Promise<Reservation | null> {
  const amount = positiveAmount(input.amount);
  const reserved = await tx.query(
    `UPDATE wallets SET reserved = reserved + $2, updated_at = $3
      WHERE tenant_id=$1 AND balance - reserved >= $2 AND currency = $4 AND owed = 0`,
    [input.tenantId, amount, input.now, input.currency ?? "usd"]);
  if (reserved.rowCount !== 1) return null;
  await tx.query(
    `INSERT INTO wallet_reservations (tenant_id, id, delivery_id, amount, status, created_at)
     VALUES ($1,$2,$3,$4,'held',$5)`,
    [input.tenantId, input.reservationId, input.deliveryId, amount, input.now]);
  return { id: input.reservationId, amount };
}

/** The reservation a delivery still holds, if any (at most one, by a partial unique index). */
export async function heldReservation(tx: Transaction, tenantId: string, deliveryId: string): Promise<Reservation | null> {
  const row = (await tx.query<{ id: string; amount: string }>(
    "SELECT id, amount FROM wallet_reservations WHERE tenant_id=$1 AND delivery_id=$2 AND status='held' FOR UPDATE",
    [tenantId, deliveryId])).rows[0];
  return row ? { id: row.id, amount: minorUnits(row.amount) } : null;
}

/**
 * D-8: settles a held reservation exactly once. The status test makes a second settlement a
 * no-op ("already_settled"); the partial unique indexes refuse a second capture for the same
 * delivery or reservation even if two settlements raced.
 */
export async function captureReservation(tx: Transaction, input: {
  readonly tenantId: string;
  readonly reservationId: string;
  readonly ledgerId: string;
  readonly now: Date;
}): Promise<"captured" | "already_settled"> {
  const row = (await tx.query<{ amount: string }>(
    `UPDATE wallet_reservations SET status='captured', settled_at=$3
      WHERE tenant_id=$1 AND id=$2 AND status='held' RETURNING amount`,
    [input.tenantId, input.reservationId, input.now])).rows[0];
  if (!row) return "already_settled";
  const amount = minorUnits(row.amount);
  await tx.query(
    "UPDATE wallets SET balance = balance - $2, reserved = reserved - $2, updated_at = $3 WHERE tenant_id=$1",
    [input.tenantId, amount, input.now]);
  await tx.query(
    `INSERT INTO wallet_ledger (tenant_id, id, kind, amount, reservation_id, idempotency_key, created_at)
     VALUES ($1,$2,'capture',$3,$4,$5,$6)`,
    [input.tenantId, input.ledgerId, -amount, input.reservationId, `capture:${input.reservationId}`, input.now]);
  return "captured";
}

/** Returns held funds to the available balance, once; a settled reservation stays as it is. */
export async function releaseReservation(tx: Transaction, input: {
  readonly tenantId: string;
  readonly reservationId: string;
  readonly now: Date;
}): Promise<"released" | "already_settled"> {
  const row = (await tx.query<{ amount: string }>(
    `UPDATE wallet_reservations SET status='released', settled_at=$3
      WHERE tenant_id=$1 AND id=$2 AND status='held' RETURNING amount`,
    [input.tenantId, input.reservationId, input.now])).rows[0];
  if (!row) return "already_settled";
  await tx.query("UPDATE wallets SET reserved = reserved - $2, updated_at = $3 WHERE tenant_id=$1",
    [input.tenantId, minorUnits(row.amount), input.now]);
  return "released";
}

/**
 * stripe.md S-6: takes `amount` back without going negative. What is available (balance minus
 * reserved) is debited now with one `adjustment` ledger row; the rest is added to `owed`.
 * Reservations stay covered. The caller records the event once (wallet_billing_events).
 */
export async function debitWallet(tx: Transaction, input: {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly note?: string;
  readonly now: Date;
}): Promise<{ applied: number; owed: number }> {
  const amount = positiveAmount(input.amount);
  await tx.query(
    "INSERT INTO wallets (tenant_id, updated_at) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING", [input.tenantId, input.now]);
  const wallet = (await tx.query<{ balance: string; reserved: string }>(
    "SELECT balance, reserved FROM wallets WHERE tenant_id=$1 FOR UPDATE", [input.tenantId])).rows[0]!;
  const available = minorUnits(wallet.balance) - minorUnits(wallet.reserved);
  const applied = Math.max(0, Math.min(amount, available));
  if (applied > 0)
    await tx.query(
      `INSERT INTO wallet_ledger (tenant_id, id, kind, amount, idempotency_key, note, created_at)
       VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
      [input.tenantId, input.ledgerId, -applied, input.idempotencyKey, input.note ?? null, input.now]);
  await tx.query("UPDATE wallets SET balance = balance - $2, owed = owed + $3, updated_at = $4 WHERE tenant_id=$1",
    [input.tenantId, applied, amount - applied, input.now]);
  return { applied, owed: amount - applied };
}

/** S-6: pays what the wallet owes from what is available, with one `adjustment` row. */
export async function repayOwed(tx: Transaction, input: {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly now: Date;
}): Promise<number> {
  const wallet = (await tx.query<{ balance: string; reserved: string; owed: string }>(
    "SELECT balance, reserved, owed FROM wallets WHERE tenant_id=$1 FOR UPDATE", [input.tenantId])).rows[0];
  if (!wallet) return 0;
  const repay = Math.min(minorUnits(wallet.owed), minorUnits(wallet.balance) - minorUnits(wallet.reserved));
  if (repay <= 0) return 0;
  await tx.query(
    `INSERT INTO wallet_ledger (tenant_id, id, kind, amount, idempotency_key, note, created_at)
     VALUES ($1,$2,'adjustment',$3,$4,'repay owed',$5)`,
    [input.tenantId, input.ledgerId, -repay, `repay:${input.ledgerId}`, input.now]);
  await tx.query("UPDATE wallets SET balance = balance - $2, owed = owed - $2, updated_at = $3 WHERE tenant_id=$1",
    [input.tenantId, repay, input.now]);
  return repay;
}
