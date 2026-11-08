// The dashboard's sign-in link limits, kept in the shared Postgres limiter (public-intake.md P-10) so they hold
// across server instances. The dashboard calls POST /public/v1/sign-in/admit with the shared secret as a bearer
// token; the API charges the buckets and answers 204 (admitted) or 429 with Retry-After.
import { z } from "zod";

export const SIGN_IN_ADMIT_PATH = "/public/v1/sign-in/admit";
/** One window for every sign-in bucket. */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_DEFAULT_LIMITS = { perAddress: 5, global: 30, perEmail: 5 } as const;

const count = z.number().int().min(1).max(10_000);

/**
 * `address`: charged before the request body is read, against the caller's address and against everyone.
 * `email`: charged once the body parsed, against the SHA-256 hex of the lowercased address, so the raw
 * address never leaves the dashboard and never keys a bucket.
 */
export const signInAdmitBodySchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("address"), address: z.string().min(1).max(64), perAddress: count, global: count }),
  z.strictObject({ scope: z.literal("email"), emailHash: z.string().regex(/^[0-9a-f]{64}$/), perEmail: count }),
]);
export type SignInAdmitBody = z.infer<typeof signInAdmitBodySchema>;
