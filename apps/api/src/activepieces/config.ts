// The Activepieces webhook worker's environment (docs/requirements/activepieces.md W-14). Parsed
// from an object an entry point passes in; this module never reads process.env.
// ACTIVEPIECES_WEBHOOK_WORKER is the kill switch: anything but `on` runs nothing and needs no
// other variable.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { activepiecesKeySecretSchema, activepiecesLoopbackSchema, assertLoopbackOnly } from "../config.js";
import { PLACEHOLDER_CRON_SECRET } from "../delivery/config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const switchSchema = z.enum(["on", "off"]).default("off");

const onSchema = z.object({
  // A login that may SET ROLE service_role (postgres on hosted Supabase), like the delivery
  // worker's. Never the API's runtime login.
  ACTIVEPIECES_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // The same key the API derives signing secrets and tokens with.
  ACTIVEPIECES_KEY_SECRET: activepiecesKeySecretSchema,
  ACTIVEPIECES_KEY_PREVIOUS_SECRET: activepiecesKeySecretSchema.optional(),
  ACTIVEPIECES_ALLOW_LOOPBACK: activepiecesLoopbackSchema,
  ACTIVEPIECES_WORKER_ID: z.string().min(1).max(200).default("activepieces"),
  // One cron run stops starting work this long after it began; it must fit the function's limit.
  ACTIVEPIECES_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  ACTIVEPIECES_CLAIM_LIMIT: int(1, 50).default(2),
  ACTIVEPIECES_REQUEST_TIMEOUT_MS: int(1_000, 30_000).default(5_000),
  ACTIVEPIECES_MAX_ATTEMPTS: int(1, 50).default(8),
  // The Node worker's pause between runs.
  ACTIVEPIECES_INTERVAL_MS: int(1_000, 3_600_000).default(15_000),
});

export interface ActivepiecesRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly keySecrets: { readonly current: string; readonly previous?: string };
  readonly allowLoopback: boolean;
  readonly workerId: string;
  readonly budgetMs: number;
  readonly claimLimit: number;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
  readonly intervalMs: number;
}

export interface ActivepiecesWorkerEnv {
  /** Null when ACTIVEPIECES_WEBHOOK_WORKER is not `on`: nothing runs. */
  readonly runner: ActivepiecesRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

export function parseActivepiecesWorkerEnv(env: Readonly<Record<string, string | undefined>>): ActivepiecesWorkerEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${problems(cron.error)}`);
  const switched = switchSchema.safeParse(env.ACTIVEPIECES_WEBHOOK_WORKER);
  if (!switched.success) throw new Error("Invalid environment: ACTIVEPIECES_WEBHOOK_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  let host: string;
  try {
    host = (parse(data.ACTIVEPIECES_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: ACTIVEPIECES_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when ACTIVEPIECES_DATABASE_URL is not a loopback host");
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.ACTIVEPIECES_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: ACTIVEPIECES_DATABASE_URL must not carry a query string");
  const allowLoopback = data.ACTIVEPIECES_ALLOW_LOOPBACK === "on";
  if (allowLoopback) assertLoopbackOnly("ACTIVEPIECES_ALLOW_LOOPBACK", data.ACTIVEPIECES_DATABASE_URL);
  // A run must be able to finish its last receiver call inside the budget.
  if (data.ACTIVEPIECES_CLAIM_LIMIT * data.ACTIVEPIECES_REQUEST_TIMEOUT_MS > data.ACTIVEPIECES_RUN_BUDGET_MS)
    throw new Error("Invalid environment: ACTIVEPIECES_CLAIM_LIMIT × ACTIVEPIECES_REQUEST_TIMEOUT_MS must fit in ACTIVEPIECES_RUN_BUDGET_MS");
  return {
    cronSecret: cron.data ?? null,
    runner: {
      serviceDatabaseUrl: data.ACTIVEPIECES_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      keySecrets: {
        current: data.ACTIVEPIECES_KEY_SECRET,
        ...(data.ACTIVEPIECES_KEY_PREVIOUS_SECRET === undefined ? {} : { previous: data.ACTIVEPIECES_KEY_PREVIOUS_SECRET }),
      },
      allowLoopback,
      workerId: data.ACTIVEPIECES_WORKER_ID,
      budgetMs: data.ACTIVEPIECES_RUN_BUDGET_MS,
      claimLimit: data.ACTIVEPIECES_CLAIM_LIMIT,
      requestTimeoutMs: data.ACTIVEPIECES_REQUEST_TIMEOUT_MS,
      maxAttempts: data.ACTIVEPIECES_MAX_ATTEMPTS,
      intervalMs: data.ACTIVEPIECES_INTERVAL_MS,
    },
  };
}
