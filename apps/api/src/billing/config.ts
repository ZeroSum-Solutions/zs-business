// The billing runner's environment (docs/requirements/stripe.md S-8, S-9). Parsed from an object an
// entry point passes in; this module never reads process.env. BILLING_WORKER is the kill switch:
// anything but `on` runs nothing and needs no other variable.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { DELIVERY_CRON_BUDGET_LIMIT_MS, PLACEHOLDER_CRON_SECRET } from "../delivery/config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const onSchema = z.object({
  // A login that may SET ROLE service_role: only the worker moves wallet money (delivery.md D-4).
  BILLING_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  BILLING_CLAIM_LIMIT: int(1, 500).default(50),
  // One run stops starting passes this long after it began; the cron entry allows at most 20 s.
  BILLING_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  // The Node worker's pause between runs.
  BILLING_INTERVAL_MS: int(1_000, 3_600_000).default(30_000),
});

export interface BillingRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly claimLimit: number;
  readonly budgetMs: number;
  readonly intervalMs: number;
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

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

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
    },
  };
}
