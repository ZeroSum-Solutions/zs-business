// The billing runner's environment (docs/requirements/stripe.md S-8, S-9). Parsed from an object an
// entry point passes in; this module never reads process.env. BILLING_WORKER is the kill switch:
// anything but `on` runs nothing and needs no other variable.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { shopifyBillingConfigSchema, type ShopifyBillingConfig } from "@zs/core";
import { DELIVERY_CRON_BUDGET_LIMIT_MS, PLACEHOLDER_CRON_SECRET } from "../cron-common.js";
import { int, LOOPBACK, problems } from "../env-schema.js";

const onSchema = z.object({
  // A login that may SET ROLE service_role: only the worker moves wallet money (delivery.md D-4).
  BILLING_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  BILLING_CLAIM_LIMIT: int(1, 500).default(50),
  // One run stops starting passes this long after it began; the cron entry allows at most 20 s.
  BILLING_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  // The Node worker's pause between runs.
  BILLING_INTERVAL_MS: int(1_000, 3_600_000).default(30_000),
  // plans.md PL-13: a restricted key that may only read subscriptions; without it plan events wait.
  BILLING_STRIPE_KEY: z.string().regex(/^rk_(test|live)_[A-Za-z0-9]{8,250}$/, "must be a Stripe restricted key").optional(),
  BILLING_STRIPE_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  BILLING_PLAN_GRACE_DAYS: int(1, 30).default(7),
  // plans.md PL-20: the Shopify pass; the four required ones come together or not at all.
  BILLING_SHOPIFY_SYNC_LIMIT: int(1, 100).default(20),
});

const SHOPIFY_REQUIRED = ["BILLING_SHOPIFY_PARTNER_ID", "BILLING_SHOPIFY_PARTNER_TOKEN", "BILLING_SHOPIFY_APP_ID", "BILLING_SHOPIFY_PLAN_HANDLES"] as const;
const SHOPIFY_OPTIONAL = ["BILLING_SHOPIFY_API_VERSION", "BILLING_SHOPIFY_BASE_URL", "BILLING_SHOPIFY_SYNC_LIMIT"] as const;

/** PL-20: the Partner API reader's config, or null when no BILLING_SHOPIFY_ variable is set. */
function parseShopify(source: Readonly<Record<string, string | undefined>>): ShopifyBillingConfig | null {
  const set = SHOPIFY_REQUIRED.filter((name) => source[name] !== undefined);
  const optional = SHOPIFY_OPTIONAL.filter((name) => source[name] !== undefined);
  if (set.length === 0) {
    if (optional.length > 0) throw new Error(`Invalid environment: ${optional.join(", ")} needs ${SHOPIFY_REQUIRED.join(", ")}`);
    return null;
  }
  if (set.length < SHOPIFY_REQUIRED.length)
    throw new Error(`Invalid environment: the Shopify pass needs all of ${SHOPIFY_REQUIRED.join(", ")}; missing ${SHOPIFY_REQUIRED.filter((name) => !set.includes(name)).join(", ")}`);
  let planHandles: unknown;
  try {
    planHandles = JSON.parse(source.BILLING_SHOPIFY_PLAN_HANDLES!);
  } catch {
    throw new Error("Invalid environment: BILLING_SHOPIFY_PLAN_HANDLES is not JSON");
  }
  const parsed = shopifyBillingConfigSchema.safeParse({
    partnerId: source.BILLING_SHOPIFY_PARTNER_ID,
    token: source.BILLING_SHOPIFY_PARTNER_TOKEN,
    appId: source.BILLING_SHOPIFY_APP_ID,
    planHandles,
    ...(source.BILLING_SHOPIFY_API_VERSION === undefined ? {} : { apiVersion: source.BILLING_SHOPIFY_API_VERSION }),
    ...(source.BILLING_SHOPIFY_BASE_URL === undefined ? {} : { baseUrl: source.BILLING_SHOPIFY_BASE_URL }),
  });
  // The token never appears in the message: only the paths of the fields that failed.
  if (!parsed.success) throw new Error(`Invalid environment: BILLING_SHOPIFY_ ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.path[0] === "token" ? "invalid" : issue.message}`).join("; ")}`);
  // The schema keeps the token to an https origin (http only on loopback), with no credentials or path.
  return parsed.data;
}

export interface BillingRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly claimLimit: number;
  readonly budgetMs: number;
  readonly intervalMs: number;
  /** PL-13: reads plan subscriptions again; null means plan events wait. */
  readonly stripeReader: { readonly secretKey: string; readonly baseUrl?: string } | null;
  readonly planGraceDays: number;
  /** PL-18, PL-20: the Shopify pass; null means it does not run. */
  readonly shopify: { readonly reader: ShopifyBillingConfig; readonly syncLimit: number } | null;
}

export interface BillingEnv {
  /** Null when BILLING_WORKER is not `on`: nothing runs. */
  readonly runner: BillingRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

/** S-8: the cron entry refuses a budget its Vercel function (stopped at 30 s) could not finish. */
export function assertBillingCronFits(runner: BillingRunnerEnv | null): void {
  if (runner !== null && runner.budgetMs > DELIVERY_CRON_BUDGET_LIMIT_MS)
    throw new Error(`Invalid environment: BILLING_RUN_BUDGET_MS must be at most ${DELIVERY_CRON_BUDGET_LIMIT_MS} for the cron function, which Vercel stops at 30 s`);
}

export function parseBillingEnv(env: Readonly<Record<string, string | undefined>>): BillingEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${problems(cron.error)}`);
  const switched = z.enum(["on", "off"]).default("off").safeParse(env.BILLING_WORKER);
  if (!switched.success) throw new Error("Invalid environment: BILLING_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  const shopify = parseShopify(env);
  let host: string;
  try {
    host = (parse(data.BILLING_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: BILLING_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when BILLING_DATABASE_URL is not a loopback host");
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.BILLING_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: BILLING_DATABASE_URL must not carry a query string");
  return {
    cronSecret: cron.data ?? null,
    runner: {
      serviceDatabaseUrl: data.BILLING_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      claimLimit: data.BILLING_CLAIM_LIMIT,
      budgetMs: data.BILLING_RUN_BUDGET_MS,
      intervalMs: data.BILLING_INTERVAL_MS,
      stripeReader: data.BILLING_STRIPE_KEY === undefined ? null : {
        secretKey: data.BILLING_STRIPE_KEY,
        ...(data.BILLING_STRIPE_BASE_URL === undefined ? {} : { baseUrl: data.BILLING_STRIPE_BASE_URL }),
      },
      planGraceDays: data.BILLING_PLAN_GRACE_DAYS,
      shopify: shopify === null ? null : { reader: shopify, syncLimit: data.BILLING_SHOPIFY_SYNC_LIMIT },
    },
  };
}
