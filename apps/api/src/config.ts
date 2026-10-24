import { parse } from "pg-connection-string";
import { z } from "zod";
import {
  formatEnvIssues,
  jwtEnvSchema,
  parseStripeEnv,
  resendWebhookSecretSchema,
  secureUrlProblem,
  sessionCheckEnvSchema,
  trimTrailingSlashes,
  twilioAccountSidSchema,
  twilioAuthTokenSchema,
  type JwtConfig,
  type KeywordReplies,
  type SessionCheckConfig,
  type StripeEnv,
} from "@zs/core";
import { assertLocalDatabaseUrl } from "@zs/db";
import { trustedProxyList, type ClientIpConfig } from "./public/client-ip.js";
import { parseGoogleEnv, type GoogleEnv } from "./calendar/google-env.js";

// The JWT_* variables (signing method, secret or JWKS URL, issuer, lifetime, skew) are parsed
// by the schema in @zs/core, shared with the MCP server.
export { jwtSecretSchema, PLACEHOLDER_JWT_SECRET } from "@zs/core";
export { assertLocalDatabaseUrl, assertLocalPool, describeDatabase, type LocalDatabaseTarget } from "@zs/db";
export { parseGoogleEnv, type GoogleEnv } from "./calendar/google-env.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The .env.example value for the booking key secret; a server that still uses it must not start. */
export const PLACEHOLDER_BOOKING_KEY_SECRET = "replace-with-a-booking-key-secret-of-32-or-more-chars";
/** The .env.example value for the unsubscribe token secret; refused like the booking placeholder. */
export const PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET = "replace-with-an-unsubscribe-token-secret-of-32-or-more-chars";
/** A signing secret: 32 or more characters and not the .env.example placeholder. Shared with the follow-up runner. */
export const signingSecretSchema = (what: string, placeholder: string) => z.string()
  .min(32, `${what} secrets must be at least 32 characters`)
  .refine((value) => value !== placeholder, `${what} secret is still the .env.example placeholder`);
