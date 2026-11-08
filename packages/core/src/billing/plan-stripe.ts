// Hub plans' Stripe calls (docs/requirements/plans.md PL-5, PL-6, PL-13). Original code, written
// from Stripe's public API behaviour in our own words. Only the injected fetch is called; nothing
// here reads the environment or the clock.
import { z } from "zod";
import { ALL_PLAN_PRICE_KEYS } from "@zs/contracts";
import { secureUrlProblem } from "../edge/auth.js";
import { readLimited, StripeRequestFailed, stripeConfigSchema, type StripeConfig } from "./stripe.js";

const httpsUrl = (label: string) => z.string().superRefine((value, ctx) => {
  const problem = secureUrlProblem(label, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});
const PRICE_ID = /^price_[A-Za-z0-9_]{1,250}$/;

/** PL-13: what the API needs to sell plans. */
export const planConfigSchema = z.strictObject({
  /** Every PL-2 lookup key to its price ID. */
  prices: z.record(z.string(), z.string().regex(PRICE_ID, "must be a Stripe price ID"))
    .refine((prices) => ALL_PLAN_PRICE_KEYS.every((key) => typeof prices[key] === "string")
      && Object.keys(prices).every((key) => ALL_PLAN_PRICE_KEYS.includes(key)),
    `must map exactly these lookup keys: ${ALL_PLAN_PRICE_KEYS.join(", ")}`),
  /** The dashboard's plan page; Checkout and the Portal return here. */
  returnUrl: httpsUrl("returnUrl"),
  trialDays: z.number().int().min(0).max(30).default(14),
  portalConfiguration: z.string().regex(/^bpc_[A-Za-z0-9_]{1,250}$/).optional(),
});
export type PlanConfig = z.input<typeof planConfigSchema>;
export type ParsedPlanConfig = z.infer<typeof planConfigSchema>;

export interface SubscriptionCheckoutRequest {
  readonly tenantId: string;
  readonly checkoutId: string;
  readonly planPriceId: string;
  readonly addonPriceId: string | null;
  readonly extraConnections: number;
  readonly customerId: string | null;
  readonly trialDays: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Unix seconds; Stripe accepts 30 minutes to 24 hours ahead. */
  readonly expiresAt: number;
}

const form = (entries: ReadonlyArray<readonly [string, string | number]>) =>
  entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");

/** PL-5: the subscription Checkout form, in a fixed order, so a retry is byte for byte the same. */
export function subscriptionCheckoutForm(request: SubscriptionCheckoutRequest): string {
  return form([
    ["mode", "subscription"],
    ["line_items[0][price]", request.planPriceId],
    ["line_items[0][quantity]", 1],
    ...(request.addonPriceId !== null && request.extraConnections > 0
      ? [["line_items[1][price]", request.addonPriceId], ["line_items[1][quantity]", request.extraConnections]] as const
      : []),
    ...(request.customerId !== null ? [["customer", request.customerId]] as const : []),
    ["success_url", request.successUrl],
    ["cancel_url", request.cancelUrl],
    ["client_reference_id", request.checkoutId],
    ["metadata[zs_tenant]", request.tenantId],
    ["metadata[zs_checkout]", request.checkoutId],
    ["subscription_data[metadata][zs_tenant]", request.tenantId],
    ["subscription_data[metadata][zs_checkout]", request.checkoutId],
    ...(request.trialDays > 0 ? [["subscription_data[trial_period_days]", request.trialDays]] as const : []),
    ["payment_method_collection", "always"],
    ["expires_at", request.expiresAt],
  ]);
}

export interface StripePlansClient {
  readonly config: ParsedPlanConfig;
  createSubscriptionCheckout(request: SubscriptionCheckoutRequest, options: { readonly signal?: AbortSignal }): Promise<{ id: string; url: string }>;
  createPortalSession(request: { readonly customerId: string }, options: { readonly signal?: AbortSignal }): Promise<{ url: string }>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function createStripePlansClient(deps: {
  readonly stripe: StripeConfig;
  readonly plans: PlanConfig;
  readonly fetch?: Fetch;
}): StripePlansClient {
  const stripe = stripeConfigSchema.safeParse(deps.stripe);
  if (!stripe.success) throw new Error("Invalid Stripe config");
  const parsed = planConfigSchema.safeParse(deps.plans);
  if (!parsed.success) throw new Error(`Invalid plan config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const config = parsed.data;
  const { secretKey, apiVersion } = stripe.data;
  const base = stripe.data.baseUrl.replace(/\/+$/, "");
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function post(path: string, body: string, idempotencyKey: string | null, signal: AbortSignal | undefined) {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...(apiVersion ? { "Stripe-Version": apiVersion } : {}),
        },
        body,
        redirect: "manual",
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new StripeRequestFailed("stripe_network", true);
    }
    const answer = await readLimited(response).catch(() => null) as
      { id?: unknown; url?: unknown; error?: { code?: unknown; type?: unknown } } | null;
    if (response.status >= 200 && response.status < 300) return answer;
    const name = typeof answer?.error?.code === "string" ? answer.error.code : typeof answer?.error?.type === "string" ? answer.error.type : "";
    const code = `stripe_${response.status}${name ? `_${name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 60)}` : ""}`;
    throw new StripeRequestFailed(code, response.status === 409 || response.status === 429 || response.status >= 500);
  }

  return {
    config,
    async createSubscriptionCheckout(request, options) {
      const body = await post("/v1/checkout/sessions", subscriptionCheckoutForm(request), `zsp-${request.checkoutId}`, options.signal);
      if (body && typeof body.id === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(body.id)
        && typeof body.url === "string" && body.url.startsWith("https://"))
        return { id: body.id, url: body.url };
      throw new StripeRequestFailed("stripe_unreadable_response", true);
    },
    async createPortalSession(request, options) {
      const body = await post("/v1/billing_portal/sessions", form([
        ["customer", request.customerId],
        ["return_url", config.returnUrl],
        ...(config.portalConfiguration ? [["configuration", config.portalConfiguration]] as const : []),
      ]), null, options.signal);
      if (body && typeof body.url === "string" && body.url.startsWith("https://")) return { url: body.url };
      throw new StripeRequestFailed("stripe_unreadable_response", true);
    },
  };
}

const planEnvSchema = z.object({
  STRIPE_PLAN_PRICES: z.string().min(2, "is required when any STRIPE_PLAN_ variable is set"),
  STRIPE_PLAN_RETURN_URL: z.string().min(1, "is required when any STRIPE_PLAN_ variable is set"),
  STRIPE_PLAN_TRIAL_DAYS: z.coerce.number().int().min(0).max(30).optional(),
  STRIPE_PORTAL_CONFIGURATION: z.string().optional(),
});

/** PL-13: the plan variables, all required ones or none. None set: null, and plans are off. Errors name variables, never values. */
export function parsePlanEnv(env: Readonly<Record<string, string | undefined>>): PlanConfig | null {
  const given = Object.keys(planEnvSchema.shape).filter((name) => env[name] !== undefined && env[name] !== "");
  if (given.length === 0) return null;
  const parsed = planEnvSchema.safeParse(Object.fromEntries(given.map((name) => [name, env[name]])));
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  let prices: unknown;
  try {
    prices = JSON.parse(parsed.data.STRIPE_PLAN_PRICES);
  } catch {
    throw new Error("Invalid environment: STRIPE_PLAN_PRICES must be a JSON object");
  }
  const config: PlanConfig = {
    prices: prices as Record<string, string>,
    returnUrl: parsed.data.STRIPE_PLAN_RETURN_URL,
    ...(parsed.data.STRIPE_PLAN_TRIAL_DAYS === undefined ? {} : { trialDays: parsed.data.STRIPE_PLAN_TRIAL_DAYS }),
    ...(parsed.data.STRIPE_PORTAL_CONFIGURATION === undefined ? {} : { portalConfiguration: parsed.data.STRIPE_PORTAL_CONFIGURATION }),
  };
  const checked = planConfigSchema.safeParse(config);
  if (!checked.success) {
    const names: Record<string, string> = { prices: "STRIPE_PLAN_PRICES", returnUrl: "STRIPE_PLAN_RETURN_URL", trialDays: "STRIPE_PLAN_TRIAL_DAYS", portalConfiguration: "STRIPE_PORTAL_CONFIGURATION" };
    throw new Error(`Invalid environment: ${checked.error.issues.map((issue) => `${names[String(issue.path[0])] ?? "STRIPE_PLAN_*"}: ${issue.message}`).join("; ")}`);
  }
  return config;
}

/** PL-10: reads a subscription as Stripe has it now; null when Stripe does not know it. */
export interface StripeSubscriptionReader {
  retrieve(subscriptionId: string): Promise<Record<string, unknown> | null>;
}

export const subscriptionReaderConfigSchema = z.strictObject({
  /** PL-13: a restricted key that may only read subscriptions. */
  secretKey: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,250}$/, "must be a Stripe secret or restricted key"),
  baseUrl: httpsUrl("baseUrl").default("https://api.stripe.com"),
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/).optional(),
  timeoutMs: z.number().int().min(100).max(20_000).default(5_000),
});
export type SubscriptionReaderConfig = z.input<typeof subscriptionReaderConfigSchema>;

export function createStripeSubscriptionReader(deps: { readonly config: SubscriptionReaderConfig; readonly fetch?: Fetch }): StripeSubscriptionReader {
  const parsed = subscriptionReaderConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new Error(`Invalid Stripe reader config: ${parsed.error.issues.map((issue) => issue.path.join(".") || "config").join(", ")}`);
  const config = parsed.data;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const base = config.baseUrl.replace(/\/+$/, "");
  return {
    async retrieve(subscriptionId) {
      if (!/^sub_[A-Za-z0-9_]{1,250}$/.test(subscriptionId)) return null;
      let response: Response;
      try {
        response = await doFetch(`${base}/v1/subscriptions/${subscriptionId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${config.secretKey}`, ...(config.apiVersion ? { "Stripe-Version": config.apiVersion } : {}) },
          redirect: "manual",
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        throw new StripeRequestFailed("stripe_network", true);
      }
      const body = await readLimited(response).catch(() => null) as Record<string, unknown> | null;
      if (response.status === 404) return null;
      if (response.status >= 200 && response.status < 300 && body && body.object === "subscription" && body.id === subscriptionId) return body;
      throw new StripeRequestFailed(`stripe_${response.status}`, true);
    },
  };
}
