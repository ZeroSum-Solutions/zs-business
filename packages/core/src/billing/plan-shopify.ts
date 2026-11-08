// Shopify App Pricing reads (docs/requirements/plans.md PL-15, PL-16, PL-18, PL-20). Original code,
// written from Shopify's public Partner API docs. The Partner API token belongs to the Partner
// organisation; no store token is used. `activeSubscription` answers the shop's current contract
// or null; anything else is an error, never "no contract".
import { z } from "zod";
import type { HubPlan, PlanInterval } from "@zs/contracts";

/** PL-16: our five Shopify plan keys. */
export const SHOPIFY_PLAN_KEYS = ["hub_solo", "hub_studio", "hub_pro", "hub_studio_founding", "hub_pro_founding"] as const;
export type ShopifyPlanKey = (typeof SHOPIFY_PLAN_KEYS)[number];
export const SHOPIFY_PLAN_KEY_PLANS: Readonly<Record<ShopifyPlanKey, { plan: HubPlan; founding: boolean }>> = Object.freeze({
  hub_solo: { plan: "solo", founding: false },
  hub_studio: { plan: "studio", founding: false },
  hub_pro: { plan: "pro", founding: false },
  hub_studio_founding: { plan: "studio", founding: true },
  hub_pro_founding: { plan: "pro", founding: true },
});
/** PL-16: Shopify billing periods we know. */
export const SHOPIFY_INTERVALS: Readonly<Record<string, PlanInterval>> = Object.freeze({ EVERY_30_DAYS: "month", ANNUAL: "year" });

export const SHOPIFY_SHOP_GID = /^gid:\/\/shopify\/Shop\/[0-9]{1,20}$/;
export const SHOPIFY_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const SHOPIFY_PARTNER_DEFAULT_BASE_URL = "https://partners.shopify.com";
export const SHOPIFY_PARTNER_DEFAULT_VERSION = "2026-10";

const handleSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_.-]+$/, "a plan handle has letters, digits, _ . -");

export const shopifyBillingConfigSchema = z.strictObject({
  partnerId: z.string().regex(/^[0-9]{1,20}$/, "the Partner ID is the number in the Partner Dashboard URL"),
  token: z.string().min(16).max(500).regex(/^\S+$/, "the Partner API token has no spaces"),
  appId: z.string().regex(/^[0-9]{1,20}$/, "the app ID is numeric"),
  planHandles: z.strictObject(Object.fromEntries(SHOPIFY_PLAN_KEYS.map((key) => [key, handleSchema])) as Record<ShopifyPlanKey, typeof handleSchema>)
    .refine((handles) => new Set(Object.values(handles)).size === SHOPIFY_PLAN_KEYS.length, "every plan handle must be distinct"),
  apiVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}$/).default(SHOPIFY_PARTNER_DEFAULT_VERSION),
  baseUrl: z.url({ protocol: /^https?$/ }).default(SHOPIFY_PARTNER_DEFAULT_BASE_URL),
  timeoutMs: z.number().int().min(500).max(30_000).default(8_000),
});
export type ShopifyBillingConfig = z.input<typeof shopifyBillingConfigSchema>;
export type ParsedShopifyBillingConfig = z.output<typeof shopifyBillingConfigSchema>;

/** One contract as the pass needs it. */
export interface ShopifyContract {
  readonly shopId: string;
  readonly billingPeriod: string;
  readonly trialEndsAt: Date | null;
  readonly cycleEnd: Date | null;
  readonly cancelAtEndOfCycle: boolean;
  readonly handles: readonly string[];
}

/** PL-18: a failed read. `stopPass` is true for throttling and Shopify-side failures. */
export class ShopifyPartnerError extends Error {
  constructor(message: string, readonly stopPass: boolean) {
    super(message);
    this.name = "ShopifyPartnerError";
  }
}

export interface ShopifySubscriptionReader {
  readonly config: ParsedShopifyBillingConfig;
  /**
   * The shop's current contract, or null when Shopify says it has none. Throws ShopifyPartnerError.
   * `timeoutMs` shortens the configured timeout, so a pass stays inside its deadline.
   */
  active(shopId: string, options?: { readonly timeoutMs?: number }): Promise<ShopifyContract | null>;
}

const QUERY = `query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    shop { id }
    billingPeriod
    cancelAtEndOfCycle
    trialEndsAt
    currentBillingCycle { endTime }
    items { handle }
  }
}`;

