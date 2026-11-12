// hub-access.md H-15: `/automation/v1/sites`, the site routes for a `zsap1_` token that holds `sites:publish`.
// The checks run in the contract's order and the first to fail answers: 401 (the tag, pure CPU), 413 (body over
// 64 KiB, counted on the stream), 429 (two buckets charged in one statement on the tag's tenant and token,
// before the token row is read), then the token session: 401 (the row), 403 (no scope), 404 (a site the token
// does not name; the same answer for a foreign site, an unnamed one and an ID nothing holds), and last the
// body (400) and the publish rules. A body that cannot be read is held back as a value no schema accepts, so
// it is refused only after the site gate. Original code.
import { Hono, type Context } from "hono";
import {
  apiErrorBody, createAutomationInbound, createAutomationSites, type AutomationKeySecrets, type EdgeDependencies,
} from "@zs/core";
import type { AppEnv } from "../app.js";
import { readBody } from "../mcp/routes.js";
import type { RateLimit, RateLimiter } from "../public/limiter.js";

export const AUTOMATION_SITES_PREFIX = "/automation/v1/sites";
/** H-15: units per token, counted one per request whose tag is valid. */
export const SITES_MINUTE_LIMIT: RateLimit = { limit: 30, windowMs: 60_000 };
export const SITES_HOUR_LIMIT: RateLimit = { limit: 300, windowMs: 3_600_000 };
const BODY_LIMIT_BYTES = 64 * 1024;

export interface AutomationSitesRouteConfig {
  readonly keySecrets: AutomationKeySecrets;
  /** The shared Postgres limiter, so every API instance charges the same buckets. */
  readonly limiter: RateLimiter;
}

/** The body as JSON, or `undefined` (which no body schema accepts) when it is not an `application/json` document. */
function parseJson(c: Context, text: string): unknown {
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function automationSiteRoutes(config: AutomationSitesRouteConfig, requestEdge: (c: Context<AppEnv>) => EdgeDependencies) {
  type Session = ReturnType<ReturnType<typeof createAutomationSites>["forToken"]>;

  /**
   * The checks every route shares, then `run`. The body is read (and counted) here only for a method that
   * takes one; the others read nothing.
   */
  const guarded = (withBody: boolean, run: (session: Session, c: Context<AppEnv>, body: unknown) => Promise<{ value: unknown; status?: 200 | 201 }>) =>
    async (c: Context<AppEnv>) => {
      const edge = requestEdge(c);
      const inbound = createAutomationInbound(edge, config);
      // 401 (tag): pure CPU, before any body or database work.
      const ref = inbound.verifyTag(c.req.header("Authorization"));
      // 413: the stream's own byte count. A GET carries no body of interest, but one that is too large is still refused.
      const text = await readBody(c.req.raw, BODY_LIMIT_BYTES);
      if (text === null) return c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413);
      // 429: both units or neither, charged before the token row is read.
      const taken = await config.limiter.take([
        { key: `sites-minute:${ref.tenantId}:${ref.tokenId}`, rule: SITES_MINUTE_LIMIT },
        { key: `sites-hour:${ref.tenantId}:${ref.tokenId}`, rule: SITES_HOUR_LIMIT },
      ], { signal: c.var.signal, remainingMs: edge.timeLeft ?? (() => Infinity) });
      if (!taken.ok)
        return c.json(apiErrorBody("RateLimited", "Too many requests"), 429, { "Retry-After": String(taken.retryAfterSeconds) });
      // 401: the token row.
      const principal = await inbound.principalFor(ref);
      const session = createAutomationSites(edge).forToken(principal);
      const result = await run(session, c, withBody ? parseJson(c, text) : undefined);
      return c.json(result.value, result.status ?? 200);
    };

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .get("/:siteId", guarded(false, async (s, c) => ({ value: await s.getSite(c.req.param("siteId")) })))
    .post("/:siteId/preview", guarded(true, async (s, c, body) => ({ value: await s.previewSite(c.req.param("siteId"), body) })))
    .get("/:siteId/releases", guarded(false, async (s, c) => ({ value: await s.listSiteReleases(c.req.param("siteId")) })))
    .post("/:siteId/releases", guarded(true, async (s, c, body) => ({
      value: await s.publishSite(c.req.param("siteId"), body, c.req.header("Idempotency-Key")), status: 201 as const,
    })))
    .get("/:siteId/releases/:releaseId", guarded(false, async (s, c) => ({
      value: await s.getSiteRelease(c.req.param("siteId"), c.req.param("releaseId")),
    })))
    .post("/:siteId/releases/:releaseId/activate", guarded(true, async (s, c, body) => ({
      value: await s.activateSiteRelease(c.req.param("siteId"), c.req.param("releaseId"), body, c.req.header("Idempotency-Key")),
    })))
    .post("/:siteId/sync", guarded(false, async (s, c) => ({ value: await s.syncSite(c.req.param("siteId")) })));
}