/** The .env.example value for the Activepieces key secret; refused like the others. */
export const PLACEHOLDER_ACTIVEPIECES_KEY_SECRET = "replace-with-an-activepieces-key-secret-of-32-or-more-chars";
export const bookingKeySecretSchema = signingSecretSchema("booking key", PLACEHOLDER_BOOKING_KEY_SECRET);
/** PUBLIC_BASE_URL: an http or https URL; callers trim its trailing slashes. */
export const publicBaseUrlSchema = z.url({ protocol: /^https?$/ });
export const activepiecesKeySecretSchema = signingSecretSchema("Activepieces key", PLACEHOLDER_ACTIVEPIECES_KEY_SECRET);
/** Loopback receivers (http://127.0.0.1) for local development; only with a loopback database. */
export const activepiecesLoopbackSchema = z.enum(["on", "off"]).default("off");
const unsubscribeTokenSecretSchema = signingSecretSchema("unsubscribe token", PLACEHOLDER_UNSUBSCRIBE_TOKEN_SECRET);
/** Headers that hosting platforms overwrite, so a caller cannot choose the value. */
export const CLIENT_IP_HEADERS = ["x-vercel-forwarded-for", "x-real-ip", "cf-connecting-ip", "fly-client-ip"] as const;
const rateLimit = z.coerce.number().int().min(1).max(1_000_000).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORIGINS: z.string().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  // public-intake.md P-2: signs booking page keys. Unset turns the public booking routes off.
  PUBLIC_BOOKING_KEY_SECRET: bookingKeySecretSchema.optional(),
  // The previous secret keeps verifying during a rotation; keys are re-signed with the current one.
  PUBLIC_BOOKING_KEY_PREVIOUS_SECRET: bookingKeySecretSchema.optional(),
  // Origin of the hosted booking page and embed script; defaults to http://localhost:<PORT>.
  PUBLIC_BASE_URL: publicBaseUrlSchema.optional(),
  // P-10: a header the host overwrites on every request (Vercel: x-vercel-forwarded-for or
  // x-real-ip), set only when the API is reachable through that host alone.
  PUBLIC_CLIENT_IP_HEADER: z.enum(CLIENT_IP_HEADERS).optional(),
  // Or: comma-separated CIDRs of the proxies whose X-Forwarded-For entries count.
  PUBLIC_TRUSTED_PROXIES: z.string().optional(),
  PUBLIC_RATE_ADDRESS_WRITES: rateLimit,
  PUBLIC_RATE_ADDRESS_READS: rateLimit,
  PUBLIC_RATE_TENANT_WRITES: rateLimit,
  // P-10: where the public booking and unsubscribe limits count. postgres (default): one shared
  // table for every instance. memory: per process, loopback databases only (local runs and tests).
  PUBLIC_RATE_LIMIT_STORE: z.enum(["postgres", "memory"]).default("postgres"),
  // delivery.md D-9: verifies the List-Unsubscribe tokens in outgoing email (the delivery worker
  // signs them with the same secret). Unset turns the public unsubscribe routes off.
  UNSUBSCRIBE_TOKEN_SECRET: unsubscribeTokenSecretSchema.optional(),
  // The previous secret keeps verifying links in mail sent before a rotation.
  UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET: unsubscribeTokenSecretSchema.optional(),
  // resend.md R-7: the signing secret of the Resend webhook endpoint (whsec_…). Unset turns
  // POST /webhooks/resend off. The previous secret keeps verifying during a rotation.
  RESEND_WEBHOOK_SECRET: resendWebhookSecretSchema.optional(),
  RESEND_WEBHOOK_PREVIOUS_SECRET: resendWebhookSecretSchema.optional(),
  // twilio.md T-6, T-9: the account's auth token verifies X-Twilio-Signature. Unset turns the
  // /webhooks/twilio routes off. The previous token keeps verifying during a rotation.
  TWILIO_AUTH_TOKEN: twilioAuthTokenSchema.optional(),
  TWILIO_PREVIOUS_AUTH_TOKEN: twilioAuthTokenSchema.optional(),
  TWILIO_ACCOUNT_SID: twilioAccountSidSchema.optional(),
  // The API's public origin as Twilio calls it; signatures cover this URL, not the Host header.
  TWILIO_WEBHOOK_BASE_URL: z.string().optional(),
  // T-8: `provider` (Twilio's own opt-out replies) or `app` (this API answers in TwiML).
  TWILIO_KEYWORD_REPLIES: z.enum(["provider", "app"]).default("provider"),
  // activepieces.md W-14: derives webhook signing secrets and automation tokens. Unset turns the
  // /v1/integrations/activepieces and /integrations/activepieces routes off. The previous secret
  // keeps tokens and signatures valid during a rotation.
  ACTIVEPIECES_KEY_SECRET: activepiecesKeySecretSchema.optional(),
  ACTIVEPIECES_KEY_PREVIOUS_SECRET: activepiecesKeySecretSchema.optional(),
  ACTIVEPIECES_ALLOW_LOOPBACK: activepiecesLoopbackSchema,
  // PEM of the CA that signs the database's TLS certificate (hosted Supabase: the Supabase
  // Root 2021 CA in supabase/hosted/). Set: TLS with full verification. Required for any
  // host other than loopback; only a loopback database may use plain TCP.
  DATABASE_CA_CERT: z.string().includes("BEGIN CERTIFICATE").optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  // Longest wait for a pooled connection; node-postgres would otherwise wait forever.
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5000),
  // Longest time one /v1 request may take; keep it under the dashboard proxy's 15 s.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
  // M4b site publishing. Unset turns the /v1/sites routes off. `r2`: Cloudflare R2 through its
  // S3 API (the R2_* variables); `memory`: an in-process store, loopback DATABASE_URL only.
  SITES_STORE: z.enum(["r2", "memory"]).optional(),
  // The compiler that turns a site spec into files. `plain` is built in; the Mish publisher
  // is wired in code (createServer's siteCompiler) when the Mac adds it.
  SITE_COMPILER: z.enum(["plain"]).default("plain"),
  R2_ENDPOINT: z.url({ protocol: /^https$/ }).optional(),
  R2_BUCKET: z.string().min(3).max(63).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
}).superRefine((env, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  let host: string;
  try {
    // The host pg will actually use: a query parameter such as host overrides the URL's.
    host = (parse(env.DATABASE_URL).host ?? "").toLowerCase();
  } catch {
    // Never echo the value: it holds the password.
    issue("DATABASE_URL", "is not a valid connection string");
    return;
  }
  const loopback = LOOPBACK.has(host);
  if (env.SITES_STORE === "memory" && !loopback)
    issue("SITES_STORE", "memory is for local runs: it needs a loopback DATABASE_URL");
  if (env.SITES_STORE === "r2")
    for (const name of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const)
      if (env[name] === undefined) issue(name, "is required when SITES_STORE=r2");
  if (!loopback && env.DATABASE_CA_CERT === undefined)
    issue("DATABASE_CA_CERT", "is required when DATABASE_URL is not a loopback host (127.0.0.1, ::1, localhost)");
  // pg lets URL options (ssl, sslmode, also percent-encoded) replace the ssl config, which
  // would drop the CA check or TLS itself, so a remote or verified URL carries no query string.
  if ((!loopback || env.DATABASE_CA_CERT !== undefined) && env.DATABASE_URL.includes("?"))
    issue("DATABASE_URL", "must not carry a query string when it is not a loopback host or DATABASE_CA_CERT is set");
  // Per-process counters let every serverless instance grant the full limit again.
  if (env.PUBLIC_RATE_LIMIT_STORE === "memory" && !loopback)
    issue("PUBLIC_RATE_LIMIT_STORE", "memory needs a loopback DATABASE_URL; hosted deploys count in Postgres");
});
export interface ServerEnv {
  readonly databaseUrl: string;
  /** How access tokens are verified: `JWT_VERIFIER=hs256` with JWT_SECRET, or `jwks` with JWT_JWKS_URL. */
  readonly jwt: JwtConfig;
  /** How a token's session is checked: `SESSION_CHECK=supabase` (Supabase Auth) or `local-stub` (loopback only). */
  readonly sessionCheck: SessionCheckConfig;
  readonly allowedOrigins: string[];
  readonly port: number;
  readonly databaseCaCert: string | undefined;
  readonly databasePoolMax: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** P-10: where the public route limits count: one Postgres table shared by every instance, or this process. */
  readonly rateLimitStore: "postgres" | "memory";
  readonly publicIntake: PublicIntakeEnv | null;
  readonly sites: SitesEnv | null;
  readonly unsubscribe: UnsubscribeEnv | null;
  readonly resendWebhook: ResendWebhookEnv | null;
  /** stripe.md S-9: wallet top-ups and the Stripe webhook; null (both off) when no STRIPE_ variable is set. */
  readonly stripe: StripeEnv | null;
  /** google-calendar.md G-12: connecting, the OAuth callback and the push webhook; null (all off) when no API GOOGLE_ variable is set. */
  readonly google: GoogleEnv | null;
  readonly twilioWebhook: TwilioWebhookEnv | null;
  readonly activepieces: ActivepiecesEnv | null;
}
export interface ActivepiecesEnv {
  readonly keySecrets: { readonly current: string; readonly previous?: string };
  /** True only on a loopback database: receiver URLs may then point at 127.0.0.1 over http. */
  readonly allowLoopback: boolean;
}
export interface TwilioWebhookEnv {
  readonly tokens: { readonly current: string; readonly previous?: string };
  readonly accountSid: string;
  readonly webhookBaseUrl: string;
  readonly keywordReplies: KeywordReplies;
}
export interface ResendWebhookEnv {
  readonly secrets: { readonly current: string; readonly previous?: string };
}
export interface SitesEnv {
  readonly store:
    | { readonly kind: "memory" }
    | { readonly kind: "r2"; readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly compiler: "plain";
}
export interface PublicIntakeEnv {
  readonly keySecrets: { readonly current: string; readonly previous?: string };
  readonly publicBaseUrl: string;
  readonly clientIp: ClientIpConfig;
  /** Per-window counts that override the P-10 defaults; windows stay fixed. */
  readonly limitOverrides: { readonly addressWrites?: number; readonly addressReads?: number; readonly tenantWrites?: number };
}

export interface UnsubscribeEnv {
  readonly tokenSecrets: { readonly current: string; readonly previous?: string };
  readonly clientIp: ClientIpConfig;
  /** PUBLIC_RATE_ADDRESS_* overrides; the unsubscribe routes count in their own buckets. */
  readonly limitOverrides: { readonly addressWrites?: number; readonly addressReads?: number };
}

/** Parse an environment object passed in by an entry point; this module never reads process.env. */
export function parseServerEnv(env: Readonly<Record<string, string | undefined>>): ServerEnv {
  // A stale TRUST_PROXY=1 would otherwise be ignored silently and every caller share one bucket.
  if (env.TRUST_PROXY !== undefined && env.TRUST_PROXY !== "0")
    throw new Error("Invalid environment: TRUST_PROXY was replaced by PUBLIC_CLIENT_IP_HEADER or PUBLIC_TRUSTED_PROXIES");
  const parsed = envSchema.safeParse(env);
  const jwt = jwtEnvSchema.safeParse(env);
  const sessionCheck = sessionCheckEnvSchema.safeParse(env);
  const issues = [...(parsed.error?.issues ?? []), ...(jwt.error?.issues ?? []), ...(sessionCheck.error?.issues ?? [])];
  if (sessionCheck.success && env.DATABASE_URL) issues.push(...localStubIssues(sessionCheck.data, env.DATABASE_URL));
  if (!parsed.success || !jwt.success || !sessionCheck.success || issues.length > 0) throw new Error(formatEnvIssues(issues));
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    jwt: jwt.data,
    sessionCheck: sessionCheck.data,
    allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    port: parsed.data.PORT,
    databaseCaCert: parsed.data.DATABASE_CA_CERT,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    connectTimeoutMs: parsed.data.DATABASE_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
    rateLimitStore: parsed.data.PUBLIC_RATE_LIMIT_STORE,
    publicIntake: parsePublicIntake(parsed.data),
    sites: parseSites(parsed.data),
    unsubscribe: parseUnsubscribe(parsed.data),
    resendWebhook: parseResendWebhook(parsed.data),
    stripe: parseStripeEnv(env),
    google: parseGoogleEnv(env),
    twilioWebhook: parseTwilioWebhook(parsed.data),
    activepieces: parseActivepieces(parsed.data),
  };
}

