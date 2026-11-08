import { z } from "zod";
import { shopDomainSchema } from "./connections.js";
import { uuidSchema } from "./index.js";

// The native Shopify tier (docs/requirements/connections.md C-21 to C-27). Two kinds of call:
//   - The embedded app's calls (an App Bridge session token, a Shopify ID token, in the Authorization header). The
//     dashboard forwards them to the API, the API signs them to the worker, and the worker alone checks the token.
//   - The owner's claim calls (a signed-in hub owner), which carry no ID token.
// The worker's nine operations travel under /internal/shopify/<operation>. Domain outcomes are 200 with an `outcome`.
const idSchema = z.lazy(() => uuidSchema);

export const SHOPIFY_OPERATIONS = Object.freeze([
  "open", "create_hub", "redeem_claim", "sign_in", "claim_start", "claim_status", "claim_cancel", "claim_confirm", "orders",
] as const);
export type ShopifyOperation = (typeof SHOPIFY_OPERATIONS)[number];
export const SHOPIFY_PATH_PREFIX = "/internal/shopify/";

/** A compact JWT: three base64url parts. Only the worker reads it. */
export const shopifyIdTokenSchema = z.string().max(4096).regex(/^[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{4,2000}\.[A-Za-z0-9_-]{4,2000}$/);
/** Ten characters from a 32-letter alphabet; spaces and dashes are allowed when typed. */
export const shopifyClaimCodeSchema = z.string().max(32).transform((value) => value.replace(/[\s-]/g, "").toUpperCase()).pipe(z.string().regex(/^[A-Z2-9]{10}$/));

const idTokenBody = z.strictObject({ idToken: shopifyIdTokenSchema });
export const shopifyOpenRequestSchema = idTokenBody;
export const shopifyCreateHubRequestSchema = idTokenBody;
export const shopifySignInRequestSchema = idTokenBody;
export const shopifyOrdersRequestSchema = idTokenBody;
export const shopifyRedeemClaimRequestSchema = z.strictObject({ idToken: shopifyIdTokenSchema, code: shopifyClaimCodeSchema });
export const shopifyClaimStartRequestSchema = z.strictObject({ tenantId: idSchema, memberId: idSchema });
export const shopifyClaimStatusRequestSchema = z.strictObject({ tenantId: idSchema });
export const shopifyClaimCancelRequestSchema = z.strictObject({ tenantId: idSchema, claimId: idSchema });
export const shopifyClaimConfirmRequestSchema = z.strictObject({ tenantId: idSchema, claimId: idSchema, memberId: idSchema });

const instant = z.iso.datetime({ precision: 3 });
const shopSchema = z.strictObject({ domain: shopDomainSchema, name: z.string().max(300) });

/** C-29: what the hub knows of the shop's Shopify subscription, read from `tenant_plans` (plans.md PL-18). */
export const shopifyPlanStateSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({ state: z.enum(["active", "trial"]), name: z.string().max(60) }),
]);
export type ShopifyPlanState = z.infer<typeof shopifyPlanStateSchema>;

export const shopifyOpenResponseSchema = z.discriminatedUnion("outcome", [
  // Not strict at the top level: a field a newer worker adds is dropped, not a 503, so either deploy order is safe
  // from here on (C-29). Every field it does read stays strict.
  z.object({
    outcome: z.literal("ok"),
    shop: shopSchema,
    /** Optional so a new API accepts an older worker's answer during a deploy; missing means unknown and renders as no plan. */
    plan: shopifyPlanStateSchema.optional(),
    /** C-29: Shopify's plan selection page; the API route adds it (the worker does not know the app handle). Null when the handle is unset. */
    planUrl: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
    link: z.discriminatedUnion("state", [
      z.strictObject({ state: z.literal("none") }),
      z.strictObject({ state: z.literal("linked"), businessName: z.string().max(300), connection: z.enum(["active", "reauthorize"]) }),
    ]),
  }),
  z.strictObject({ outcome: z.enum(["invalid_token", "unavailable", "busy", "not_supported"]) }),
]);
export type ShopifyOpenResponse = z.infer<typeof shopifyOpenResponseSchema>;

export const shopifyCreateHubResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.enum(["created", "relinked"]), businessName: z.string().max(300), ownerEmail: z.string().max(320) }),
  z.strictObject({ outcome: z.enum(["already_linked", "not_owner", "email_has_hub", "store_in_use", "not_installed", "invalid_token", "unavailable"]) }),
]);
export type ShopifyCreateHubResponse = z.infer<typeof shopifyCreateHubResponseSchema>;

