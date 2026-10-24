import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiErrorCode } from "@zs/contracts";
import {
  apiErrorBody,
  AuthUnavailable,
  authenticate,
  createBrowserSession,
  createFollowUpAgent,
  DatabaseUnavailable,
  mapError,
  type AutomationEdgeConfig,
  type FollowUpAgentConfig,
  type Session,
  type SessionCheck,
  type StripeClient,
} from "@zs/core";
import type { SiteObjectStore } from "@zs/contracts";
import type { ScopedDatabase, Transaction, TransactionOptions } from "@zs/db";
import type { SiteCompiler } from "@zs/core";
import { Unauthenticated, type TokenVerifier } from "./auth.js";
import { activepiecesRoutes } from "./routes/activepieces.js";
import { agentKindRoutes, followUpRoutes } from "./routes/agents.js";
import { businessRoutes } from "./routes/business.js";
import { browserRoutes, browserRunnerRoutes, type BrowserApiConfig } from "./routes/browser.js";
import { billingRoutes } from "./routes/billing.js";
import { approvalRoutes } from "./routes/approvals.js";
import { calendarRoutes } from "./routes/calendar.js";
import { bookingRoutes } from "./routes/booking.js";
import { crmRoutes } from "./routes/crm.js";
import { homeRoutes } from "./routes/home.js";
import { inboxRoutes } from "./routes/inbox.js";
import { intakeRoutes } from "./routes/intake.js";
import { memberRoutes } from "./routes/members.js";
import { siteRoutes } from "./routes/sites.js";
import { sourceRoutes } from "./routes/sources.js";
import { ACTIVEPIECES_INBOUND_PREFIX, activepiecesInboundRoutes } from "./public/activepieces.js";
import { publicRoutes, RateLimited, type PublicIntakeConfig } from "./public/routes.js";
import { resendWebhookRoutes, type ResendWebhookConfig } from "./public/resend-webhook.js";
import { stripeWebhookRoutes, type StripeWebhookConfig } from "./public/stripe-webhook.js";
import { googleCalendarRoutes, type GoogleCalendarConfig } from "./public/google-calendar.js";
import { twilioWebhookRoutes, type TwilioWebhookConfig } from "./public/twilio-webhook.js";
import { unsubscribeRoutes, type UnsubscribeConfig } from "./public/unsubscribe.js";

export interface AppConfig {
  /** Exact origins allowed to call the API from a browser; empty means no CORS. */
  readonly allowedOrigins: readonly string[];
  /**
   * Longest time a /v1 request may take, default 10 s (under the dashboard proxy's 15 s).
   * Past it the API answers 503 and the request's transaction sends no further statement
   * and rolls back; a write that already committed replays on a retry with its key.
   */
  readonly requestTimeoutMs?: number;
}
export interface AppDependencies {
  readonly verifier: TokenVerifier;
  /** Whether a token's Supabase session is still live (Supabase Auth in production). */
  readonly sessionCheck: SessionCheck;
  readonly clock: { now(): Date };
  /** Runtime-role scoped database built from the runtime pool. */
  readonly db: ScopedDatabase;
  readonly generateId: () => string;
  readonly config: AppConfig;
  /** Public booking pages and the widget (public-intake.md); absent means the routes are off. */
  readonly publicIntake?: PublicIntakeConfig;
  /** Site publishing (M4b): where releases are stored and how specs compile; absent means /v1/sites is off. */
  readonly sites?: { readonly store: SiteObjectStore; readonly compiler: SiteCompiler; readonly syncTimeoutMs?: number };
  /** One-click email unsubscribe (delivery.md D-9); absent means the routes are off. */
  readonly unsubscribe?: UnsubscribeConfig;
  /**
   * The inquiry follow-up agent's model and limits (agents.md G-9, G-11); absent means
   * `POST /v1/agents/followup/runs` is off (404). The other agent routes are always on.
   */
  readonly followUp?: FollowUpAgentConfig;
  /** Resend email events, bounces and complaints feeding suppression (resend.md R-7, R-8); absent means off. */
  readonly resendWebhook?: ResendWebhookConfig;
  /** Stripe Checkout for wallet top-ups (stripe.md S-1, S-2); absent means POST /v1/wallet/top-ups is 404. */
  readonly stripe?: StripeClient;
  /** Signed Stripe events into the billing inbox (stripe.md S-3); absent means the route is off. */
  readonly stripeWebhook?: StripeWebhookConfig;
  /**
   * Google Calendar busy sync (google-calendar.md G-1, G-2, G-8): connecting, the OAuth callback
   * and the push webhook. Absent means POST /v1/calendar/google/connect is 404 and both anonymous
   * routes are off.
   */
  readonly googleCalendar?: GoogleCalendarConfig;
  /** Twilio status callbacks and inbound STOP/START/HELP texts (twilio.md T-6, T-8); absent means off. */
  readonly twilioWebhook?: TwilioWebhookConfig;
  /**
   * Activepieces webhooks and automation tokens (activepieces.md); absent means the owner routes
   * under /v1/integrations/activepieces and the flow routes under /integrations/activepieces are off.
   */
  readonly activepieces?: AutomationEdgeConfig;
  /**
   * Website tasks (browser-tasks.md): the owner routes under /v1/browser, and with `runner` the
   * runner's job interface under /browser-runner/v1. Absent means both are off (404).
   */
  readonly browser?: BrowserApiConfig;
  /** Receives unexpected errors; responses never include their details. */
  readonly onError?: (error: unknown) => void;
  /** Readiness probe for `GET /readyz`, for example `checkDatabase(pool)`. */
  readonly ready?: () => Promise<boolean>;
}
export interface AppEnv {
  Variables: { session: Session; signal: AbortSignal; deadline: number };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The same database, with every transaction tied to one request's deadline: it sends no
 * statement after the signal fires, and no statement or lock wait outlasts the time left.
 */
function withDeadline(db: ScopedDatabase, signal: AbortSignal, remainingMs: () => number): ScopedDatabase {
  const platform = db.platform?.bind(db);
  return {
    tenant: (tenantId, work, options) => db.tenant(tenantId, work, { signal, remainingMs, ...options }),
    withoutTenant: (work, options) => db.withoutTenant(work, { signal, remainingMs, ...options }),
    ...(platform ? { platform: <T>(work: (tx: Transaction) => Promise<T>, options?: TransactionOptions) =>
      platform(work, { signal, remainingMs, ...options }) } : {}),
  };
}

const unavailable = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  const fail = () => reject(new DatabaseUnavailable("aborted"));
  if (signal.aborted) fail();
  else signal.addEventListener("abort", fail, { once: true });
});

