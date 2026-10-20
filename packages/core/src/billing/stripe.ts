// M5 Stripe client and webhook signature (docs/requirements/stripe.md S-2, S-3). Original code,
// written from Stripe's public API behaviour in our own words. Only the injected fetch is
// called; nothing here reads the environment or the clock.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { secureUrlProblem } from "../edge/auth.js";

export const STRIPE_DEFAULT_BASE_URL = "https://api.stripe.com";
export const STRIPE_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;

const httpsUrl = (label: string) => z.string().superRefine((value, ctx) => {
  const problem = secureUrlProblem(label, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const stripeConfigSchema = z.strictObject({
  secretKey: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,250}$/, "secretKey must be a Stripe secret or restricted key"),
  baseUrl: httpsUrl("baseUrl").default(STRIPE_DEFAULT_BASE_URL),
  /** Pins the API version of requests; unset uses the account's default. */
  apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/).optional(),
  successUrl: httpsUrl("successUrl"),
  cancelUrl: httpsUrl("cancelUrl"),
  currency: z.string().regex(/^[a-z]{3}$/).default("usd"),
  /** Minor units. */
  minTopUp: z.number().int().positive().default(500),
  maxTopUp: z.number().int().positive().max(100_000_000).default(50_000),
  /** Shown on the Checkout page as the line item. */
  productName: z.string().min(1).max(100).default("Message credit"),
}).refine((config) => config.minTopUp <= config.maxTopUp, "minTopUp must not exceed maxTopUp");
export type StripeConfig = z.input<typeof stripeConfigSchema>;
export type ParsedStripeConfig = z.infer<typeof stripeConfigSchema>;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Why Stripe did not answer with a session; `retry` means the same request may succeed later. */
export class StripeRequestFailed extends Error {
  constructor(readonly code: string, readonly retry: boolean) {
    super(`Stripe request failed: ${code}`);
    this.name = "StripeRequestFailed";
  }
}

export interface CheckoutSessionRequest {
  readonly tenantId: string;
  readonly topupId: string;
  readonly amount: number;
  readonly currency: string;
  /** Unix seconds; Stripe accepts 30 minutes to 24 hours ahead. */
  readonly expiresAt: number;
}

/** Form-encodes nested parameters the way Stripe reads them, in a fixed order. */
function form(entries: ReadonlyArray<readonly [string, string | number]>): string {
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
}

export function checkoutSessionForm(config: ParsedStripeConfig, request: CheckoutSessionRequest): string {
  return form([
    ["mode", "payment"],
    ["line_items[0][quantity]", 1],
    ["line_items[0][price_data][currency]", request.currency],
    ["line_items[0][price_data][unit_amount]", request.amount],
    ["line_items[0][price_data][product_data][name]", config.productName],
    ["success_url", config.successUrl],
    ["cancel_url", config.cancelUrl],
    ["client_reference_id", request.topupId],
    ["metadata[zs_tenant]", request.tenantId],
    ["metadata[zs_topup]", request.topupId],
    ["payment_intent_data[metadata][zs_tenant]", request.tenantId],
    ["payment_intent_data[metadata][zs_topup]", request.topupId],
    ["expires_at", request.expiresAt],
  ]);
}