export const shopifyRedeemClaimResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("redeemed"), businessName: z.string().max(300) }),
  z.strictObject({ outcome: z.enum(["invalid_code", "not_owner", "already_linked", "not_installed", "invalid_token", "unavailable"]) }),
  z.strictObject({ outcome: z.literal("locked"), retryAfterSeconds: z.number().int().positive().max(86_400) }),
]);
export type ShopifyRedeemClaimResponse = z.infer<typeof shopifyRedeemClaimResponseSchema>;

export const shopifySignInResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("ok"), url: z.url({ protocol: /^https$/ }).max(4000) }),
  z.strictObject({ outcome: z.enum(["not_available", "not_owner", "invalid_token", "unavailable"]) }),
]);
export type ShopifySignInResponse = z.infer<typeof shopifySignInResponseSchema>;

export const shopifyClaimStartResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("started"), claimId: idSchema, code: z.string().min(10).max(16), expiresAt: instant }),
  z.strictObject({ outcome: z.literal("already_connected") }),
]);
export type ShopifyClaimStartResponse = z.infer<typeof shopifyClaimStartResponseSchema>;

/** What an owner sees of the open claim; the code is shown once, at start, and never again. */
export const shopifyClaimViewSchema = z.strictObject({
  id: idSchema,
  status: z.enum(["open", "redeemed"]),
  expiresAt: instant,
  shop: shopSchema.optional(),
});
export type ShopifyClaimView = z.infer<typeof shopifyClaimViewSchema>;
export const shopifyClaimStatusResponseSchema = z.strictObject({ claim: shopifyClaimViewSchema.nullable() });
export const shopifyClaimCancelResponseSchema = z.strictObject({ outcome: z.enum(["cancelled", "not_found"]) });
export const shopifyClaimConfirmResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("confirmed"), connectionId: idSchema }),
  z.strictObject({ outcome: z.enum(["not_redeemed", "expired", "install_gone", "store_in_use", "tenant_has_store", "not_found"]) }),
  z.strictObject({ outcome: z.literal("billing_conflict"), reason: z.string().max(64) }),
]);

/**
 * C-30: the embedded page's read-only "Recent orders" view. No customer field exists in this type (the strict objects
 * would reject one): an order is its name, time, two status words and a total.
 */
const moneyAmount = z.string().regex(/^[0-9]{1,15}(\.[0-9]{1,6})?$/);
/** The summary adds up to 50 amounts of at most 15 integer digits each, so the sum needs up to 17. */
const summedAmount = z.string().regex(/^[0-9]{1,17}(\.[0-9]{1,6})?$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
export const SHOPIFY_RECENT_ORDERS_DAYS = 60;
export const SHOPIFY_RECENT_ORDERS_SHOWN = 10;
export const SHOPIFY_RECENT_ORDERS_FETCHED = 50;
export const shopifyRecentOrderSchema = z.strictObject({
  name: z.string().min(1).max(100),
  createdAt: instant,
  displayFinancialStatus: z.string().max(60).nullable(),
  displayFulfillmentStatus: z.string().max(60).nullable(),
  total: z.strictObject({ amount: moneyAmount, currency: currencyCode }),
});
export type ShopifyRecentOrder = z.infer<typeof shopifyRecentOrderSchema>;
export const shopifyOrdersResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ok"),
    /** The newest orders of the last 60 days, newest first, at most 10. */
    orders: z.array(shopifyRecentOrderSchema).max(SHOPIFY_RECENT_ORDERS_SHOWN),
    /** Counted over the orders fetched (at most 50); `total` is null when their currencies differ. */
    summary: z.strictObject({
      count: z.number().int().min(0).max(SHOPIFY_RECENT_ORDERS_FETCHED),
      total: z.strictObject({ amount: summedAmount, currency: currencyCode }).nullable(),
    }),
  }),
  z.strictObject({ outcome: z.enum(["invalid_token", "unavailable", "busy", "not_supported", "not_linked"]) }),
]);
export type ShopifyOrdersResponse = z.infer<typeof shopifyOrdersResponseSchema>;

/**
 * C-30: the browser's address, from the dashboard proxy to the API, signed. The API sees only the dashboard's own
 * address on a server-to-server call (Vercel overwrites x-vercel-forwarded-for), so without this note every merchant
 * would share one embedded rate-limit bucket. The API counts the note only with a valid HMAC-SHA256 under
 * CONNECTIONS_EMBEDDED_ADDRESS_SECRET (both projects hold it); the signature also covers the bearer token, so a seen
 * note fits that one short-lived token only.
 */
export const SHOPIFY_EMBEDDED_ADDRESS_HEADER = "x-zs-embedded-address";
export const SHOPIFY_EMBEDDED_ADDRESS_SIGNATURE_HEADER = "x-zs-embedded-address-signature";
export const shopifyEmbeddedAddressMessage = (address: string, idToken: string): string =>
  `zs-shopify-embedded-address.v1\n${address}\n${idToken}`;