/** Client errors raised by Hono middleware keep their status; the code follows it. */
const HTTP_ERROR_CODES: Partial<Record<number, ApiErrorCode>> = {
  401: "Unauthorized", 403: "Forbidden", 404: "NotFound", 409: "Conflict",
};

export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>();
  const origins = new Set(deps.config.allowedOrigins);
  app.use("*", cors({
    origin: (origin) => (origins.has(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    maxAge: 600,
  }));

  // Liveness: the process answers. Readiness: it can reach the database too.
  app.get("/healthz", (c) => c.json({ ok: true }));
  const ready = deps.ready;
  if (ready) {
    app.get("/readyz", async (c) => (await ready().catch(() => false))
      ? c.json({ ok: true })
      : c.json(mapError(new DatabaseUnavailable("connect")).body, 503, { "Retry-After": "1", "Cache-Control": "no-store" }));
  }

  // A deadline per request, which also ends when the caller goes away. Anonymous public
  // requests get the same one, so a lost reply cannot hold a pool connection open.
  const requestTimeoutMs = deps.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline: MiddlewareHandler<AppEnv> = async (c, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const clientGone = () => controller.abort();
    const raw = c.req.raw.signal;
    raw?.addEventListener("abort", clientGone, { once: true });
    c.set("signal", controller.signal);
    c.set("deadline", deps.clock.now().getTime() + requestTimeoutMs);
    // Work still running after the deadline finishes on its own; nothing waits for it.
    const work = next();
    work.catch(() => undefined);
    try {
      await Promise.race([work, unavailable(controller.signal)]);
    } finally {
      clearTimeout(timer);
      raw?.removeEventListener("abort", clientGone);
    }
  };
  app.use("/v1/*", deadline);
  app.use("/public/v1/*", deadline);
  app.use("/webhooks/*", deadline);
  app.use("/oauth/*", deadline);
  app.use(`${ACTIVEPIECES_INBOUND_PREFIX}/*`, deadline);

  const edge = {
    db: deps.db,
    clock: deps.clock,
    generateId: deps.generateId,
    ...(deps.publicIntake
      ? { bookingKeys: { secret: deps.publicIntake.keySecrets.current, publicBaseUrl: deps.publicIntake.publicBaseUrl } }
      : {}),
    ...(deps.stripe ? { billing: { stripe: deps.stripe } } : {}),
    ...(deps.googleCalendar ? {
      calendar: {
        google: deps.googleCalendar.google,
        stateSecrets: deps.googleCalendar.stateSecrets,
        tokenPublicKey: deps.googleCalendar.tokenPublicKey,
      },
    } : {}),
    ...(deps.sites ? { sites: deps.sites } : {}),
  };
  /** The edge for one request: its database work stops at the request's deadline. */
  const requestEdge = (c: Context<AppEnv>) => {
    const timeLeft = () => c.var.deadline - deps.clock.now().getTime();
    return { ...edge, db: withDeadline(edge.db, c.var.signal, timeLeft), timeLeft };
  };
  // Anonymous routes sit outside /v1, so the owner auth middleware never runs for them.
  if (deps.publicIntake) {
    const routes = publicRoutes(edge, deps.publicIntake, requestEdge);
    app.route("/public/v1", routes.api);
    app.route("/", routes.site);
  }
  if (deps.unsubscribe) app.route("/public/v1", unsubscribeRoutes(edge, deps.unsubscribe, requestEdge));
  if (deps.resendWebhook) app.route("/", resendWebhookRoutes(edge, deps.resendWebhook, requestEdge));
  if (deps.stripeWebhook) app.route("/", stripeWebhookRoutes(edge, deps.stripeWebhook, requestEdge));
  if (deps.googleCalendar) app.route("/", googleCalendarRoutes(deps.googleCalendar, requestEdge));
  if (deps.twilioWebhook) app.route("/", twilioWebhookRoutes(edge, deps.twilioWebhook, requestEdge));
  if (deps.activepieces) app.route(ACTIVEPIECES_INBOUND_PREFIX, activepiecesInboundRoutes(deps.activepieces, requestEdge));

  // The runner's calls carry a runner token and a lease, not a member session (BT-7).
  if (deps.browser?.runner) {
    app.use("/browser-runner/v1/*", deadline);
    app.route("/browser-runner/v1", browserRunnerRoutes(deps.browser.runner));
  }

  app.use("/v1/*", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
  }));
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header);
    if (!match) throw new Unauthenticated();
    // Verify the token, then require a live Supabase session (sign-out ends it) and a
    // membership in the claimed tenant (@zs/core authenticate, shared with the MCP server).
    // Each read and write then re-checks the membership and its role, all within the deadline.
    c.set("session", await authenticate(requestEdge(c), deps.verifier, deps.sessionCheck, match[1]!));
    await next();
  });
  app.route("/v1/booking", bookingRoutes);
  app.route("/v1/crm", crmRoutes);
  app.route("/v1/intake", intakeRoutes);
  app.route("/v1/inbox", inboxRoutes);
  app.route("/v1/home", homeRoutes);
  // Off without a site store: /v1/sites is then an unknown route (404), like the session's check.
  if (deps.sites) app.route("/v1/sites", siteRoutes);
  app.route("/v1", billingRoutes);
  app.route("/v1/approvals", approvalRoutes);
  app.route("/v1/sources", sourceRoutes);
  app.route("/v1", calendarRoutes);
  if (deps.activepieces) app.route("/v1/integrations/activepieces", activepiecesRoutes(deps.activepieces, requestEdge));
  const followUp = deps.followUp;
  app.route("/v1/agents/followup", followUpRoutes(followUp && ((c) => createFollowUpAgent(requestEdge(c), followUp))));
  app.route("/v1/agents", agentKindRoutes());
  const browser = deps.browser;
  if (browser)
    app.route("/v1/browser", browserRoutes(browser, (c) =>
      createBrowserSession(requestEdge(c), c.var.session.principal, { config: browser.config, artifacts: browser.artifacts })));
  app.route("/v1", memberRoutes);
  app.route("/v1", businessRoutes);

  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  app.onError((error, c) => {
    if (error instanceof RateLimited)
      return c.json(apiErrorBody("RateLimited", "Too many requests"), 429, { "Retry-After": String(error.retryAfterSeconds) });
    if (error instanceof Unauthenticated) {
      const mapped = mapError(error);
      return c.json(mapped.body, mapped.status, { "WWW-Authenticate": "Bearer" });
    }
    if (error instanceof HTTPException && error.status < 500) {
      const code = HTTP_ERROR_CODES[error.status] ?? "ValidationFailed";
      const headers: Record<string, string> = error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
      return c.json(apiErrorBody(code, error.message || code), error.status, headers);
    }
    const mapped = mapError(error);
    // An Auth outage answers 503 like a busy pool, but someone should hear about it.
    if (mapped.status === 500 || error instanceof AuthUnavailable) deps.onError?.(error);
    // A public route's own no-store header is not set when the deadline answers for it.
    if (mapped.status === 503) {
      const path = c.req.path;
      return c.json(mapped.body, 503, {
        "Retry-After": "1",
        ...(path.startsWith("/public/") || path.startsWith("/oauth/") ? { "Cache-Control": "no-store" } : {}),
        ...(path.startsWith("/oauth/") ? { "Referrer-Policy": "no-referrer" } : {}),
      });
    }
    return c.json(mapped.body, mapped.status);
  });
  return app;
}
export type App = ReturnType<typeof createApp>;
export { allowAllBots, type BotCheck, type PublicIntakeConfig } from "./public/routes.js";
export type { UnsubscribeConfig } from "./public/unsubscribe.js";
export type { ResendWebhookConfig } from "./public/resend-webhook.js";
export type { StripeWebhookConfig } from "./public/stripe-webhook.js";
export type { GoogleCalendarConfig } from "./public/google-calendar.js";
export type { TwilioWebhookConfig } from "./public/twilio-webhook.js";
export { createMemoryRateLimiter, DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from "./public/limiter.js";
export { createPostgresRateLimiter } from "./public/postgres-limiter.js";
export { createHs256Verifier, createJwksVerifier, Unauthenticated, type TokenVerifier, type VerifiedToken } from "./auth.js";