async function readLimited(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export interface StripeClient {
  readonly config: ParsedStripeConfig;
  createCheckoutSession(request: CheckoutSessionRequest, options: { readonly signal?: AbortSignal }): Promise<{ id: string; url: string }>;
}

export function createStripeClient(deps: { readonly config: StripeConfig; readonly fetch?: Fetch }): StripeClient {
  const parsed = stripeConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new Error(`Invalid Stripe config: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  const config = parsed.data;
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/checkout/sessions`;
  return {
    config,
    async createCheckoutSession(request, options) {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": `zst-${request.topupId}`,
            ...(config.apiVersion ? { "Stripe-Version": config.apiVersion } : {}),
          },
          body: checkoutSessionForm(config, request),
          redirect: "manual",
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch {
        throw new StripeRequestFailed("stripe_network", true);
      }
      const body = await readLimited(response).catch(() => null) as
        { id?: unknown; url?: unknown; error?: { code?: unknown; type?: unknown } } | null;
      if (response.status >= 200 && response.status < 300) {
        if (body && typeof body.id === "string" && /^cs_[A-Za-z0-9_]{1,250}$/.test(body.id)
          && typeof body.url === "string" && body.url.startsWith("https://"))
          return { id: body.id, url: body.url };
        throw new StripeRequestFailed("stripe_unreadable_response", true);
      }
      const name = typeof body?.error?.code === "string" ? body.error.code : typeof body?.error?.type === "string" ? body.error.type : "";
      const code = `stripe_${response.status}${name ? `_${name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 60)}` : ""}`;
      // 409 is a key still in flight; 429 and 5xx are Stripe's to retry. Anything else is ours.
      throw new StripeRequestFailed(code, response.status === 409 || response.status === 429 || response.status >= 500);
    },
  };
}

/** S-3: the event fields this system reads; the object stays raw for the worker. */
export const stripeEventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/),
  type: z.string().min(1).max(100),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEvent = z.infer<typeof stripeEventSchema>;

export const stripeWebhookSecretSchema = z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,200}$/, "A Stripe webhook secret looks like whsec_…");

export interface StripeWebhookSecrets {
  readonly current: string;
  readonly previous?: string | undefined;
}

export type StripeWebhookVerification =
  | { readonly ok: true; readonly event: StripeEvent; readonly payload: unknown }
  | { readonly ok: false; readonly reason: "missing_header" | "bad_signature" | "stale" | "bad_event" };

const stripeTag = (secret: string, signed: Buffer) => createHmac("sha256", secret).update(signed).digest();

/** The header value Stripe would send for this body; for tests and local tools. */
export function signStripeWebhook(secret: string, timestampSeconds: number, body: string | Uint8Array): string {
  const signed = Buffer.concat([Buffer.from(`${timestampSeconds}.`), Buffer.from(body)]);
  return `t=${timestampSeconds},v1=${stripeTag(secret, signed).toString("hex")}`;
}

/** S-3: signature over the exact bytes by a known secret, then the timestamp, then the shape. */
export function verifyStripeWebhook(input: {
  readonly secrets: StripeWebhookSecrets;
  readonly header: string | undefined;
  readonly body: Uint8Array;
  readonly now: Date;
  readonly toleranceMs?: number;
}): StripeWebhookVerification {
  const header = input.header;
  if (!header || header.length > 4096) return { ok: false, reason: "missing_header" };
  let timestamp: string | undefined;
  const given: Buffer[] = [];
  for (const part of header.split(",")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim();
    const value = part.slice(equals + 1).trim();
    if (key === "t" && timestamp === undefined) timestamp = value;
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) given.push(Buffer.from(value, "hex"));
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || given.length === 0) return { ok: false, reason: "missing_header" };
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(input.body)]);
  const expected = [input.secrets.current, input.secrets.previous]
    .filter((secret): secret is string => secret !== undefined)
    .map((secret) => stripeTag(secret, signed));
  let valid = false;
  for (const tag of given) for (const candidate of expected) if (timingSafeEqual(tag, candidate)) valid = true;
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (Math.abs(input.now.getTime() - Number(timestamp) * 1000) > (input.toleranceMs ?? STRIPE_WEBHOOK_TOLERANCE_MS))
    return { ok: false, reason: "stale" };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(input.body).toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_event" };
  }
  const event = stripeEventSchema.safeParse(payload);
  return event.success ? { ok: true, event: event.data, payload } : { ok: false, reason: "bad_event" };
}

