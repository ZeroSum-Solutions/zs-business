/**
 * In-memory rate limits for sign-in requests: enough for one dashboard server. Every request
 * for a sign-in link is reserved before its body is read and counts against the caller's
 * address (see clientAddress) and against everyone, so a burst of parallel requests cannot
 * outrun the limit and nobody can make the server send unlimited email.
 */
export interface AttemptLimits {
  windowMs: number;
  /** Attempts one address may make in a window. */
  perAddress: number;
  /** Attempts everyone together may make in a window. */
  global: number;
}

const MAX_TRACKED_ADDRESSES = 1000;

export const DEFAULT_ATTEMPT_LIMITS: AttemptLimits = { windowMs: 15 * 60 * 1000, perAddress: 5, global: 30 };

/**
 * Sign-in link requests per 15 minutes: DASHBOARD_SIGN_IN_PER_ADDRESS (default 5) and
 * DASHBOARD_SIGN_IN_GLOBAL (default 30), whole numbers from 1 to 10000. Without a trusted
 * proxy every caller shares one address, so a larger team may need a higher first limit.
 */
export function attemptLimitsFromEnv(env: Record<string, string | undefined> = process.env): AttemptLimits {
  const read = (name: string, fallback: number) => {
    const value = Number(env[name]?.trim() || fallback);
    return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : fallback;
  };
  return {
    windowMs: DEFAULT_ATTEMPT_LIMITS.windowMs,
    perAddress: read("DASHBOARD_SIGN_IN_PER_ADDRESS", DEFAULT_ATTEMPT_LIMITS.perAddress),
    global: read("DASHBOARD_SIGN_IN_GLOBAL", DEFAULT_ATTEMPT_LIMITS.global),
  };
}

/**
 * Attempts per address and in total over a sliding window. Every attempt is reserved before
 * its body is read; refund() gives one back when a caller should not be charged for it.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  private all: number[] = [];

  constructor(private readonly limits: AttemptLimits = DEFAULT_ATTEMPT_LIMITS) {}

  /** Seconds until this address may try again, or 0 when it may try now. */
  retryAfter(address: string, now: number = Date.now()): number {
    const since = now - this.limits.windowMs;
    this.all = this.all.filter((time) => time > since);
    const mine = (this.attempts.get(address) ?? []).filter((time) => time > since);
    if (mine.length > 0) this.attempts.set(address, mine);
    else this.attempts.delete(address);
    const blockedUntil = Math.max(
      mine.length >= this.limits.perAddress ? mine[mine.length - this.limits.perAddress]! + this.limits.windowMs : 0,
      this.all.length >= this.limits.global ? this.all[this.all.length - this.limits.global]! + this.limits.windowMs : 0,
    );
    return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0;
  }

  /**
   * Takes one attempt for this address and for everyone, or returns the seconds to wait and
   * takes nothing. Synchronous on purpose: call it before awaiting anything, so concurrent
   * requests each see the attempts the ones before them took.
   */
  reserve(address: string, now: number = Date.now()): number {
    const wait = this.retryAfter(address, now);
    if (wait > 0) return wait;
    this.all.push(now);
    this.attempts.set(address, [...(this.attempts.get(address) ?? []), now]);
    // Addresses that never come back must not pile up.
    if (this.attempts.size > MAX_TRACKED_ADDRESSES) {
      const since = now - this.limits.windowMs;
      for (const [key, times] of this.attempts) {
        if (times[times.length - 1]! <= since) this.attempts.delete(key);
      }
    }
    return 0;
  }

  /** Gives back the attempt reserve() took at `time`: the sign-in succeeded. */
  refund(address: string, time: number) {
    const drop = (times: number[]) => {
      const index = times.lastIndexOf(time);
      return index === -1 ? times : [...times.slice(0, index), ...times.slice(index + 1)];
    };
    this.all = drop(this.all);
    const mine = drop(this.attempts.get(address) ?? []);
    if (mine.length > 0) this.attempts.set(address, mine);
    else this.attempts.delete(address);
  }
}

/** The limiter key for every caller when no trusted proxy says who they are. */
export const DIRECT_ADDRESS = "direct";

/**
 * The caller's address for rate limiting. X-Forwarded-For counts only behind a trusted
 * proxy (DASHBOARD_TRUST_PROXY=1), which appends the address it saw, so the right-most
 * entry is the one to use. Without one, anyone can write that header (and `next start`
 * passes a sent one through), so every caller shares one "direct" key: the per-address
 * limit then bounds everyone together, next to the global one.
 */
export function clientAddress(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return DIRECT_ADDRESS;
  const entries = request.headers.get("x-forwarded-for")?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return entries.at(-1) ?? DIRECT_ADDRESS;
}
