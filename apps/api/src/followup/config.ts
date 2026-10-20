// The scheduled follow-up runner's environment (docs/requirements/agents.md G-13). Parsed from an
// object an entry point passes in; this module never reads process.env. FOLLOWUP_AGENT is the
// deploy's switch: anything but `on` runs nothing and needs no other variable.
import { parse } from "pg-connection-string";
import { z } from "zod";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Vercel's cron requests carry `Authorization: Bearer <CRON_SECRET>`. */
export const PLACEHOLDER_CRON_SECRET = "replace-with-a-cron-secret-of-32-or-more-chars";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const switchSchema = z.enum(["on", "off"]).default("off");

const onSchema = z.object({
  // The API's kind of login: unprivileged, member of authenticated only. Every agent action
  // runs through it under RLS, as the tenant's agent principal (G-1).
  FOLLOWUP_DATABASE_URL: z.string().min(1),
  // A login that may SET ROLE service_role, used for one read: which tenants are due (G-13).
  FOLLOWUP_SERVICE_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // The model behind the port (G-9). No real provider is wired yet; `fake` is the deterministic
  // stand-in and is allowed only against loopback databases.
  FOLLOWUP_MODEL: z.enum(["fake"], { error: "no real model provider is wired yet; only fake, on a loopback database" }),
  // One run per tenant per slot: a repeated call in the same slot continues that run.
  FOLLOWUP_SLOT_MINUTES: int(5, 1440).default(60),
  FOLLOWUP_MAX_CANDIDATES: int(1, 100).default(3),
  FOLLOWUP_MODEL_TIMEOUT_MS: int(1_000, 60_000).default(5_000),
  // One cron run stops starting tenants this long after it began; it must fit the function's limit.
  FOLLOWUP_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  // The Node worker's pause between runs.
  FOLLOWUP_INTERVAL_MS: int(1_000, 3_600_000).default(300_000),
});

export interface FollowUpRunnerEnv {
  readonly runtimeDatabaseUrl: string;
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly model: "fake";
  readonly slotMinutes: number;
  readonly maxCandidatesPerRun: number;
  readonly modelTimeoutMs: number;
  readonly budgetMs: number;
  readonly intervalMs: number;
}

export interface FollowUpEnv {
  /** Null when FOLLOWUP_AGENT is not `on`: nothing runs. */
  readonly runner: FollowUpRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

/**
 * Throws unless `url` can be used with pinned TLS: off loopback it needs DATABASE_CA_CERT and no
 * query string. Returns whether the host is loopback.
 */
export function checkDatabaseUrl(name: string, url: string, caCert: string | undefined): boolean {
  let host: string;
  try {
    host = (parse(url).host ?? "").toLowerCase();
  } catch {
    throw new Error(`Invalid environment: ${name} is not a valid connection string`);
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && caCert === undefined)
    throw new Error(`Invalid environment: DATABASE_CA_CERT is required when ${name} is not a loopback host`);
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || caCert !== undefined) && url.includes("?"))
    throw new Error(`Invalid environment: ${name} must not carry a query string`);
  return loopback;
}

export function parseFollowUpEnv(env: Readonly<Record<string, string | undefined>>): FollowUpEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${problems(cron.error)}`);
  const switched = switchSchema.safeParse(env.FOLLOWUP_AGENT);
  if (!switched.success) throw new Error("Invalid environment: FOLLOWUP_AGENT must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  const loopback = [
    checkDatabaseUrl("FOLLOWUP_DATABASE_URL", data.FOLLOWUP_DATABASE_URL, data.DATABASE_CA_CERT),
    checkDatabaseUrl("FOLLOWUP_SERVICE_DATABASE_URL", data.FOLLOWUP_SERVICE_DATABASE_URL, data.DATABASE_CA_CERT),
  ].every(Boolean);
  if (data.FOLLOWUP_MODEL === "fake" && !loopback)
    throw new Error("Invalid environment: FOLLOWUP_MODEL=fake runs only against loopback databases");
  // A tenant's run may wait one model timeout per inquiry; one tenant must fit the budget.
  if (data.FOLLOWUP_MAX_CANDIDATES * data.FOLLOWUP_MODEL_TIMEOUT_MS > data.FOLLOWUP_RUN_BUDGET_MS)
    throw new Error("Invalid environment: FOLLOWUP_MAX_CANDIDATES × FOLLOWUP_MODEL_TIMEOUT_MS must fit in FOLLOWUP_RUN_BUDGET_MS");
  return {
    cronSecret: cron.data ?? null,
    runner: {
      runtimeDatabaseUrl: data.FOLLOWUP_DATABASE_URL,
      serviceDatabaseUrl: data.FOLLOWUP_SERVICE_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      model: data.FOLLOWUP_MODEL,
      slotMinutes: data.FOLLOWUP_SLOT_MINUTES,
      maxCandidatesPerRun: data.FOLLOWUP_MAX_CANDIDATES,
      modelTimeoutMs: data.FOLLOWUP_MODEL_TIMEOUT_MS,
      budgetMs: data.FOLLOWUP_RUN_BUDGET_MS,
      intervalMs: data.FOLLOWUP_INTERVAL_MS,
    },
  };
}