const dateSchema = z.iso.datetime({ offset: true });
const answerSchema = z.object({
  data: z.object({
    activeSubscription: z.object({
      shop: z.object({ id: z.string() }),
      billingPeriod: z.string().min(1).max(64),
      cancelAtEndOfCycle: z.boolean(),
      trialEndsAt: dateSchema.nullable(),
      currentBillingCycle: z.object({ endTime: dateSchema }).nullable(),
      items: z.array(z.object({ handle: z.string().max(255) })).max(50),
    }).nullable(),
  }),
});

/** PL-18: upstream text never carries the token or anything token-like into an error or a log. */
function redacted(text: string, token: string): string {
  return text.split(token).join("[redacted]")
    .replace(/\bprt[a-z]*_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]")
    .replace(/[^\x20-\x7e]/g, " ")
    .slice(0, 200);
}

const throttled = (errors: unknown[]) => errors.some((raw) => {
  const error = raw && typeof raw === "object" ? raw as { message?: unknown; extensions?: { code?: unknown } } : {};
  const code = String(error.extensions?.code ?? "");
  return code === "429" || code === "THROTTLED" || (typeof error.message === "string" && /too many requests|throttled/i.test(error.message));
});

export function createShopifySubscriptionReader(input: {
  readonly config: ShopifyBillingConfig;
  readonly fetch?: typeof fetch;
}): ShopifySubscriptionReader {
  const config = shopifyBillingConfigSchema.parse(input.config);
  const send = input.fetch ?? fetch;
  const url = new URL(`/${config.partnerId}/api/${config.apiVersion}/graphql.json`, config.baseUrl).toString();
  const appGid = `gid://shopify/App/${config.appId}`;
  return {
    config,
    async active(shopId, options = {}) {
      if (!SHOPIFY_SHOP_GID.test(shopId)) throw new ShopifyPartnerError("Not a shop GID", false);
      const timeoutMs = Math.max(1, Math.min(config.timeoutMs, Math.floor(options.timeoutMs ?? config.timeoutMs)));
      let response: Response;
      try {
        response = await send(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": config.token, "User-Agent": "zs-business-billing" },
          body: JSON.stringify({ query: QUERY, variables: { appId: appGid, shopId } }),
          signal: AbortSignal.timeout(timeoutMs),
          // A redirect is an error, never followed with the token.
          redirect: "manual",
        });
      } catch {
        throw new ShopifyPartnerError("The Partner API is unreachable", true);
      }
      if (response.status === 429 || response.status >= 500) throw new ShopifyPartnerError(`The Partner API answered ${response.status}`, true);
      // A body that stops arriving (abort, timeout, reset) is a transport failure and ends the pass;
      // only a complete body that is not JSON is a malformed answer.
      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new ShopifyPartnerError("The Partner API answer was cut off", true);
      }
      // Per-shop failures come as GraphQL errors in a 200 answer. Any other status (401, 403, a 404
      // for an unknown API version, a redirect) is the token or the endpoint, the same for every
      // shop, so it ends the pass instead of backing off each shop in turn.
      if (!response.ok) throw new ShopifyPartnerError(`The Partner API answered ${response.status}`, true);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ShopifyPartnerError(`The Partner API answered ${response.status} without JSON`, false);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShopifyPartnerError("The Partner API answer is malformed", false);
      // Any `errors` field that is not absent, null or an empty list makes the answer an error, never "no contract".
      const rawErrors = (body as { errors?: unknown }).errors;
      if (rawErrors !== undefined && rawErrors !== null && !Array.isArray(rawErrors))
        throw new ShopifyPartnerError("The Partner API answer is malformed", false);
      const errors: unknown[] = Array.isArray(rawErrors) ? rawErrors : [];
      if (errors.length > 0) {
        if (throttled(errors)) throw new ShopifyPartnerError("The Partner API is throttling", true);
        const first = errors[0] && typeof errors[0] === "object" ? (errors[0] as { message?: unknown }).message : undefined;
        throw new ShopifyPartnerError(`The Partner API refused: ${typeof first === "string" ? redacted(first, config.token) : "unknown error"}`, false);
      }
      const parsed = answerSchema.safeParse(body);
      if (!parsed.success) throw new ShopifyPartnerError("The Partner API answer is malformed", false);
      const contract = parsed.data.data.activeSubscription;
      if (contract === null) return null;
      if (contract.shop.id !== shopId) throw new ShopifyPartnerError("The Partner API answered for another shop", false);
      return {
        shopId: contract.shop.id,
        billingPeriod: contract.billingPeriod,
        trialEndsAt: contract.trialEndsAt === null ? null : new Date(contract.trialEndsAt),
        cycleEnd: contract.currentBillingCycle === null ? null : new Date(contract.currentBillingCycle.endTime),
        cancelAtEndOfCycle: contract.cancelAtEndOfCycle,
        handles: contract.items.map((item) => item.handle),
      };
    },
  };
}
