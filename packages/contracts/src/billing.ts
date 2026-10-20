import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";

// M5 Stripe wallet top-ups (docs/requirements/stripe.md). Root re-exports this module, so shared
// root schemas are reached lazily, as in delivery.ts.
const idSchema = z.lazy(() => uuidSchema);

export const WALLET_TOPUP_CREATE_ACTION = "wallet.topup.create";

/** S-1: whole minor units; the configured minimum and maximum are checked by the server. */
export const createTopUpRequestSchema = z.strictObject({
  amount: z.number().int().positive().max(100_000_000),
});
export type CreateTopUpRequest = z.infer<typeof createTopUpRequestSchema>;

export const createTopUpInputSchema = z.strictObject({
  topupId: idSchema,
  amount: z.number().int().positive().max(100_000_000),
});
export const createTopUpCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(WALLET_TOPUP_CREATE_ACTION),
  target: targetSchema.extend({ type: z.literal("wallet_topup") }),
  payload: createTopUpInputSchema,
}));

export const topUpStatusSchema = z.enum(["pending", "paid", "failed", "expired", "mismatch"]);
export type TopUpStatus = z.infer<typeof topUpStatusSchema>;

export const topUpSchema = z.strictObject({
  id: idSchema,
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: topUpStatusSchema,
  refunded: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
});
export type TopUp = z.infer<typeof topUpSchema>;

/** S-2: 201 body of POST /v1/wallet/top-ups. */
export const createTopUpResponseSchema = z.strictObject({
  topup: topUpSchema,
  checkoutUrl: z.url({ protocol: /^https$/ }),
});
export type CreateTopUpResponse = z.infer<typeof createTopUpResponseSchema>;
