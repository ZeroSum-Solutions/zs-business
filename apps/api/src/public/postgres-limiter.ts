// public-intake.md P-10 (revision 6): the shared limiter. Every API instance charges the same
// buckets in Postgres (supabase/migrations/20261020400000_public_rate_limits.sql), so the
// limits hold across Vercel function instances. One call to public.rate_limit_take checks
// and charges every bucket of a request atomically, under the request's deadline.
import { createHash } from "node:crypto";
import { DatabaseUnavailable, type ScopedDatabase } from "@zs/db";
import { retryAfterSeconds, type ChargeReceipt, type RateLimiter, type TakeReceiptResult } from "./limiter.js";

/** Buckets are stored by the SHA-256 of their name, so the table holds no client address. */
const bucketKey = (name: string) => createHash("sha256").update(name).digest("hex");

/**
 * Failures that mean the store could not answer now, not a fault in the call: a lock wait or
 * statement past its timeout, a serialization failure or deadlock, a lost or refused
 * connection (SQLSTATE classes 08 and 57P, socket errors, node-postgres's "Connection
 * terminated" and "not queryable"), or a server out of resources (class 53). P-10 answers them with a retryable
 * 503, like a busy pool.
 */
function transient(error: unknown): DatabaseUnavailable | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (["55P03", "57014", "40001", "40P01"].includes(code) || code.startsWith("53"))
    return new DatabaseUnavailable("busy", { cause: error });
  if (code.startsWith("08") || code.startsWith("57P") || /^E[A-Z]+$/.test(code)
    || error.message.startsWith("Connection terminated") || error.message.endsWith("is not queryable"))
    return new DatabaseUnavailable("connect", { cause: error });
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    // C-4: the same charge as `take`, through rate_limit_receipt_take, which also stores a receipt of the
    // buckets and windows it charged (supabase/migrations/20261108900000_rate_limit_receipt_refund.sql).
    async takeWithReceipt(charges, options = {}): Promise<TakeReceiptResult> {
      const payload = charges.map(({ key, rule }) => ({ key: bucketKey(key), limit: rule.limit, windowMs: rule.windowMs }));
      const answer = await db.withoutTenant(async (tx) => {
        const { rows } = await tx.query<{ answer: unknown }>(
          "SELECT public.rate_limit_receipt_take($1, $2::jsonb) AS answer",
          [clock.now().toISOString(), JSON.stringify(payload)],
        );
        return rows[0]?.answer;
      }, options).catch((error: unknown) => {
        throw transient(error) ?? error;
      });
      const { retryMs, receipt } = (answer ?? {}) as { retryMs?: unknown; receipt?: { id?: unknown } | null };
      if (typeof retryMs !== "number") throw new Error("rate_limit_receipt_take answered something unexpected");
      if (retryMs > 0) return { ok: false, retryAfterSeconds: retryAfterSeconds(retryMs) };
      if (typeof receipt?.id !== "string" || !UUID.test(receipt.id)) throw new Error("rate_limit_receipt_take answered no receipt");
      return { ok: true, receipt: { id: receipt.id } };
    },
    async refund(receipt: ChargeReceipt, options = {}) {
      if (!UUID.test(receipt.id)) return 0;
      const given = await db.withoutTenant(async (tx) => {
        const { rows } = await tx.query<{ given: number }>(
          "SELECT public.rate_limit_refund($1, $2::uuid) AS given",
          [clock.now().toISOString(), receipt.id],
        );
        return Number(rows[0]?.given ?? 0);
      }, options).catch((error: unknown) => {
        throw transient(error) ?? error;
      });
      return given;
    },
  };
}
