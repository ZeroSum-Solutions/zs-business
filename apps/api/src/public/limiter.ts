// public-intake.md P-10: fixed-window counters in process memory. A request names every bucket
// it touches; all are checked before any is charged, so a refused request consumes nothing.
// A multi-instance deploy (M2b) swaps this for a shared store behind the same interface.

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
export interface RateLimiter {
  take(charges: readonly Charge[]): TakeResult;
}

/** Above this many buckets, expired ones are swept before the next charge. */
const SWEEP_AT = 10_000;

export function createMemoryRateLimiter(clock: { now(): Date }): RateLimiter {
  const buckets = new Map<string, { windowStart: number; windowMs: number; count: number }>();
  const live = (bucket: { windowStart: number; windowMs: number } | undefined, now: number) =>
    bucket !== undefined && now - bucket.windowStart < bucket.windowMs;
  return {
    take(charges) {
      const now = clock.now().getTime();
      if (buckets.size > SWEEP_AT)
        for (const [key, bucket] of buckets) if (!live(bucket, now)) buckets.delete(key);
      let retryAfterMs = 0;
      for (const { key, rule } of charges) {
        const bucket = buckets.get(key);
        if (live(bucket, now) && bucket!.count >= rule.limit)
          retryAfterMs = Math.max(retryAfterMs, bucket!.windowStart + bucket!.windowMs - now);
      }
      if (retryAfterMs > 0) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      for (const { key, rule } of charges) {
        const bucket = buckets.get(key);
        if (live(bucket, now)) bucket!.count += 1;
        else buckets.set(key, { windowStart: now, windowMs: rule.windowMs, count: 1 });
      }
      return { ok: true };
    },
  };
}
