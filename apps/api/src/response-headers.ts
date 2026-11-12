// Response hardening shared by every Hono app in apps/api (the API and the cron functions).
//
// nosniff goes on every answer that does not carry it already. Cache-Control follows a fail-closed rule:
// on a private path the answer is `no-store` unless the route already says `no-store`, so a route that
// sets some other value (for example `public, max-age=300`) cannot make a private answer cacheable by
// mistake. Routes outside the private prefixes keep whatever they set on purpose: the public booking
// assets (`public, max-age=300`), the booking page (`no-store` with its own CSP and Referrer-Policy),
// media on the public side, `/healthz`. OAuth callbacks (`/oauth`) carry a one-time code in the URL, so
// every answer there, errors included, is `no-store` with `Referrer-Policy: no-referrer`.
import type { MiddlewareHandler } from "hono";

/**
 * Paths whose answers belong to a signed-in caller, a worker, a webhook sender or the automation key:
 * never cacheable.
 */
const PRIVATE_PREFIXES = [
  "/v1", "/worker/v1", "/browser-runner/v1", "/integrations/activepieces/v1", "/mcp", "/automation/v1", "/cron", "/internal", "/webhooks",
] as const;
/** OAuth redirects land here with a code in the query; the answer must not be cached or leak the URL. */
const CALLBACK_PREFIXES = ["/oauth"] as const;

const under = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

export const isPrivateApiPath = (path: string): boolean => under(path, PRIVATE_PREFIXES);
export const isCallbackPath = (path: string): boolean => under(path, CALLBACK_PREFIXES);

const hasNoStore = (value: string | null): boolean => value !== null && /(?:^|[\s,])no-store(?:$|[\s,])/i.test(value);

/**
 * `X-Content-Type-Options: nosniff` on every response, `Cache-Control: no-store` forced on every private
 * path unless the route already said `no-store`, and the callback headers on `/oauth`.
 * Runs for errors too: Hono hands the error response to this middleware before it returns.
 * Public pages and `/healthz` keep whatever their route sets (or the platform default when it sets none).
 */
export const responseHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const path = c.req.path;
  if (!c.res.headers.has("X-Content-Type-Options")) c.header("X-Content-Type-Options", "nosniff");
  const callback = isCallbackPath(path);
  if ((callback || isPrivateApiPath(path)) && !hasNoStore(c.res.headers.get("Cache-Control"))) c.header("Cache-Control", "no-store");
  if (callback && !c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "no-referrer");
};
