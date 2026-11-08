import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Unauthenticated } from "../auth.js";
import type { AppEnv } from "../app.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * A worker's bearer token, compared in constant time over fixed-length digests. `variable` names
 * the setting in the error thrown for a token shorter than 32 characters.
 */
export function workerBearerAuth(variable: string, token: string): MiddlewareHandler<AppEnv> {
  if (token.length < 32) throw new Error(`${variable} must be at least 32 characters`);
  const expected = digest(token);
  return async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) throw new Unauthenticated();
    await next();
  };
}
