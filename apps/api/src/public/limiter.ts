// public-intake.md P-10: fixed-window counters. A request names every bucket it touches; all
// are checked before any is charged, so a refused request consumes nothing. The in-memory
// limiter counts per process; a multi-instance deploy uses the shared Postgres one
// (postgres-limiter.ts) behind the same interface.

export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}
export interface RateLimits {
  readonly addressWrites: RateLimit;
  readonly addressReads: RateLimit;
  readonly tenantWrites: RateLimit;
}
export const DEFAULT_RATE_LIMITS: RateLimits = {
  addressWrites: { limit: 10, windowMs: 10 * 60_000 },
  addressReads: { limit: 300, windowMs: 10 * 60_000 },
  tenantWrites: { limit: 200, windowMs: 60 * 60_000 },
};

export interface Charge {
  readonly key: string;
  readonly rule: RateLimit;
}
export type TakeResult = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };
/** The request's deadline, for a limiter that waits on a shared store. */
export interface TakeOptions {
  readonly signal?: AbortSignal;
  readonly remainingMs?: () => number;
}
/**
 * Names one accepted charge, for a refund (connections.md C-4). Opaque to the caller: the shared store keeps
 * the buckets and windows it charged, and consumes the receipt on its first refund.
 */
export interface ChargeReceipt {
  readonly id: string;
}
export type TakeReceiptResult = { readonly ok: true; readonly receipt: ChargeReceipt } | { readonly ok: false; readonly retryAfterSeconds: number };
export interface RateLimiter {
  take(charges: readonly Charge[], options?: TakeOptions): Promise<TakeResult>;
  /** Like `take`, and an accepted charge returns its receipt. A refusal charges nothing. */
  takeWithReceipt?(charges: readonly Charge[], options?: TakeOptions): Promise<TakeReceiptResult>;
  /**
   * Gives back the units the receipt's charge took, in the windows it took them in, at most once per receipt
   * (a repeat does nothing). A window that has ended or reopened since is left alone, and no count goes below
   * zero. Returns how many buckets got a unit back.
   */
  refund?(receipt: ChargeReceipt, options?: TakeOptions): Promise<number>;
}

/** Whole seconds a refused caller waits, at least one. */
export const retryAfterSeconds = (retryAfterMs: number) => Math.max(1, Math.ceil(retryAfterMs / 1000));

/** Above this many buckets, expired ones are swept before the next charge. */
const SWEEP_AT = 10_000;

export function createMemoryRateLimiter(clock: { now(): Date }): RateLimiter {
  const buckets = new Map<string, { windowStart: number; windowMs: number; count: number }>();
  const receipts = new Map<string, { key: string; windowStart: number }[]>();
  let nextReceipt = 0;
  const live = (bucket: { windowStart: number; windowMs: number } | undefined, now: number) =>
    bucket !== undefined && now - bucket.windowStart < bucket.windowMs;
  const take = (charges: readonly Charge[]): TakeResult => {
    const now = clock.now().getTime();
    if (buckets.size > SWEEP_AT)
      for (const [key, bucket] of buckets) if (!live(bucket, now)) buckets.delete(key);
    let retryAfterMs = 0;
    for (const { key, rule } of charges) {
      const bucket = buckets.get(key);
      if (live(bucket, now) && bucket!.count >= rule.limit)
        retryAfterMs = Math.max(retryAfterMs, bucket!.windowStart + bucket!.windowMs - now);
    }
    if (retryAfterMs > 0) return { ok: false, retryAfterSeconds: retryAfterSeconds(retryAfterMs) };
    for (const { key, rule } of charges) {
      const bucket = buckets.get(key);
      if (live(bucket, now)) bucket!.count += 1;
      else buckets.set(key, { windowStart: now, windowMs: rule.windowMs, count: 1 });
    }
    return { ok: true };
  };
  return {
    async take(charges) {
      return take(charges);
    },
    async takeWithReceipt(charges) {
      const taken = take(charges);
      if (!taken.ok) return taken;
      const id = `memory-receipt-${nextReceipt++}`;
      receipts.set(id, charges.map(({ key }) => ({ key, windowStart: buckets.get(key)!.windowStart })));
      return { ok: true, receipt: { id } };
    },
    async refund(receipt) {
      const windows = receipts.get(receipt.id);
      if (!windows) return 0;
      receipts.delete(receipt.id);
      const now = clock.now().getTime();
      let given = 0;
      for (const { key, windowStart } of windows) {
        const bucket = buckets.get(key);
        if (bucket && live(bucket, now) && bucket.windowStart === windowStart && bucket.count > 0) {
          bucket.count -= 1;
          given += 1;
        }
      }
      return given;
    },
  };
}
