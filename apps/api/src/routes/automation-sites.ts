// hub-access.md H-15: `/automation/v1/sites`, the site routes for a `zsap1_` token that holds `sites:publish`.
// The checks run in the contract's order and the first to fail answers: 401 (the tag, pure CPU), 413 (body over
// 64 KiB, counted on the stream), 429 (two buckets charged in one statement on the tag's tenant and token,
// before the token row is read), then the token session: 401 (the row), 403 (no scope), 404 (a site the token
// does not name; the same answer for a foreign site, an unnamed one and an ID nothing holds), and last the
// body (400) and the publish rules. A body that cannot be read is held back as a value no schema accepts, so
// it is refused only after the site gate. The blob route (H-16) takes raw bytes under its own 10 MiB cap in the
// same order. Original code.
import { Hono, type Context } from "hono";
import { SITE_LIMITS } from "@zs/contracts";
import {
  apiErrorBody, createAutomationInbound, createAutomationSites, type AutomationKeySecrets, type EdgeDependencies,
} from "@zs/core";
import type { AppEnv } from "../app.js";
import { readBodyBytes } from "../mcp/routes.js";
import type { RateLimit, RateLimiter } from "../public/limiter.js";

export const AUTOMATION_SITES_PREFIX = "/automation/v1/sites";
/** H-15: units per token, counted one per request whose tag is valid. */
export const SITES_MINUTE_LIMIT: RateLimit = { limit: 30, windowMs: 60_000 };
export const SITES_HOUR_LIMIT: RateLimit = { limit: 300, windowMs: 3_600_000 };
const BODY_LIMIT_BYTES = 64 * 1024;
/** H-16: a blob is a release file, and a release refuses a file over this. */
export const BLOB_LIMIT_BYTES = SITE_LIMITS.fileBytes;

/** What a route reads from the body: nothing, JSON (64 KiB) or raw bytes (up to a limit). */
type BodyMode = "none" | "json" | { readonly bytes: number };

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
  const guarded = (mode: BodyMode, run: (session: Session, c: Context<AppEnv>, body: unknown) => Promise<{ value: unknown; status?: 200 | 201 }>) =>
    async (c: Context<AppEnv>) => {
      const edge = requestEdge(c);
      const inbound = createAutomationInbound(edge, config);
      // 401 (tag): pure CPU, before any body or database work.
      const ref = inbound.verifyTag(c.req.header("Authorization"));
      // 413: the stream's own byte count. A GET carries no body of interest, but one that is too large is still refused.
      // A stream that fails mid-read (the caller went away) is an unreadable body: held back like a malformed one.
      const bytes = await readBodyBytes(c.req.raw, typeof mode === "object" ? mode.bytes : BODY_LIMIT_BYTES).catch(() => new Uint8Array(0));
      if (bytes === null) return c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413);
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
      const body = mode === "none" ? undefined : mode === "json" ? parseJson(c, new TextDecoder().decode(bytes)) : bytes;
      const result = await run(session, c, body);
      return c.json(result.value, result.status ?? 200);
    };

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .get("/:siteId", guarded("none", async (s, c) => ({ value: await s.getSite(c.req.param("siteId")) })))
    .post("/:siteId/preview", guarded("json", async (s, c, body) => ({ value: await s.previewSite(c.req.param("siteId"), body) })))
    .get("/:siteId/releases", guarded("none", async (s, c) => ({ value: await s.listSiteReleases(c.req.param("siteId")) })))
    .post("/:siteId/releases", guarded("json", async (s, c, body) => ({
      value: await s.publishSite(c.req.param("siteId"), body, c.req.header("Idempotency-Key")), status: 201 as const,
    })))
    .get("/:siteId/releases/:releaseId", guarded("none", async (s, c) => ({
      value: await s.getSiteRelease(c.req.param("siteId"), c.req.param("releaseId")),
    })))
    .post("/:siteId/releases/:releaseId/activate", guarded("json", async (s, c, body) => ({
      value: await s.activateSiteRelease(c.req.param("siteId"), c.req.param("releaseId"), body, c.req.header("Idempotency-Key")),
    })))
    .post("/:siteId/sync", guarded("none", async (s, c) => ({ value: await s.syncSite(c.req.param("siteId")) })))
    .put("/:siteId/blobs/:sha256", guarded({ bytes: BLOB_LIMIT_BYTES }, async (s, c, body) => {
      const blob = await s.putSiteBlob(c.req.param("siteId"), c.req.param("sha256"), body as Uint8Array);
      return { value: blob, status: blob.created ? 201 as const : 200 as const };
    }));
}
