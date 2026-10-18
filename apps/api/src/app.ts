import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiErrorCode } from "@zs/contracts";
import { apiErrorBody, createSession, DatabaseUnavailable, mapError, type Session } from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import { Unauthenticated, type TokenVerifier } from "./auth.js";
import { bookingRoutes } from "./routes/booking.js";
import { crmRoutes } from "./routes/crm.js";

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
  readonly clock: { now(): Date };
  /** Runtime-role scoped database built from the runtime pool. */
  readonly db: ScopedDatabase;
  readonly generateId: () => string;
  readonly config: AppConfig;
  /** Receives unexpected errors; responses never include their details. */
  readonly onError?: (error: unknown) => void;
  /** Readiness probe for `GET /readyz`, for example `checkDatabase(pool)`. */
  readonly ready?: () => Promise<boolean>;
}
export interface AppEnv {
  Variables: { session: Session; signal: AbortSignal };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The same database, with every transaction tied to one request's deadline. */
function withSignal(db: ScopedDatabase, signal: AbortSignal): ScopedDatabase {
  return { tenant: (tenantId, work, options) => db.tenant(tenantId, work, { signal, ...options }) };
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
    allowMethods: ["GET", "POST", "OPTIONS"],
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

  // A deadline per request, which also ends when the caller goes away.
  const requestTimeoutMs = deps.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  app.use("/v1/*", async (c, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const clientGone = () => controller.abort();
    const raw = c.req.raw.signal;
    raw?.addEventListener("abort", clientGone, { once: true });
    c.set("signal", controller.signal);
    // Work still running after the deadline finishes on its own; nothing waits for it.
    const work = next();
    work.catch(() => undefined);
    try {
      await Promise.race([work, unavailable(controller.signal)]);
    } finally {
      clearTimeout(timer);
      raw?.removeEventListener("abort", clientGone);
    }
  });

  app.use("/v1/*", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
  }));
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header);
    if (!match) throw new Unauthenticated();
    const principal = await deps.verifier.verify(match[1]!);
    c.set("session", createSession({ db: withSignal(deps.db, c.var.signal), clock: deps.clock, generateId: deps.generateId }, principal));
    await next();
  });
  app.route("/v1/booking", bookingRoutes);
  app.route("/v1/crm", crmRoutes);

  app.notFound((c) => c.json(apiErrorBody("NotFound", "Route not found"), 404));
  app.onError((error, c) => {
    if (error instanceof Unauthenticated)
      return c.json(apiErrorBody("Unauthorized", error.message), 401, { "WWW-Authenticate": "Bearer" });
    if (error instanceof HTTPException && error.status < 500) {
      const code = HTTP_ERROR_CODES[error.status] ?? "ValidationFailed";
      const headers: Record<string, string> = error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
      return c.json(apiErrorBody(code, error.message || code), error.status, headers);
    }
    const mapped = mapError(error);
    if (mapped.status === 500) deps.onError?.(error);
    if (mapped.status === 503) return c.json(mapped.body, 503, { "Retry-After": "1" });
    return c.json(mapped.body, mapped.status);
  });
  return app;
}
export type App = ReturnType<typeof createApp>;
export { createHs256Verifier, createJwksVerifier, Unauthenticated, type TokenVerifier } from "./auth.js";
