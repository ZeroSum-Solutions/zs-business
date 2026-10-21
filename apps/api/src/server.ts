import { randomUUID } from "node:crypto";
import { assertRuntimeLogin, checkDatabase, createRuntimePool, createScopedDatabase } from "@zs/db";
import { createGoogleClient, createMemorySiteStore, createSessionCheckFromConfig, createStripeClient, plainSiteCompiler, type SiteCompiler } from "@zs/core";
import { createApp, DEFAULT_RATE_LIMITS, type PublicIntakeConfig, type RateLimits, type UnsubscribeConfig } from "./app.js";
import { createPostgresRateLimiter } from "./public/postgres-limiter.js";
import { createVerifierFromConfig } from "./auth.js";
import type { ServerEnv } from "./config.js";
import { createR2SiteStore } from "./sites/r2-s3.js";

/**
 * Builds the runtime pool and the app from a parsed environment, for the Node server
 * (main.ts) and the Vercel function (vercel.ts). Returns only after the pool's login passes
 * assertRuntimeLogin, so a misconfigured DATABASE_URL never serves a request.
 */
export async function createServer(env: ServerEnv, clock: { now(): Date }, options: {
  /** Replaces the compiler SITE_COMPILER names, such as an adapter over @mish/publisher. */
  readonly siteCompiler?: SiteCompiler;
} = {}) {
  const pool = createRuntimePool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    connectionTimeoutMs: env.connectTimeoutMs,
    applicationName: "zs-api",
    ...(env.databaseCaCert === undefined ? {} : { ssl: { ca: env.databaseCaCert, rejectUnauthorized: true } }),
    // A lost idle connection is logged and replaced; it must not end the process.
    onError: ({ code, message }) => console.error("Database pool error", code ?? "", message),
  });
  await assertRuntimeLogin(pool).catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const db = createScopedDatabase(pool, {
    // Hosted, the runtime URL is Supavisor's transaction pooler (port 6543), where a
    // backend cancel could stop another request's statement. Never "backend" here.
    cancel: "none",
    // A failed reset discards the connection; say so, since a pattern of them means trouble.
    onResetFailure: (error) => console.error("Session reset failed; connection discarded", error),
  });
  const limits = (overrides: Readonly<Record<string, number>>): Partial<RateLimits> =>
    Object.fromEntries(Object.entries(overrides).map(([name, limit]) =>
      [name, { ...DEFAULT_RATE_LIMITS[name as keyof RateLimits], limit }]));
  // P-10: one limiter shared by every instance on this database, for the booking and the
  // unsubscribe routes (their bucket names do not overlap). "memory" (loopback only) leaves each
  // route group its own per-process limiter.
  const shared = env.rateLimitStore === "postgres" ? { limiter: createPostgresRateLimiter(db, clock) } : {};
  const publicIntake: PublicIntakeConfig | undefined = env.publicIntake === null ? undefined : {
    keySecrets: env.publicIntake.keySecrets,
    publicBaseUrl: env.publicIntake.publicBaseUrl,
    clientIp: env.publicIntake.clientIp,
    limits: limits(env.publicIntake.limitOverrides),
    ...shared,
  };
  const unsubscribe: UnsubscribeConfig | undefined = env.unsubscribe === null ? undefined : {
    tokenSecrets: env.unsubscribe.tokenSecrets,
    clientIp: env.unsubscribe.clientIp,
    limits: limits(env.unsubscribe.limitOverrides),
    ...shared,
  };
  const sites = env.sites === null ? undefined : {
    store: env.sites.store.kind === "memory"
      ? createMemorySiteStore()
      : createR2SiteStore(env.sites.store, { fetch: globalThis.fetch, clock }),
    compiler: options.siteCompiler ?? plainSiteCompiler,
  };
  const app = createApp({
    verifier: createVerifierFromConfig(env.jwt, clock),
    sessionCheck: createSessionCheckFromConfig(env.sessionCheck, { db, clock }),
    clock,
    db,
    generateId: randomUUID,
    config: { allowedOrigins: env.allowedOrigins, requestTimeoutMs: env.requestTimeoutMs },
    ...(publicIntake === undefined ? {} : { publicIntake }),
    ...(sites === undefined ? {} : { sites }),
    ...(unsubscribe === undefined ? {} : { unsubscribe }),
    ...(env.resendWebhook === null ? {} : {
      resendWebhook: {
        secrets: env.resendWebhook.secrets,
        report: ({ id, type, outcome }) => {
          if (!outcome.handled && outcome.reason !== "no_suppression")
            console.warn("Resend webhook not applied", { id, type, reason: outcome.reason });
        },
      },
    }),
    ...(env.stripe === null ? {} : {
      stripe: createStripeClient({ config: env.stripe.client }),
      stripeWebhook: {
        ...env.stripe.webhook,
        report: ({ id, type, outcome }) => {
          if (outcome === "other_mode") console.warn("Stripe webhook from the other mode dropped", { id, type });
        },
      },
    }),
    ...(env.google === null ? {} : {
      googleCalendar: {
        google: createGoogleClient({ config: env.google.client }),
        stateSecrets: env.google.stateSecrets,
        tokenPublicKey: env.google.tokenPublicKey,
        returnUrl: env.google.returnUrl,
        channelSecret: env.google.channelSecret,
        report: (event) => {
          // A forged state or a refused grant may need an operator; the rest are routine.
          if (event.route === "callback" && !["connected", "staged", "denied"].includes(event.outcome)) console.warn("Google OAuth callback", event);
        },
      },
    }),
    ...(env.twilioWebhook === null ? {} : {
      twilioWebhook: {
        ...env.twilioWebhook,
        report: (event) => {
          if (!event.outcome.handled && event.outcome.reason !== "not_a_keyword")
            console.warn("Twilio webhook not applied", { kind: event.kind, messageSid: event.messageSid, reason: event.outcome.reason });
        },
      },
    }),
    ...(env.activepieces === null ? {} : {
      activepieces: { keySecrets: env.activepieces.keySecrets, urlPolicy: { allowLoopback: env.activepieces.allowLoopback } },
    }),
    onError: (error) => console.error("Unhandled API error", error),
    ready: () => checkDatabase(pool),
  });
  return { app, pool };
}
