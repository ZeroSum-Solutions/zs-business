// public-intake.md P-10 (revision 6): the shared limiter. Every API instance charges the same
// buckets in Postgres (supabase/migrations/20261020400000_public_rate_limits.sql), so the
// limits hold across Vercel function instances. One call to public.rate_limit_take checks
// and charges every bucket of a request atomically, under the request's deadline.
import { createHash } from "node:crypto";
import { DatabaseUnavailable, type ScopedDatabase } from "@zs/db";
import { retryAfterSeconds, type RateLimiter } from "./limiter.js";

/** Buckets are stored by the SHA-256 of their name, so the table holds no client address. */
const bucketKey = (name: string) => createHash("sha256").update(name).digest("hex");

/**
 * Failures that mean the store could not answer now, not a fault in the call: a lock wait or
 * statement past its timeout, a serialization failure or deadlock, a lost or refused
 * connection (SQLSTATE classes 08 and 57P, socket errors, node-postgres's "Connection
 * terminated"), or a server out of resources (class 53). P-10 answers them with a retryable
 * 503, like a busy pool.
 */
function transient(error: unknown): DatabaseUnavailable | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (["55P03", "57014", "40001", "40P01"].includes(code) || code.startsWith("53"))
    return new DatabaseUnavailable("busy", { cause: error });
  if (code.startsWith("08") || code.startsWith("57P") || /^E[A-Z]+$/.test(code) || error.message.startsWith("Connection terminated"))
    return new DatabaseUnavailable("connect", { cause: error });
  return undefined;
}

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
      }, options).catch((error: unknown) => {
        throw transient(error) ?? error;
      });
      return retryAfterMs > 0 ? { ok: false, retryAfterSeconds: retryAfterSeconds(retryAfterMs) } : { ok: true };
    },
  };
}
