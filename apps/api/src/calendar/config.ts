// The calendar runner's environment (docs/requirements/google-calendar.md G-6..G-12). Parsed from
// an object an entry point passes in; this module never reads process.env. CALENDAR_WORKER is the
// kill switch: anything but `on` runs nothing and needs no other variable. Errors name variables,
// never values.
import type { KeyObject } from "node:crypto";
import { parse } from "pg-connection-string";
import { z } from "zod";
import { parseSealPrivateKey, type GoogleClientConfig } from "@zs/core";
import { PLACEHOLDER_CRON_SECRET } from "../delivery/config.js";
import { formatIssues, googleClientFromVariables, googleClientVariables, signingSecretVariable } from "./google-env.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const onSchema = z.object({
  // A login that may SET ROLE service_role: only the worker writes external blocks (booking.md B-21).
  CALENDAR_DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  ...googleClientVariables,
  // Base64 of the DER PKCS#8 of the X25519 key that opens sealed refresh tokens (G-3).
  GOOGLE_TOKEN_PRIVATE_KEY: z.string({ error: "is required when CALENDAR_WORKER=on" }).transform((value, ctx) => {
    try {
      return parseSealPrivateKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be base64 of the DER PKCS#8 of an X25519 private key" });
      return z.NEVER;
    }
  }),
  // The same secret the API checks X-Goog-Channel-Token with (G-8).
  GOOGLE_CHANNEL_SECRET: signingSecretVariable(),
  // https://<api host>/webhooks/google/calendar; unset, no push channels are opened.
  GOOGLE_WEBHOOK_URL: z.url({ protocol: /^https$/, error: "must be an https URL" }).optional(),
  // G-10: the summary of every pushed event; no customer data.
  GOOGLE_EVENT_TITLE: z.string().trim().min(1, "must not be blank").max(200, "must be at most 200 characters").optional(),
  // One cron run stops starting passes this long after it began.
  CALENDAR_RUN_BUDGET_MS: int(1_000, 600_000).default(20_000),
  // The Node worker's pause between runs.
  CALENDAR_INTERVAL_MS: int(1_000, 3_600_000).default(60_000),
});

export interface CalendarRunnerEnv {
  readonly serviceDatabaseUrl: string;
  readonly databaseCaCert: string | undefined;
  /** No redirect URL: the worker refreshes, lists, inserts and watches, and never exchanges a code. */
  readonly client: GoogleClientConfig;
  readonly privateKey: KeyObject;
  readonly channelSecret: string;
  readonly webhookUrl: string | undefined;
  readonly eventTitle: string | undefined;
  readonly budgetMs: number;
  readonly intervalMs: number;
}

export interface CalendarEnv {
  /** Null when CALENDAR_WORKER is not `on`: nothing runs. */
  readonly runner: CalendarRunnerEnv | null;
  /** Null when CRON_SECRET is unset: the cron route answers 404. */
  readonly cronSecret: string | null;
}

export function parseCalendarEnv(env: Readonly<Record<string, string | undefined>>): CalendarEnv {
  const cron = z.string().min(32, "CRON_SECRET must be at least 32 characters")
    .refine((value) => value !== PLACEHOLDER_CRON_SECRET, "CRON_SECRET is still the .env.example placeholder")
    .optional().safeParse(env.CRON_SECRET);
  if (!cron.success) throw new Error(`Invalid environment: ${cron.error.issues.map((issue) => issue.message).join("; ")}`);
  const switched = z.enum(["on", "off"]).default("off").safeParse(env.CALENDAR_WORKER);
  if (!switched.success) throw new Error("Invalid environment: CALENDAR_WORKER must be on or off");
  if (switched.data === "off") return { runner: null, cronSecret: cron.data ?? null };

  // Empty optional values count as unset, as the API's GOOGLE_ variables do.
  const given = Object.fromEntries(Object.keys(onSchema.shape).filter((name) => env[name] !== undefined && env[name] !== "")
    .map((name) => [name, env[name]]));
  const parsed = onSchema.safeParse(given);
  if (!parsed.success) throw new Error(formatIssues(parsed.error));
  const data = parsed.data;
  let host: string;
  try {
    host = (parse(data.CALENDAR_DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    throw new Error("Invalid environment: CALENDAR_DATABASE_URL is not a valid connection string");
  }
  const loopback = LOOPBACK.has(host);
  if (!loopback && data.DATABASE_CA_CERT === undefined)
    throw new Error("Invalid environment: DATABASE_CA_CERT is required when CALENDAR_DATABASE_URL is not a loopback host");
  // URL options (sslmode, ssl) would replace the pinned TLS settings.
  if ((!loopback || data.DATABASE_CA_CERT !== undefined) && data.CALENDAR_DATABASE_URL.includes("?"))
    throw new Error("Invalid environment: CALENDAR_DATABASE_URL must not carry a query string");
  return {
    cronSecret: cron.data ?? null,
    runner: {
      serviceDatabaseUrl: data.CALENDAR_DATABASE_URL,
      databaseCaCert: data.DATABASE_CA_CERT,
      client: googleClientFromVariables(data),
      privateKey: data.GOOGLE_TOKEN_PRIVATE_KEY,
      channelSecret: data.GOOGLE_CHANNEL_SECRET,
      webhookUrl: data.GOOGLE_WEBHOOK_URL,
      eventTitle: data.GOOGLE_EVENT_TITLE,
      budgetMs: data.CALENDAR_RUN_BUDGET_MS,
      intervalMs: data.CALENDAR_INTERVAL_MS,
    },
  };
}
