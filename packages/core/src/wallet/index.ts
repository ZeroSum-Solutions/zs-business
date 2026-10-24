// M3d prepaid wallet (delivery.md D-4, D-5, D-8, D-11). Original code. Every function runs inside
// a service-role transaction the caller owns and names tenant_id in each statement. Lock order
// is the job's own row (reservation only), then the reservation row, then the wallet row, so
// settlement and reservation never wait on each other in opposite orders; a credit locks only
// the wallet row.
import { Conflict, ValidationFailed, walletJobKindSchema, type WalletJobKind, type WalletSummary } from "@zs/contracts";
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
 * Locks the row of one job in its own table under the tenant (`FOR UPDATE`); false when the row is
 * absent. Taken before the wallet row, like the delivery worker's own lease lock, so a job is
 * never reserved or settled while another transaction changes it.
 */
export type JobLock = (tx: Transaction, tenantId: string, jobId: string) => Promise<boolean>;

/** D-11: which table holds each kind's jobs. A kind without an entry cannot reserve yet. */
export type JobRegistry = Readonly<Partial<Record<WalletJobKind, JobLock>>>;

/** A lock for a job table with `tenant_id` and `id` columns; the name is a fixed identifier. */
export function jobRowLock(table: string): JobLock {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(table)) throw new ValidationFailed("Invalid job table name");
  const sql = `SELECT 1 FROM public.${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`;
  return async (tx, tenantId, jobId) => (await tx.query(sql, [tenantId, jobId])).rowCount === 1;
}

/**
 * Only message deliveries have a job table today. Each priced feature adds its kind here when its
 * contract names the table (enrichment.md, image-port.md, voice-receptionist.md, browser-tasks.md).
 */
export const DEFAULT_JOB_REGISTRY: JobRegistry = Object.freeze({
  message_delivery: jobRowLock("message_deliveries"),
  image_job: jobRowLock("image_variants"),
  enrichment: jobRowLock("enrichment_requests"),
});

export interface ReserveForJobInput {
  readonly tenantId: string;
  readonly jobKind: WalletJobKind;
  readonly jobId: string;
  readonly reservationId: string;
  readonly amount: number;
  /** A price in another currency than the wallet's is never covered. */
  readonly currency: string;
  readonly now: Date;
}

/**
 * D-5, D-11: holds `amount` for one priced job, or returns null when the wallet cannot cover it
 * (no wallet, too little available, another currency, or money owed after a refund or dispute,
 * stripe.md S-6). The job then makes no vendor call. Runs in the transaction that starts the job's
 * attempt, as the service role only (runtime roles cannot write the wallet, D-4).
 *
 * Locks the job's own row first and refuses `job_not_found` when it is absent under the tenant.
 * Then one conditional UPDATE takes the wallet row lock; a concurrent reservation, of any kind,
 * waits for it and re-reads the committed balance, so two reservations can never spend the same
 * funds. The table constraints refuse any overdraw even if this condition were wrong, and the
 * partial unique index refuses a second hold for the same job.
 */
export async function reserveForJob(
  tx: Transaction,
  input: ReserveForJobInput,
  registry: JobRegistry = DEFAULT_JOB_REGISTRY,
): Promise<Reservation | null> {
  const kind = walletJobKindSchema.safeParse(input.jobKind);
  if (!kind.success) throw new ValidationFailed("Unknown wallet job kind");
  const jobKind = kind.data;
  const amount = positiveAmount(input.amount);
  const lockJob = registry[jobKind];
  if (!lockJob)
    throw new Conflict("No job table is registered for this wallet job kind", { reason: "job_kind_unavailable", jobKind });
  if (!(await lockJob(tx, input.tenantId, input.jobId)))
    throw new Conflict("The job does not exist for this tenant", { reason: "job_not_found", jobKind });
  const reserved = await tx.query(
    `UPDATE wallets SET reserved = reserved + $2, updated_at = $3
      WHERE tenant_id=$1 AND balance - reserved >= $2 AND currency = $4 AND owed = 0`,
    [input.tenantId, amount, input.now, input.currency]);
  if (reserved.rowCount !== 1) return null;
  await tx.query(
    `INSERT INTO wallet_reservations (tenant_id, id, job_kind, job_id, delivery_id, amount, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'held',$7)`,
    [input.tenantId, input.reservationId, jobKind, input.jobId, jobKind === "message_delivery" ? input.jobId : null, amount, input.now]);
  return { id: input.reservationId, amount };
}

/** D-5: holds `amount` for one delivery; the delivery worker's entry to `reserveForJob`. */
export async function reserveFunds(tx: Transaction, input: {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly reservationId: string;
  readonly amount: number;
  /** A price in another currency than the wallet's is never covered. */
  readonly currency?: string;
  readonly now: Date;
}): Promise<Reservation | null> {
  return reserveForJob(tx, {
    tenantId: input.tenantId, jobKind: "message_delivery", jobId: input.deliveryId, reservationId: input.reservationId,
    amount: input.amount, currency: input.currency ?? "usd", now: input.now,
  });
}

