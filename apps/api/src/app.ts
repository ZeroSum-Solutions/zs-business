import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiErrorCode } from "@zs/contracts";
import { TenantDenied } from "@zs/contracts";
import { apiErrorBody, createSession, findMembership, mapError, sessionIsLive, type Session } from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import { Unauthenticated, type TokenVerifier } from "./auth.js";
import { bookingRoutes } from "./routes/booking.js";
import { crmRoutes } from "./routes/crm.js";
import { memberRoutes } from "./routes/members.js";

export interface AppConfig {
  /** Exact origins allowed to call the API from a browser; empty means no CORS. */
  readonly allowedOrigins: readonly string[];
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
}
export interface AppEnv {
  Variables: { session: Session };
}

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
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    maxAge: 600,
  }));

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("/v1/*", bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
  }));
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header);
    if (!match) throw new Unauthenticated();
    const token = await deps.verifier.verify(match[1]!);
    // A valid signature is not enough: the session must still be live (sign-out deletes it)
    // and the user must still be a member of the tenant the token claims. Each read and write
    // then re-checks the membership and its role inside its own transaction.
    const access = await deps.db.tenant(token.tenantId, async (tx) => ({
      live: await sessionIsLive(tx, token.sessionId, token.actorId, deps.clock.now()),
      member: await findMembership(tx, token.tenantId, token.actorId),
    }));
    if (!access.live) throw new Unauthenticated("Session has ended");
    if (!access.member) throw new TenantDenied();
    const principal = { tenantId: token.tenantId, actorId: token.actorId };
    c.set("session", createSession({ db: deps.db, clock: deps.clock, generateId: deps.generateId }, principal));
    await next();
  });
  app.route("/v1/booking", bookingRoutes);
  app.route("/v1/crm", crmRoutes);
  app.route("/v1", memberRoutes);

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
    return c.json(mapped.body, mapped.status);
  });
  return app;
}
export type App = ReturnType<typeof createApp>;
export { createHs256Verifier, createJwksVerifier, Unauthenticated, type TokenVerifier, type VerifiedToken } from "./auth.js";
