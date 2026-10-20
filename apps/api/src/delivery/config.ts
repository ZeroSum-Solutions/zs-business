// The delivery runner's environment (docs/requirements/resend.md R-9). Parsed from an object an
// entry point passes in; this module never reads process.env. DELIVERY_WORKER is the kill switch:
// anything but `on` runs nothing and needs no other variable.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { parseResendEnv, type ResendConfig } from "@zs/core";
import { PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET } from "../config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Vercel's cron requests carry `Authorization: Bearer <CRON_SECRET>`. */
export const PLACEHOLDER_CRON_SECRET = "replace-with-a-cron-secret-of-32-or-more-chars";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const switchSchema = z.enum(["on", "off"]).default("off");

const onSchema = z.object({
  // A login that may SET ROLE service_role (postgres on hosted Supabase): the worker is the
  // outbox processing entry point (delivery.md D-10). Never the API's runtime login.
  DELIVERY_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  DELIVERY_WORKER_ID: z.string().min(1).max(200).default("delivery"),
  // Minor units: what one email and one SMS segment cost the tenant's wallet (D-5).
  DELIVERY_PRICE_EMAIL: int(1, 1_000_000),
  DELIVERY_PRICE_SMS_SEGMENT: int(1, 1_000_000),
  DELIVERY_CURRENCY: z.string().regex(/^[a-z]{3}$/).default("usd"),
  // The same secret the API verifies unsubscribe links with (UNSUBSCRIBE_TOKEN_SECRET).
  UNSUBSCRIBE_TOKEN_SECRET: z.string().min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET, "UNSUBSCRIBE_TOKEN_SECRET is still the .env.example placeholder"),
  // Absolute https URL of the API's unsubscribe route, e.g. https://api.example.com/public/v1/unsubscribe
  DELIVERY_UNSUBSCRIBE_BASE_URL: z.url({ protocol: /^https$/ }),
  // One cron run stops starting work this long after it began; it must fit the function's limit.
  DELIVERY_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  DELIVERY_CLAIM_LIMIT: int(1, 50).default(2),
  DELIVERY_PROVIDER_TIMEOUT_MS: int(1_000, 60_000).default(5_000),
  // The Node worker's pause between runs.
  DELIVERY_INTERVAL_MS: int(1_000, 3_600_000).default(15_000),
});

export interface DeliveryRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly workerId: string;
  readonly pricing: { readonly currency: string; readonly email: number; readonly smsSegment: number };
  readonly unsubscribe: { readonly secret: string; readonly baseUrl: string };
  readonly resend: ResendConfig;
  readonly budgetMs: number;
  readonly claimLimit: number;
  readonly providerTimeoutMs: number;
  readonly intervalMs: number;
}

export interface DeliveryEnv {
  /** Null when DELIVERY_WORKER is not `on`: nothing runs. */
  readonly runner: DeliveryRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

export function parseDeliveryEnv(env: Readonly<Record<string, string | undefined>>): DeliveryEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${problems(cron.error)}`);
  const switched = switchSchema.safeParse(env.DELIVERY_WORKER);
  if (!switched.success) throw new Error("Invalid environment: DELIVERY_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  let host: string;
  try {
    host = (parse(data.DELIVERY_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: DELIVERY_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when DELIVERY_DATABASE_URL is not a loopback host");
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.DELIVERY_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: DELIVERY_DATABASE_URL must not carry a query string");
  // A run must be able to finish its last provider call inside the budget.
  if (data.DELIVERY_CLAIM_LIMIT * data.DELIVERY_PROVIDER_TIMEOUT_MS > data.DELIVERY_RUN_BUDGET_MS)
    throw new Error("Invalid environment: DELIVERY_CLAIM_LIMIT × DELIVERY_PROVIDER_TIMEOUT_MS must fit in DELIVERY_RUN_BUDGET_MS");
  return {
    cronSecret: cron.data ?? null,
    runner: {
      serviceDatabaseUrl: data.DELIVERY_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      workerId: data.DELIVERY_WORKER_ID,
      pricing: { currency: data.DELIVERY_CURRENCY, email: data.DELIVERY_PRICE_EMAIL, smsSegment: data.DELIVERY_PRICE_SMS_SEGMENT },
      unsubscribe: { secret: data.UNSUBSCRIBE_TOKEN_SECRET, baseUrl: data.DELIVERY_UNSUBSCRIBE_BASE_URL },
      resend: parseResendEnv(env),
      budgetMs: data.DELIVERY_RUN_BUDGET_MS,
      claimLimit: data.DELIVERY_CLAIM_LIMIT,
      providerTimeoutMs: data.DELIVERY_PROVIDER_TIMEOUT_MS,
      intervalMs: data.DELIVERY_INTERVAL_MS,
    },
  };
}
