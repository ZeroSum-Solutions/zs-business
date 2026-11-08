// The dashboard's sign-in link limits, kept in the shared Postgres limiter (public-intake.md P-10) so they hold
// across server instances. The dashboard calls POST /public/v1/sign-in/admit with the shared secret as a bearer
// token; the API charges the address and global buckets in one atomic rate_limit_take and answers 204 (admitted)
// or 429 with Retry-After.
import { z } from "zod";

export const SIGN_IN_ADMIT_PATH = "/public/v1/sign-in/admit";
/** One window for every sign-in bucket (a fixed window, like every shared bucket). */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_DEFAULT_LIMITS = { perAddress: 5, global: 30 } as const;
/** The key for callers the dashboard cannot tell apart, and for any address that is not one. */
export const SIGN_IN_DIRECT_ADDRESS = "direct";

const count = z.number().int().min(1).max(10_000);

/**
 * Both buckets are charged together or not at all. `address` is whatever the dashboard saw: the API buckets it
 * as an address when it is one (IPv6 by its /64) and under the shared "direct" key when it is not, so an
 * unreadable or oversize forwarded value is never a client error.
 */
export const signInAdmitBodySchema = z.strictObject({
  address: z.string().max(512),
  perAddress: count,
  global: count,
});
export type SignInAdmitBody = z.infer<typeof signInAdmitBodySchema>;

/**
 * SIGN_IN_LIMITER_SECRET (API) and DASHBOARD_SIGN_IN_LIMITER_SECRET (dashboard) go through this one parser, so both
 * sides read the same bytes: trimmed, at least 32 characters, no whitespace inside.
 */
export const signInLimiterSecretSchema = z.string().trim().min(32, "must be at least 32 characters")
  .regex(/^\S+$/, "must not contain whitespace");
