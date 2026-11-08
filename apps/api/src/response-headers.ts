// Response hardening shared by every Hono app in apps/api (the API and the cron functions).
// Both rules only fill a header the route did not set, so a route that chose its own value on
// purpose keeps it: the public booking assets (`public, max-age=300`), the booking page and OAuth
// callbacks (`no-store` with their own CSP and Referrer-Policy), media (`private, no-store`) and the
// MCP endpoint all pass through unchanged.
import type { MiddlewareHandler } from "hono";

/** Paths whose answers belong to a signed-in caller, a worker or the automation key: never cacheable. */
const PRIVATE_PREFIXES = ["/v1", "/worker/v1", "/browser-runner/v1", "/mcp", "/cron", "/internal"] as const;

export const isPrivateApiPath = (path: string): boolean =>
  PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * `X-Content-Type-Options: nosniff` on every response, and `Cache-Control: no-store` on every private
 * path that set no Cache-Control of its own (without it Vercel adds `public, max-age=0, must-revalidate`).
 * Runs for errors too: Hono hands the error response to this middleware before it returns.
 * Public pages and `/healthz` keep whatever their route sets (or the platform default when it sets none).
 */
export const responseHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has("X-Content-Type-Options")) c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Cache-Control") && isPrivateApiPath(c.req.path)) c.header("Cache-Control", "no-store");
};
