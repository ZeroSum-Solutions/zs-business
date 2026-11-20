// The document intake sweep's environment (docs/requirements/document-intake.md DL-16). Parsed from an object
// an entry point passes in; this module never reads process.env. INTAKE_SWEEP_WORKER is the kill switch: anything but
// `on` runs nothing and needs no other variable, so a deploy never starts deleting files by itself.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { PLACEHOLDER_CRON_SECRET } from "../cron-common.js";
import { int, LOOPBACK, problems, switchSchema } from "../env-schema.js";

const onSchema = z.object({
  // The API's kind of login: unprivileged, member of authenticated only. The sweep reads and marks the jobs through
  // the platform transaction of the scoped database, under RLS (DL-5), never as a service login.
  INTAKE_SWEEP_DATABASE_URL: z.string().min(1),
  // A login that may SET ROLE service_role, used for the cron failure alerts only (cron-alerts.ts).
  INTAKE_SWEEP_SERVICE_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // The bucket the API's site store uses (SITES_STORE=r2): intake PDFs live there at `t/<tenant>/intake/<job>/<sha>.pdf`
  // with no key prefix, so the sweep must name the same bucket the upload routes write to.
  R2_ENDPOINT: z.url({ protocol: /^https$/ }),
  R2_BUCKET: z.string().min(3).max(63),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  // Jobs examined per run at most, and the time one run may spend starting more of them. The deletes are sequential,
  // so the budget (not the batch) keeps a run inside the cron function's 30 s with time left to answer and alert.
  INTAKE_SWEEP_BATCH: int(1, 200).default(50),
  INTAKE_SWEEP_RUN_BUDGET_MS: int(1000, 20_000).default(15_000),
});

export interface IntakeSweepRunnerEnv {
  readonly runtimeDatabaseUrl: string;
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly r2: { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly batch: number;
  readonly runBudgetMs: number;
}

export interface IntakeSweepEnv {
  /** Null when INTAKE_SWEEP_WORKER is not `on`: nothing runs. */
  readonly runner: IntakeSweepRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

/** Off loopback a login needs DATABASE_CA_CERT and no query string, as the API's does. */
function checkDatabaseUrl(name: string, url: string, caCert: string | undefined): void {
  let host: string;
  try {
    host = (parse(url).host ?? "").toLowerCase();
  } catch {
    throw new Error(`Invalid environment: ${name} is not a valid connection string`);
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && caCert === undefined) throw new Error(`Invalid environment: DATABASE_CA_CERT is required when ${name} is not a loopback host`);
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || caCert !== undefined) && url.includes("?")) throw new Error(`Invalid environment: ${name} must not carry a query string`);
}

export function parseIntakeSweepEnv(env: Readonly<Record<string, string | undefined>>): IntakeSweepEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${problems(cron.error)}`);
  const switched = switchSchema.safeParse(env.INTAKE_SWEEP_WORKER);
  if (!switched.success) throw new Error("Invalid environment: INTAKE_SWEEP_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  const parsed = onSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid environment: ${problems(parsed.error)}`);
  const data = parsed.data;
  checkDatabaseUrl("INTAKE_SWEEP_DATABASE_URL", data.INTAKE_SWEEP_DATABASE_URL, data.DATABASE_CA_CERT);
  checkDatabaseUrl("INTAKE_SWEEP_SERVICE_DATABASE_URL", data.INTAKE_SWEEP_SERVICE_DATABASE_URL, data.DATABASE_CA_CERT);
  return {
    cronSecret: cron.data ?? null,
    runner: {
      runtimeDatabaseUrl: data.INTAKE_SWEEP_DATABASE_URL,
      serviceDatabaseUrl: data.INTAKE_SWEEP_SERVICE_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      r2: { endpoint: data.R2_ENDPOINT, bucket: data.R2_BUCKET, accessKeyId: data.R2_ACCESS_KEY_ID, secretAccessKey: data.R2_SECRET_ACCESS_KEY },
      batch: data.INTAKE_SWEEP_BATCH,
      runBudgetMs: data.INTAKE_SWEEP_RUN_BUDGET_MS,
    },
  };
}