/** The reservation a job still holds, if any (at most one, by a partial unique index). */
export async function heldReservationForJob(
  tx: Transaction, tenantId: string, jobKind: WalletJobKind, jobId: string,
): Promise<Reservation | null> {
  const row = (await tx.query<{ id: string; amount: string }>(
    "SELECT id, amount FROM wallet_reservations WHERE tenant_id=$1 AND job_kind=$2 AND job_id=$3 AND status='held' FOR UPDATE",
    [tenantId, jobKind, jobId])).rows[0];
  return row ? { id: row.id, amount: minorUnits(row.amount) } : null;
}

/** The reservation a delivery still holds, if any. */
export function heldReservation(tx: Transaction, tenantId: string, deliveryId: string): Promise<Reservation | null> {
  return heldReservationForJob(tx, tenantId, "message_delivery", deliveryId);
}

/**
 * D-8, D-11: settles a held reservation exactly once. The status test makes a second settlement a
 * no-op ("already_settled"); the partial unique indexes refuse a second capture for the same job
 * or reservation even if two settlements raced.
 *
 * Captures `amount` (the real cost) when given, else the whole hold, and returns the remainder to
 * available in the same transaction: the wallet's `reserved` drops by the whole hold, its
 * `balance` by the captured amount. An amount above the hold is refused (`capture_exceeds_hold`)
 * before anything is written. The one ledger row is keyed `capture:<reservationId>`. A job that
 * cost nothing releases its hold instead: a ledger row cannot be zero (`wallet_ledger_amount_nonzero`).
 */
export async function captureReservation(tx: Transaction, input: {
  readonly tenantId: string;
  readonly reservationId: string;
  readonly ledgerId: string;
  readonly amount?: number;
  readonly now: Date;
}): Promise<"captured" | "already_settled"> {
  const requested = input.amount === undefined ? undefined : positiveAmount(input.amount);
  const row = (await tx.query<{ amount: string }>(
    "SELECT amount FROM wallet_reservations WHERE tenant_id=$1 AND id=$2 AND status='held' FOR UPDATE",
    [input.tenantId, input.reservationId])).rows[0];
  if (!row) return "already_settled";
  const held = minorUnits(row.amount);
  const captured = requested ?? held;
  if (captured > held)
    throw new Conflict("A capture cannot exceed the held amount", { reason: "capture_exceeds_hold", held, requested: captured });
  await tx.query(
    "UPDATE wallet_reservations SET status='captured', settled_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='held'",
    [input.tenantId, input.reservationId, input.now]);
  await tx.query(
    "UPDATE wallets SET balance = balance - $2, reserved = reserved - $3, updated_at = $4 WHERE tenant_id=$1",
    [input.tenantId, captured, held, input.now]);
  await tx.query(
    `INSERT INTO wallet_ledger (tenant_id, id, kind, amount, reservation_id, idempotency_key, created_at)
     VALUES ($1,$2,'capture',$3,$4,$5,$6)`,
    [input.tenantId, input.ledgerId, -captured, input.reservationId, `capture:${input.reservationId}`, input.now]);
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

/** D-11: a hold older than this, by the injected clock, is reported as stale. */
export const STALE_HOLD_MS = 24 * 60 * 60 * 1000;

export interface StaleHold {
  readonly code: "stale_hold";
  readonly tenantId: string;
  readonly jobKind: WalletJobKind;
  readonly jobId: string;
  readonly reservationId: string;
  readonly amount: number;
  /** When the hold was made. */
  readonly heldSince: Date;
}

/**
 * D-11: reports `held` reservations older than 24 hours by `now` (the injected clock), oldest
 * first, across tenants (the service role). It reads only: it never captures or releases a hold,
 * because an unknown outcome stays held until the job's own lookup or an operator settles it
 * (D-7, D-8). A long list is read a page at a time: pass the last report of the previous page as
 * `after` (the order is `created_at`, `tenant_id`, reservation id).
 */
export async function findStaleHolds(tx: Transaction, input: {
  readonly now: Date;
  readonly limit?: number;
  readonly after?: StaleHold;
}): Promise<StaleHold[]> {
  const limit = input.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new ValidationFailed("Limit must be between 1 and 10000");
  const after = input.after;
  const rows = (await tx.query<{ tenant_id: string; job_kind: WalletJobKind; job_id: string; id: string; amount: string; created_at: Date }>(
    `SELECT tenant_id, job_kind, job_id, id, amount, created_at FROM wallet_reservations
      WHERE status='held' AND created_at < $1 AND ($3::timestamptz IS NULL OR (created_at, tenant_id, id) > ($3, $4::uuid, $5::uuid))
      ORDER BY created_at, tenant_id, id LIMIT $2`,
    [new Date(input.now.getTime() - STALE_HOLD_MS), limit, after?.heldSince ?? null, after?.tenantId ?? null, after?.reservationId ?? null])).rows;
  return rows.map((row) => ({
    code: "stale_hold", tenantId: row.tenant_id, jobKind: row.job_kind, jobId: row.job_id,
    reservationId: row.id, amount: minorUnits(row.amount), heldSince: row.created_at,
  }));
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