function parseSites(data: z.infer<typeof envSchema>): SitesEnv | null {
  if (data.SITES_STORE === undefined) return null;
  if (data.SITES_STORE === "memory") return { store: { kind: "memory" }, compiler: data.SITE_COMPILER };
  return {
    store: {
      kind: "r2", endpoint: data.R2_ENDPOINT!, bucket: data.R2_BUCKET!,
      accessKeyId: data.R2_ACCESS_KEY_ID!, secretAccessKey: data.R2_SECRET_ACCESS_KEY!,
    },
    compiler: data.SITE_COMPILER,
  };
}

function parseActivepieces(data: z.infer<typeof envSchema>): ActivepiecesEnv | null {
  const loopback = data.ACTIVEPIECES_ALLOW_LOOPBACK === "on";
  if (data.ACTIVEPIECES_KEY_SECRET === undefined) {
    if (data.ACTIVEPIECES_KEY_PREVIOUS_SECRET !== undefined)
      throw new Error("Invalid environment: ACTIVEPIECES_KEY_PREVIOUS_SECRET needs ACTIVEPIECES_KEY_SECRET");
    if (loopback) throw new Error("Invalid environment: ACTIVEPIECES_ALLOW_LOOPBACK needs ACTIVEPIECES_KEY_SECRET");
    return null;
  }
  if (loopback) assertLoopbackOnly("ACTIVEPIECES_ALLOW_LOOPBACK", data.DATABASE_URL);
  return {
    keySecrets: {
      current: data.ACTIVEPIECES_KEY_SECRET,
      ...(data.ACTIVEPIECES_KEY_PREVIOUS_SECRET === undefined ? {} : { previous: data.ACTIVEPIECES_KEY_PREVIOUS_SECRET }),
    },
    allowLoopback: loopback,
  };
}

