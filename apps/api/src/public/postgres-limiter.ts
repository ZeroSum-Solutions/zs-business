// public-intake.md P-10 (revision 6): the shared limiter. Every API instance charges the same
// buckets in Postgres (supabase/migrations/20261020400000_public_rate_limits.sql), so the
// limits hold across Vercel function instances. One call to public.rate_limit_take checks
// and charges every bucket of a request atomically, under the request's deadline.
import { createHash } from "node:crypto";
import type { ScopedDatabase } from "@zs/db";
import { retryAfterSeconds, type RateLimiter } from "./limiter.js";

/** Buckets are stored by the SHA-256 of their name, so the table holds no client address. */
const bucketKey = (name: string) => createHash("sha256").update(name).digest("hex");

export function createPostgresRateLimiter(db: ScopedDatabase, clock: { now(): Date }): RateLimiter {
  return {
    async take(charges, options = {}) {
      const payload = charges.map(({ key, rule }) => ({ key: bucketKey(key), limit: rule.limit, windowMs: rule.windowMs }));
      const retryAfterMs = await db.withoutTenant(async (tx) => {
        const { rows } = await tx.query<{ retry_ms: string }>(
          "SELECT public.rate_limit_take($1, $2::jsonb) AS retry_ms",
          [clock.now().toISOString(), JSON.stringify(payload)],
        );
        return Number(rows[0]!.retry_ms);
      }, options);
      return retryAfterMs > 0 ? { ok: false, retryAfterSeconds: retryAfterSeconds(retryAfterMs) } : { ok: true };
    },
  };
}
