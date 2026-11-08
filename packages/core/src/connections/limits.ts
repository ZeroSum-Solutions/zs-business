// Connections C-4, C-5, C-12: the limits the API charges before it calls the worker. They use the
// API's shared rate-limit store (apps/api/src/public/limiter.ts), reached through this structural
// port so core does not import the app. The worker's own budget, `composio-org:<env>`, is in
// worker.ts: the worker's login cannot reach this store.
export interface ConnectionRateRule {
  readonly limit: number;
  readonly windowMs: number;
}
export interface ConnectionCharge {
  readonly key: string;
  readonly rule: ConnectionRateRule;
}
export type ConnectionTake = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };
export interface ConnectionTakeOptions { readonly signal?: AbortSignal; readonly remainingMs?: () => number }
/** Names one accepted charge, for a refund (C-4). */
export interface ConnectionReceipt { readonly id: string }
export type ConnectionTakeReceipt = { readonly ok: true; readonly receipt: ConnectionReceipt } | { readonly ok: false; readonly retryAfterSeconds: number };
/** C-4: what became of a connect refund. Never a receipt ID, an address or provider text. */
export interface ConnectionsQuotaReport {
  readonly kind: "connect_refund";
  readonly tenantId: string;
  readonly outcome: "refunded" | "no_receipt" | "capped" | "nothing_to_give" | "failed";
}
export interface ConnectionLimiter {
  take(charges: readonly ConnectionCharge[], options?: ConnectionTakeOptions): Promise<ConnectionTake>;
  /** C-4: `take` that also returns the charge's receipt. A limiter without it never refunds. */
  takeWithReceipt?(charges: readonly ConnectionCharge[], options?: ConnectionTakeOptions): Promise<ConnectionTakeReceipt>;
  /** C-4: gives the receipt's charge back, once, in the window it was taken in; see the shared limiter. */
  refund?(receipt: ConnectionReceipt, options?: ConnectionTakeOptions): Promise<number>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const CONNECTION_LIMITS = Object.freeze({
  /** C-4: connects started per tenant. */
  connect: { limit: 10, windowMs: HOUR },
  /**
   * C-4: connect charges a tenant may get back per hour. Each refund still spent a unit of the shared Composio
   * org budget, so refunds are capped apart from the charge: a tenant makes at most `connect + connectRefund`
   * link attempts an hour, however many refusals it provokes. A refund that finds this bucket full is not made.
   */
  connectRefund: { limit: 3, windowMs: HOUR },
  /** C-5: callbacks that reach the worker per tenant. */
  callback: { limit: 30, windowMs: HOUR },
  /** The status call: its own tenant bucket keeps it from starving callbacks. */
  callbackStatus: { limit: 120, windowMs: HOUR },
  /** C-5: at most 5 status calls per attempt, over more than the attempt's 10 minute life. */
  callbackStatusAttempt: { limit: 5, windowMs: HOUR },
  /** C-12: tool runs per tenant. */
  runMinute: { limit: 60, windowMs: MINUTE },
  runDay: { limit: 2000, windowMs: DAY },
});

export const connectCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-connect:${tenantId}`, rule: CONNECTION_LIMITS.connect }];
/** C-4: the tenant's refund allowance, charged before a connect refund is made. */
export const connectRefundCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-connect-refund:${tenantId}`, rule: CONNECTION_LIMITS.connectRefund }];
export const callbackCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-callback:${tenantId}`, rule: CONNECTION_LIMITS.callback }];
/** C-5, C-12: a status call reads Composio, so it also spends the tenant's run buckets. */
export const callbackStatusCharges = (tenantId: string, attemptId: string): ConnectionCharge[] => [
  { key: `conn-status:${tenantId}`, rule: CONNECTION_LIMITS.callbackStatus },
  { key: `conn-status-attempt:${attemptId}`, rule: CONNECTION_LIMITS.callbackStatusAttempt },
  { key: `conn-minute:${tenantId}`, rule: CONNECTION_LIMITS.runMinute },
  { key: `conn-day:${tenantId}`, rule: CONNECTION_LIMITS.runDay },
];
/** C-12: one unit in each of the two run buckets, all or nothing. */
export const runCharges = (tenantId: string): ConnectionCharge[] => [
  { key: `conn-minute:${tenantId}`, rule: CONNECTION_LIMITS.runMinute },
  { key: `conn-day:${tenantId}`, rule: CONNECTION_LIMITS.runDay },
];
