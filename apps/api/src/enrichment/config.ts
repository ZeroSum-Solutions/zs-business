// The enrichment worker's environment (docs/requirements/enrichment.md E-5, E-9, E-16). Parsed from
// an object an entry point passes in; this module never reads process.env. ENRICHMENT_WORKER is the
// kill switch: anything but `on` runs nothing and needs no other variable. The Treg token is read
// here, in the worker only; the API process never sees it.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { parseEnrichmentEnv, type EnrichmentConfig } from "@zs/core";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const onSchema = z.object({
  // A login that may SET ROLE service_role (postgres on hosted Supabase). Never the API's runtime login.
  ENRICHMENT_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  ENRICHMENT_WORKER_ID: z.string().min(1).max(200).default("enrichment"),
  ENRICHMENT_CLAIM_LIMIT: int(1, 50).default(5),
  ENRICHMENT_PROVIDER_TIMEOUT_MS: int(1_000, 60_000).default(15_000),
  ENRICHMENT_INTERVAL_MS: int(1_000, 3_600_000).default(15_000),
  TREG_TOKEN: z.string().min(8).optional(),
  TREG_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
});

export interface EnrichmentRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly workerId: string;
  readonly claimLimit: number;
  readonly providerTimeoutMs: number;
  readonly intervalMs: number;
  readonly enrichment: EnrichmentConfig;
  /** Set only when ENRICHMENT_PROVIDER=treg. */
  readonly tregToken: string | undefined;
  readonly tregBaseUrl: string | undefined;
}

const problems = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

/** Null when ENRICHMENT_WORKER is not `on`: nothing runs. */
export function parseEnrichmentRunnerEnv(env: Readonly<Record<string, string | undefined>>): EnrichmentRunnerEnv | null {
  if (env.ENRICHMENT_WORKER !== "on") return null;
  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  let host: string;
  try {
    host = (parse(data.ENRICHMENT_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: ENRICHMENT_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when ENRICHMENT_DATABASE_URL is not a loopback host");
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.ENRICHMENT_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: ENRICHMENT_DATABASE_URL must not carry a query string");
  const enrichment = parseEnrichmentEnv(env);
  if (enrichment.provider === "treg" && data.TREG_TOKEN === undefined)
    throw new Error("Invalid environment: TREG_TOKEN is required when ENRICHMENT_PROVIDER=treg");
  return {
    serviceDatabaseUrl: data.ENRICHMENT_DATABASE_URL,
    databaseCaCert: data.DATABASE_CA_CERT,
    workerId: data.ENRICHMENT_WORKER_ID,
    claimLimit: data.ENRICHMENT_CLAIM_LIMIT,
    providerTimeoutMs: data.ENRICHMENT_PROVIDER_TIMEOUT_MS,
    intervalMs: data.ENRICHMENT_INTERVAL_MS,
    enrichment,
    tregToken: data.TREG_TOKEN,
    tregBaseUrl: data.TREG_BASE_URL,
  };
}
