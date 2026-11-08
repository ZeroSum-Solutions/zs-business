// The dashboard's sign-in link limits (hub-launch L9): per address, in total and per email, counted in the shared
// limiter so they hold across every dashboard instance. Mounted at /public/v1/sign-in/admit. The only credential is
// SIGN_IN_LIMITER_SECRET as a bearer token (the dashboard holds the same value): without it anyone could spend
// another person's buckets. The route sees the address the dashboard names and the SHA-256 of the email, never the
// email itself. Like the other P-10 routes it fails closed: when the store cannot answer, the limiter throws
// DatabaseUnavailable and the answer is a retryable 503, so the dashboard sends nothing.
import { createHash, timingSafeEqual } from "node:crypto";
import { SIGN_IN_WINDOW_MS, signInAdmitBodySchema, ValidationFailed } from "@zs/contracts";
import { apiErrorBody, type EdgeDependencies } from "@zs/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app.js";
import { jsonBody } from "../routes/request.js";
import { addressBucket, canonicalIp } from "./client-ip.js";
import { createMemoryRateLimiter, type Charge, type RateLimiter } from "./limiter.js";
import { RateLimited } from "./routes.js";

export const SIGN_IN_LIMIT_PREFIX = "/public/v1/sign-in";

export interface SignInLimitConfig {
  /** SIGN_IN_LIMITER_SECRET: the bearer token the dashboard sends. */
  readonly secret: string;
  /** Defaults to an in-memory limiter on the app clock; servers pass the shared Postgres one. */
  readonly limiter?: RateLimiter;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function signInLimitRoutes(edge: EdgeDependencies, config: SignInLimitConfig) {
  const limiter = config.limiter ?? createMemoryRateLimiter(edge.clock);
  const secret = digest(config.secret);
  const authorized = (c: Context<AppEnv>) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    return match !== null && timingSafeEqual(digest(match[1]!), secret);
  };
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .use("*", bodyLimit({ maxSize: 1024, onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413) }))
    .post("/admit", async (c) => {
      if (!authorized(c)) return c.json(apiErrorBody("Unauthorized", "Invalid credentials"), 401);
      const parsed = signInAdmitBodySchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw new ValidationFailed("Invalid sign-in limit request");
      const body = parsed.data;
      let charges: Charge[];
      if (body.scope === "address") {
        // "direct" is the dashboard's key for callers it cannot tell apart; any other value must be an address.
        const ip = canonicalIp(body.address);
        const who = ip === null ? "direct" : addressBucket(ip);
        charges = [
          { key: `sign-in-address:${who}`, rule: { limit: body.perAddress, windowMs: SIGN_IN_WINDOW_MS } },
          { key: "sign-in-global", rule: { limit: body.global, windowMs: SIGN_IN_WINDOW_MS } },
        ];
      } else {
        charges = [{ key: `sign-in-email:${body.emailHash}`, rule: { limit: body.perEmail, windowMs: SIGN_IN_WINDOW_MS } }];
      }
      const taken = await limiter.take(charges, {
        signal: c.var.signal,
        remainingMs: () => c.var.deadline - edge.clock.now().getTime(),
      });
      if (!taken.ok) throw new RateLimited(taken.retryAfterSeconds);
      return c.body(null, 204);
    });
}
