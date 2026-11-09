// The outreach runner's environment (docs/requirements/outreach-sequencer.md OS-10, OS-13, OS-21). Parsed from an
// object an entry point passes in; this module never reads process.env. OUTREACH_WORKER is the kill switch: anything
// but `on` runs nothing and needs no other variable. OUTREACH_SEND_ENABLED is a second switch, true only for the exact
// string `true`; every other value, including `TRUE`, `1`, `yes` and a value with a space around it, leaves sending
// off. Errors name variables, never values.
import type { KeyObject } from "node:crypto";
import { parse } from "pg-connection-string";
import { z } from "zod";
import { parseOutreachTenants, parseSealPrivateKey, type GoogleClientConfig } from "@zs/core";
import { PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET } from "../config.js";
import { DELIVERY_CRON_BUDGET_LIMIT_MS, PLACEHOLDER_CRON_SECRET } from "../cron-common.js";
import { formatIssues, secureUrlVariable, signingSecretVariable } from "../calendar/google-env.js";
import { int, LOOPBACK } from "../env-schema.js";

const REQUIRED = "is required when OUTREACH_WORKER=on";

const onSchema = z.object({
  // A login that may SET ROLE service_role: the worker leases mailboxes and records sends and inbound mail.
  OUTREACH_DATABASE_URL: z.string({ error: REQUIRED }).min(1),
  // The API's kind of login (unprivileged, member of authenticated only): the bounce suppression runs through the shared
  // action path under RLS (OS-19), which a service login is refused for.
  OUTREACH_RUNTIME_DATABASE_URL: z.string({ error: REQUIRED }).min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  // OS-1: comma-separated tenant ids. The worker touches no other tenant.
  OUTREACH_TENANTS: z.string({ error: REQUIRED }).transform((value, ctx) => {
    try {
      const tenants = parseOutreachTenants(value);
      if (tenants.length === 0) throw new Error("empty");
      return tenants;
    } catch {
      ctx.addIssue({ code: "custom", message: "must hold at least one comma-separated tenant UUID" });
      return z.NEVER;
    }
  }),
  OUTREACH_GOOGLE_CLIENT_ID: z.string({ error: REQUIRED }).min(1, REQUIRED).max(512, "must be at most 512 characters"),
  OUTREACH_GOOGLE_CLIENT_SECRET: z.string({ error: REQUIRED }).min(1, REQUIRED).max(512, "must be at most 512 characters"),
  // Tests point these at a loopback fake; unset, Google's own hosts are used.
  GOOGLE_TOKEN_BASE_URL: secureUrlVariable("GOOGLE_TOKEN_BASE_URL").optional(),
  OUTREACH_GMAIL_BASE_URL: secureUrlVariable("OUTREACH_GMAIL_BASE_URL").optional(),
  // Base64 of the DER PKCS#8 of the X25519 key that opens sealed refresh tokens (OS-21); its own pair, not the calendar's.
  OUTREACH_TOKEN_PRIVATE_KEY: z.string({ error: REQUIRED }).transform((value, ctx) => {
    try {
      return parseSealPrivateKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be base64 of the DER PKCS#8 of an X25519 private key" });
      return z.NEVER;
    }
  }),
  // OS-18: the same secret and base URL the delivery worker and the API's unsubscribe route use.
  UNSUBSCRIBE_TOKEN_SECRET: signingSecretVariable().refine((value) => value !== PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET, "is still the .env.example placeholder"),
  DELIVERY_UNSUBSCRIBE_BASE_URL: z.url({ protocol: /^https$/, error: "must be an https URL" }),
  OUTREACH_MAILBOX_DAILY_LIMIT: int(1, 50).default(20),
  OUTREACH_SENDS_PER_TICK: int(1, 5).default(1),
  OUTREACH_MIN_GAP_MS: int(0, 86_400_000).default(240_000),
  OUTREACH_PROBE_DELAY_MS: int(0, 86_400_000).default(120_000),
  // One run stops starting Gmail calls this long after it began; the cron entry allows at most 20 s.
  OUTREACH_RUN_BUDGET_MS: int(1, 600_000).default(20_000),
});