/** A local-development switch is refused unless the database is on this machine. */
export function assertLoopbackOnly(name: string, databaseUrl: string): void {
  try {
    assertLocalDatabaseUrl(databaseUrl);
  } catch {
    throw new Error(`Invalid environment: ${name}=on needs a loopback database URL`);
  }
}

function parseClientIp(data: z.infer<typeof envSchema>): ClientIpConfig {
  const proxies = (data.PUBLIC_TRUSTED_PROXIES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (data.PUBLIC_CLIENT_IP_HEADER !== undefined && proxies.length > 0)
    throw new Error("Invalid environment: set PUBLIC_CLIENT_IP_HEADER or PUBLIC_TRUSTED_PROXIES, not both");
  try {
    trustedProxyList(proxies);
  } catch (error) {
    throw new Error(`Invalid environment: PUBLIC_TRUSTED_PROXIES: ${(error as Error).message}`);
  }
  if (data.PUBLIC_CLIENT_IP_HEADER !== undefined) return { header: data.PUBLIC_CLIENT_IP_HEADER };
  return proxies.length > 0 ? { trustedProxies: proxies } : {};
}

function parsePublicIntake(data: z.infer<typeof envSchema>): PublicIntakeEnv | null {
  if (data.PUBLIC_BOOKING_KEY_SECRET === undefined) {
    if (data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET !== undefined)
      throw new Error("Invalid environment: PUBLIC_BOOKING_KEY_PREVIOUS_SECRET needs PUBLIC_BOOKING_KEY_SECRET");
    return null;
  }
  const limitOverrides = Object.fromEntries(Object.entries({
    addressWrites: data.PUBLIC_RATE_ADDRESS_WRITES,
    addressReads: data.PUBLIC_RATE_ADDRESS_READS,
    tenantWrites: data.PUBLIC_RATE_TENANT_WRITES,
  }).filter(([, value]) => value !== undefined));
  return {
    keySecrets: {
      current: data.PUBLIC_BOOKING_KEY_SECRET,
      ...(data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET === undefined ? {} : { previous: data.PUBLIC_BOOKING_KEY_PREVIOUS_SECRET }),
    },
    publicBaseUrl: trimTrailingSlashes(data.PUBLIC_BASE_URL ?? `http://localhost:${data.PORT}`),
    clientIp: parseClientIp(data),
    limitOverrides,
  };
}

function parseUnsubscribe(data: z.infer<typeof envSchema>): UnsubscribeEnv | null {
  if (data.UNSUBSCRIBE_TOKEN_SECRET === undefined) {
    if (data.UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET !== undefined)
      throw new Error("Invalid environment: UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET needs UNSUBSCRIBE_TOKEN_SECRET");
    return null;
  }
  const limitOverrides = Object.fromEntries(Object.entries({
    addressWrites: data.PUBLIC_RATE_ADDRESS_WRITES,
    addressReads: data.PUBLIC_RATE_ADDRESS_READS,
  }).filter(([, value]) => value !== undefined));
  return {
    tokenSecrets: {
      current: data.UNSUBSCRIBE_TOKEN_SECRET,
      ...(data.UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET === undefined ? {} : { previous: data.UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET }),
    },
    clientIp: parseClientIp(data),
    limitOverrides,
  };
}

function parseResendWebhook(data: z.infer<typeof envSchema>): ResendWebhookEnv | null {
  if (data.RESEND_WEBHOOK_SECRET === undefined) {
    if (data.RESEND_WEBHOOK_PREVIOUS_SECRET !== undefined)
      throw new Error("Invalid environment: RESEND_WEBHOOK_PREVIOUS_SECRET needs RESEND_WEBHOOK_SECRET");
    return null;
  }
  return {
    secrets: {
      current: data.RESEND_WEBHOOK_SECRET,
      ...(data.RESEND_WEBHOOK_PREVIOUS_SECRET === undefined ? {} : { previous: data.RESEND_WEBHOOK_PREVIOUS_SECRET }),
    },
  };
}

function parseTwilioWebhook(data: z.infer<typeof envSchema>): TwilioWebhookEnv | null {
  if (data.TWILIO_AUTH_TOKEN === undefined) {
    if (data.TWILIO_PREVIOUS_AUTH_TOKEN !== undefined)
      throw new Error("Invalid environment: TWILIO_PREVIOUS_AUTH_TOKEN needs TWILIO_AUTH_TOKEN");
    return null;
  }
  if (data.TWILIO_ACCOUNT_SID === undefined) throw new Error("Invalid environment: TWILIO_AUTH_TOKEN needs TWILIO_ACCOUNT_SID");
  if (data.TWILIO_WEBHOOK_BASE_URL === undefined) throw new Error("Invalid environment: TWILIO_AUTH_TOKEN needs TWILIO_WEBHOOK_BASE_URL");
  const problem = secureUrlProblem("TWILIO_WEBHOOK_BASE_URL", data.TWILIO_WEBHOOK_BASE_URL);
  const url = URL.parse(data.TWILIO_WEBHOOK_BASE_URL);
  if (problem) throw new Error(`Invalid environment: ${problem}`);
  if (url && (url.search || url.hash)) throw new Error("Invalid environment: TWILIO_WEBHOOK_BASE_URL must not carry a query or fragment");
  return {
    tokens: {
      current: data.TWILIO_AUTH_TOKEN,
      ...(data.TWILIO_PREVIOUS_AUTH_TOKEN === undefined ? {} : { previous: data.TWILIO_PREVIOUS_AUTH_TOKEN }),
    },
    accountSid: data.TWILIO_ACCOUNT_SID,
    webhookBaseUrl: trimTrailingSlashes(data.TWILIO_WEBHOOK_BASE_URL),
    keywordReplies: data.TWILIO_KEYWORD_REPLIES,
  };
}

/** The local auth stub exists only on loopback databases; refuse it anywhere else. */
export function localStubIssues(config: SessionCheckConfig, databaseUrl: string): z.core.$ZodIssue[] {
  if (config.method !== "local-stub") return [];
  try {
    assertLocalDatabaseUrl(databaseUrl);
    return [];
  } catch {
    return [{ code: "custom", path: ["SESSION_CHECK"], message: "SESSION_CHECK=local-stub needs a loopback DATABASE_URL", input: undefined }];
  }
}
