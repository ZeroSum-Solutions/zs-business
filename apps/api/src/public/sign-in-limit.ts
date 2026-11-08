// The dashboard's sign-in link limits (hub-launch L9): per address and in total, counted in the shared limiter so
// they hold across every dashboard instance. Mounted at /public/v1/sign-in/admit. The only credential is
// SIGN_IN_LIMITER_SECRET (or, during a rotation, SIGN_IN_LIMITER_PREVIOUS_SECRET) as a bearer token: the dashboard
// holds the same value, and without it anyone could spend other callers' buckets. The route sees the address the
// dashboard names, never an email. One atomic rate_limit_take charges both buckets or neither. Like the other P-10
// routes it fails closed: when the store cannot answer, the limiter throws DatabaseUnavailable and the answer is a
// retryable 503, so the dashboard sends nothing. Every answer is no-store.
import { createHash, timingSafeEqual } from "node:crypto";
import { ActionError, SIGN_IN_DIRECT_ADDRESS, SIGN_IN_WINDOW_MS, signInAdmitBodySchema, ValidationFailed } from "@zs/contracts";
import { apiErrorBody, type EdgeDependencies } from "@zs/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app.js";
import { jsonBody } from "../routes/request.js";
import { addressBucket, canonicalIp } from "./client-ip.js";
import { createMemoryRateLimiter, type RateLimiter } from "./limiter.js";
import { RateLimited } from "./routes.js";

export const SIGN_IN_LIMIT_PREFIX = "/public/v1/sign-in";
const NO_STORE = { "Cache-Control": "no-store" };

export interface SignInLimitConfig {
  /** SIGN_IN_LIMITER_SECRET: the bearer token the dashboard sends; `previous` also works during a rotation. */
  readonly secrets: { readonly current: string; readonly previous?: string };
  /** Defaults to an in-memory limiter on the app clock; servers pass the shared Postgres one. */
  readonly limiter?: RateLimiter;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function signInLimitRoutes(edge: EdgeDependencies, config: SignInLimitConfig) {
  const limiter = config.limiter ?? createMemoryRateLimiter(edge.clock);
  const accepted = [config.secrets.current, ...(config.secrets.previous === undefined ? [] : [config.secrets.previous])].map(digest);
  const authorized = (c: Context<AppEnv>) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (match === null) return false;
    const given = digest(match[1]!);
    // Compare against every accepted secret, so the time does not say which one matched.
    return accepted.map((secret) => timingSafeEqual(given, secret)).some(Boolean);
  };
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .use("*", bodyLimit({ maxSize: 1024, onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413, NO_STORE) }))
    .post("/admit", async (c) => {
      if (!authorized(c)) return c.json(apiErrorBody("Unauthorized", "Invalid credentials"), 401, NO_STORE);
      try {
        const parsed = signInAdmitBodySchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw new ValidationFailed("Invalid sign-in limit request");
        const body = parsed.data;
        // "direct" is the dashboard's key for callers it cannot tell apart; anything that is not an address joins it.
        const ip = canonicalIp(body.address);
        const who = ip === null ? SIGN_IN_DIRECT_ADDRESS : addressBucket(ip);
        const taken = await limiter.take([
          { key: `sign-in-address:${who}`, rule: { limit: body.perAddress, windowMs: SIGN_IN_WINDOW_MS } },
          { key: "sign-in-global", rule: { limit: body.global, windowMs: SIGN_IN_WINDOW_MS } },
        ], {
          signal: c.var.signal,
          remainingMs: () => c.var.deadline - edge.clock.now().getTime(),
        });
        if (!taken.ok) throw new RateLimited(taken.retryAfterSeconds);
        return c.body(null, 204);
      } catch (error) {
        // These two are answered here, not by the app's error handler, so they carry no-store too.
        if (error instanceof RateLimited)
          return c.json(apiErrorBody("RateLimited", "Too many requests"), 429, { ...NO_STORE, "Retry-After": String(error.retryAfterSeconds) });
        if (error instanceof ActionError && error.code === "ValidationFailed")
          return c.json(apiErrorBody("ValidationFailed", error.message, { ...error.details }), 400, NO_STORE);
        throw error;
      }
    });
}
