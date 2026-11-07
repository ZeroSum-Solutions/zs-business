// The connections worker's environment (docs/requirements/connections.md C-2, C-3, C-7, C-9). Parsed
// from an object an entry point passes in; this module never reads process.env. The worker is on when
// any CONNECTIONS_ variable is set, and then every required one must be (all or none); with none set the
// internal routes answer 404. COMPOSIO_API_KEY is also named by other worker features, so it alone does
// not switch the worker on. Errors name variables, never values.
import { parse } from "pg-connection-string";
import { z } from "zod";
import { PLACEHOLDER_CRON_SECRET } from "../cron-common.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const REQUIRED = "is required when any CONNECTIONS_ variable is set";
const secret = () => z.string({ error: REQUIRED }).min(32, "must be at least 32 characters");
const httpsUrl = (what: string) => z.string({ error: REQUIRED }).max(2000).superRefine((value, ctx) => {
  let url: URL;
  try { url = new URL(value); } catch { ctx.addIssue({ code: "custom", message: "must be a URL" }); return; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) ctx.addIssue({ code: "custom", message: `${what} must be https (plain http only on loopback)` });
  if (url.username !== "" || url.password !== "" || url.hash !== "") ctx.addIssue({ code: "custom", message: `${what} must carry no credentials or fragment` });
});

const schema = z.object({
  COMPOSIO_API_KEY: z.string({ error: REQUIRED }).min(1, REQUIRED).max(512),
  CONNECTIONS_ENV: z.enum(["production", "preview"], { error: "must be production or preview" }),
  CONNECTIONS_INTERNAL_SECRET: secret(),
  CONNECTIONS_INTERNAL_PREVIOUS_SECRET: secret().optional(),
  // A login that may SET ROLE service_role, as the calendar worker's (C-7).
  CONNECTIONS_DATABASE_URL: z.string({ error: REQUIRED }).min(1, REQUIRED),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // The Shopify auth config made once per Composio project (C-2).
  CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID: z.string({ error: REQUIRED }).regex(/^[A-Za-z0-9_-]{1,128}$/, "must be a Composio auth config ID"),
  // The one dashboard URL Composio redirects to (C-3).
  CONNECTIONS_CALLBACK_URL: httpsUrl("CONNECTIONS_CALLBACK_URL"),
});

/** The names that switch the worker on. */
const SWITCHES = ["CONNECTIONS_ENV", "CONNECTIONS_INTERNAL_SECRET", "CONNECTIONS_INTERNAL_PREVIOUS_SECRET", "CONNECTIONS_DATABASE_URL",
  "CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID", "CONNECTIONS_CALLBACK_URL"] as const;

export interface ConnectionsWorkerRuntimeEnv {
  readonly env: "production" | "preview";
  readonly composioApiKey: string;
  readonly internalSecrets: { readonly current: string; readonly previous?: string };
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly authConfigIds: Readonly<Record<string, string>>;
  readonly callbackUrl: string;
}
export interface ConnectionsEnv {
  /** Null when no CONNECTIONS_ variable is set: the internal routes are 404 and the cron runs nothing. */
  readonly worker: ConnectionsWorkerRuntimeEnv | null;
  /** Null when CRON_SECRET is unset or the worker is off: the cron route answers 404. */
  readonly cronSecret: string | null;
}

export function parseConnectionsEnv(env: Readonly<Record<string, string | undefined>>): ConnectionsEnv {
  const set = (name: string) => env[name] !== undefined && env[name] !== "";
  // C-6: off means off, cron route included; CRON_SECRET is shared with other crons and judged only when on.
  if (!SWITCHES.some(set)) return { worker: null, cronSecret: null };
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${cron.error.issues.map((issue) => issue.message).join("; ")}`);
  const cronSecret = cron.data ?? null;

  const given = Object.fromEntries(Object.keys(schema.shape).filter(set).map((name) => [name, env[name]]));
  const parsed = schema.safeParse(given);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const data = parsed.data;
  let host: string;
  try {
    host = (parse(data.CONNECTIONS_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: CONNECTIONS_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when CONNECTIONS_DATABASE_URL is not a loopback host");
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.CONNECTIONS_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: CONNECTIONS_DATABASE_URL must not carry a query string");
  if (data.CONNECTIONS_INTERNAL_PREVIOUS_SECRET !== undefined && data.CONNECTIONS_INTERNAL_PREVIOUS_SECRET === data.CONNECTIONS_INTERNAL_SECRET)
    throw new Error("Invalid environment: CONNECTIONS_INTERNAL_PREVIOUS_SECRET must differ from CONNECTIONS_INTERNAL_SECRET");
  return {
    cronSecret,
    worker: {
      env: data.CONNECTIONS_ENV,
      composioApiKey: data.COMPOSIO_API_KEY,
      internalSecrets: {
        current: data.CONNECTIONS_INTERNAL_SECRET,
        ...(data.CONNECTIONS_INTERNAL_PREVIOUS_SECRET === undefined ? {} : { previous: data.CONNECTIONS_INTERNAL_PREVIOUS_SECRET }),
      },
      serviceDatabaseUrl: data.CONNECTIONS_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      authConfigIds: { shopify: data.CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID },
      callbackUrl: data.CONNECTIONS_CALLBACK_URL,
    },
  };
}
