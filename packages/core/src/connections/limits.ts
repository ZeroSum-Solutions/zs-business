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
export interface ConnectionLimiter {
  take(charges: readonly ConnectionCharge[], options?: { readonly signal?: AbortSignal; readonly remainingMs?: () => number }): Promise<ConnectionTake>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const CONNECTION_LIMITS = Object.freeze({
  /** C-4: connects started per tenant. */
  connect: { limit: 10, windowMs: HOUR },
  /** C-5: callbacks that reach the worker per tenant. */
  callback: { limit: 30, windowMs: HOUR },
  /** The status call repeats the account read at most 5 times per attempt; its own bucket keeps it from starving callbacks. */
  callbackStatus: { limit: 120, windowMs: HOUR },
  /** C-12: tool runs per tenant. */
  runMinute: { limit: 60, windowMs: MINUTE },
  runDay: { limit: 2000, windowMs: DAY },
});

export const connectCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-connect:${tenantId}`, rule: CONNECTION_LIMITS.connect }];
export const callbackCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-callback:${tenantId}`, rule: CONNECTION_LIMITS.callback }];
export const callbackStatusCharges = (tenantId: string): ConnectionCharge[] =>
  [{ key: `conn-status:${tenantId}`, rule: CONNECTION_LIMITS.callbackStatus }];
/** C-12: one unit in each of the two run buckets, all or nothing. */
export const runCharges = (tenantId: string): ConnectionCharge[] => [
  { key: `conn-minute:${tenantId}`, rule: CONNECTION_LIMITS.runMinute },
  { key: `conn-day:${tenantId}`, rule: CONNECTION_LIMITS.runDay },
];