const optionalInt = z.coerce.number().int().positive().optional();
const stripeEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1, "is required when any STRIPE_ variable is set"),
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecretSchema,
  STRIPE_WEBHOOK_PREVIOUS_SECRET: stripeWebhookSecretSchema.optional(),
  STRIPE_LIVEMODE: z.enum(["true", "false"], "must be true or false"),
  STRIPE_SUCCESS_URL: z.string().min(1, "is required when any STRIPE_ variable is set"),
  STRIPE_CANCEL_URL: z.string().min(1, "is required when any STRIPE_ variable is set"),
  STRIPE_CURRENCY: z.string().optional(),
  STRIPE_TOPUP_MIN: optionalInt,
  STRIPE_TOPUP_MAX: optionalInt,
  STRIPE_API_VERSION: z.string().optional(),
  STRIPE_BASE_URL: z.string().optional(),
});
const STRIPE_VARIABLES: Readonly<Record<string, string>> = {
  secretKey: "STRIPE_SECRET_KEY", successUrl: "STRIPE_SUCCESS_URL", cancelUrl: "STRIPE_CANCEL_URL",
  currency: "STRIPE_CURRENCY", minTopUp: "STRIPE_TOPUP_MIN", maxTopUp: "STRIPE_TOPUP_MAX",
  apiVersion: "STRIPE_API_VERSION", baseUrl: "STRIPE_BASE_URL",
};

export interface StripeEnv {
  readonly client: StripeConfig;
  readonly webhook: { readonly secrets: StripeWebhookSecrets; readonly livemode: boolean };
}

/**
 * S-9: the STRIPE_* variables, all or none. None set: null, and top-ups and the webhook are off.
 * Errors name variables, never values. The key's mode must match STRIPE_LIVEMODE.
 */
export function parseStripeEnv(env: Readonly<Record<string, string | undefined>>): StripeEnv | null {
  const given = Object.keys(stripeEnvSchema.shape).filter((name) => env[name] !== undefined && env[name] !== "");
  if (given.length === 0) return null;
  const parsed = stripeEnvSchema.safeParse(Object.fromEntries(given.map((name) => [name, env[name]])));
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const data = parsed.data;
  const client: StripeConfig = {
    secretKey: data.STRIPE_SECRET_KEY,
    successUrl: data.STRIPE_SUCCESS_URL,
    cancelUrl: data.STRIPE_CANCEL_URL,
    ...(data.STRIPE_CURRENCY === undefined ? {} : { currency: data.STRIPE_CURRENCY }),
    ...(data.STRIPE_TOPUP_MIN === undefined ? {} : { minTopUp: data.STRIPE_TOPUP_MIN }),
    ...(data.STRIPE_TOPUP_MAX === undefined ? {} : { maxTopUp: data.STRIPE_TOPUP_MAX }),
    ...(data.STRIPE_API_VERSION === undefined ? {} : { apiVersion: data.STRIPE_API_VERSION }),
    ...(data.STRIPE_BASE_URL === undefined ? {} : { baseUrl: data.STRIPE_BASE_URL }),
  };
  const checked = stripeConfigSchema.safeParse(client);
  if (!checked.success) throw new Error(`Invalid environment: ${checked.error.issues
    .map((issue) => `${issue.path.length === 0 ? "STRIPE_TOPUP_MIN, STRIPE_TOPUP_MAX" : STRIPE_VARIABLES[String(issue.path[0])] ?? "STRIPE_*"}: ${issue.message}`).join("; ")}`);
  const livemode = data.STRIPE_LIVEMODE === "true";
  if (/^(sk|rk)_live_/.test(data.STRIPE_SECRET_KEY) !== livemode)
    throw new Error("Invalid environment: STRIPE_LIVEMODE does not match the mode of STRIPE_SECRET_KEY");
  return {
    client,
    webhook: {
      livemode,
      secrets: {
        current: data.STRIPE_WEBHOOK_SECRET,
        ...(data.STRIPE_WEBHOOK_PREVIOUS_SECRET === undefined ? {} : { previous: data.STRIPE_WEBHOOK_PREVIOUS_SECRET }),
      },
    },
  };
}