export interface OutreachRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly runtimeDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  readonly tenants: readonly string[];
  /** The token endpoint client: refresh and revoke only. */
  readonly client: GoogleClientConfig;
  readonly gmailBaseUrl: string | undefined;
  readonly privateKey: KeyObject;
  /** OS-10: true only for the exact string `true`. */
  readonly sendEnabled: boolean;
  readonly unsubscribe: { readonly secret: string; readonly baseUrl: string };
  readonly mailboxDailyLimit: number;
  readonly sendsPerTick: number;
  readonly minGapMs: number;
  readonly probeDelayMs: number;
  readonly budgetMs: number;
}

export interface OutreachEnv {
  /** Null when OUTREACH_WORKER is not `on`: nothing runs. */
  readonly runner: OutreachRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

/** OS-10: the one place the send switch is read. */
export const outreachSendEnabled = (value: string | undefined): boolean => value === "true";

/** The cron entry refuses a budget its Vercel function (stopped at 30 s) could not finish (OS-13). */
export function assertOutreachCronFits(runner: OutreachRunnerEnv | null): void {
  if (runner !== null && runner.budgetMs > DELIVERY_CRON_BUDGET_LIMIT_MS)
    throw new Error(`Invalid environment: OUTREACH_RUN_BUDGET_MS must be at most ${DELIVERY_CRON_BUDGET_LIMIT_MS} for the cron function, which Vercel stops at 30 s`);
}

export function checkOutreachDatabaseUrl(name: string, url: string, caCert: string | undefined): void {
  checkUrl(name, url, caCert);
}

function checkUrl(name: string, url: string, caCert: string | undefined): void {
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

export function parseOutreachEnv(env: Readonly<Record<string, string | undefined>>): OutreachEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${cron.error.issues.map((issue) => issue.message).join("; ")}`);
  const switched = z.enum(["on", "off"]).default("off").safeParse(env.OUTREACH_WORKER);
  if (!switched.success) throw new Error("Invalid environment: OUTREACH_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  // Empty optional values count as unset, as the API's GOOGLE_ variables do.
  const given = Object.fromEntries(Object.keys(onSchema.shape).filter((name) => env[name] !== undefined && env[name] !== "")
    .map((name) => [name, env[name]]));
  const parsed = onSchema.safeParse(given);
  if (!parsed.success) throw new Error(formatIssues(parsed.error));
  const data = parsed.data;
  checkUrl("OUTREACH_DATABASE_URL", data.OUTREACH_DATABASE_URL, data.DATABASE_CA_CERT);
  checkUrl("OUTREACH_RUNTIME_DATABASE_URL", data.OUTREACH_RUNTIME_DATABASE_URL, data.DATABASE_CA_CERT);
  return {
    cronSecret: cron.data ?? null,
    runner: {
      serviceDatabaseUrl: data.OUTREACH_DATABASE_URL,
      runtimeDatabaseUrl: data.OUTREACH_RUNTIME_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      tenants: data.OUTREACH_TENANTS,
      client: {
        clientId: data.OUTREACH_GOOGLE_CLIENT_ID,
        clientSecret: data.OUTREACH_GOOGLE_CLIENT_SECRET,
        ...(data.GOOGLE_TOKEN_BASE_URL === undefined ? {} : { tokenBaseUrl: data.GOOGLE_TOKEN_BASE_URL }),
      },
      gmailBaseUrl: data.OUTREACH_GMAIL_BASE_URL,
      privateKey: data.OUTREACH_TOKEN_PRIVATE_KEY,
      sendEnabled: outreachSendEnabled(env.OUTREACH_SEND_ENABLED),
      unsubscribe: { secret: data.UNSUBSCRIBE_TOKEN_SECRET, baseUrl: data.DELIVERY_UNSUBSCRIBE_BASE_URL },
      mailboxDailyLimit: data.OUTREACH_MAILBOX_DAILY_LIMIT,
      sendsPerTick: data.OUTREACH_SENDS_PER_TICK,
      minGapMs: data.OUTREACH_MIN_GAP_MS,
      probeDelayMs: data.OUTREACH_PROBE_DELAY_MS,
      budgetMs: data.OUTREACH_RUN_BUDGET_MS,
    },
  };
}
