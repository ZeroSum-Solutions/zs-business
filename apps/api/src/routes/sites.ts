import { Hono } from "hono";
import { SITE_BLOB_MAX_BYTES } from "@zs/contracts";
import { apiErrorBody } from "@zs/core";
import type { AppEnv } from "../app.js";
import { readBodyBytes } from "../mcp/routes.js";
import { idempotencyKey, jsonBody } from "./request.js";

// M4b site releases. Owners only (the "publish" permission). Publishing compiles the spec,
// stores the files, records the release and makes it live; activate is the rollback.

/** hub-access.md H-16: `PUT /v1/sites/:id/blobs/:sha256` takes raw bytes; app.ts keeps the 64 KiB limit off it. */
export const SITE_BLOB_PATH = /^\/v1\/sites\/[^/]+\/blobs\/[^/]+$/;
export const siteRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.var.session.listSites()))
  .post("/", async (c) => c.json(await c.var.session.createSite(await jsonBody(c), idempotencyKey(c)), 201))
  .get("/:id", async (c) => c.json(await c.var.session.getSite(c.req.param("id"))))
  .post("/:id/preview", async (c) => c.json(await c.var.session.previewSite(c.req.param("id"), await jsonBody(c))))
  .get("/:id/releases", async (c) => c.json(await c.var.session.listSiteReleases(c.req.param("id"))))
  .post("/:id/releases", async (c) =>
    c.json(await c.var.session.publishSite(c.req.param("id"), await jsonBody(c), idempotencyKey(c)), 201))
  .get("/:id/releases/:releaseId", async (c) =>
    c.json(await c.var.session.getSiteRelease(c.req.param("id"), c.req.param("releaseId"))))
  .post("/:id/releases/:releaseId/activate", async (c) =>
    c.json(await c.var.session.activateSiteRelease(c.req.param("id"), c.req.param("releaseId"), await jsonBody(c), idempotencyKey(c))))
  .post("/:id/sync", async (c) => c.json(await c.var.session.syncSite(c.req.param("id"))))
  // The cap is SITE_BLOB_MAX_BYTES (4 MiB, under the host's 4.5 MB body limit), checked after authentication like the
  // image upload (IM-22). The bytes actually read are counted (H-5 step 3): a false `Content-Length` cannot get past.
  .put("/:id/blobs/:sha256", async (c) => {
    const bytes = await readBodyBytes(c.req.raw, SITE_BLOB_MAX_BYTES).catch(() => new Uint8Array(0));
    if (bytes === null) return c.json(apiErrorBody("ValidationFailed", "Blob is too large"), 413);
    const blob = await c.var.session.putSiteBlob(c.req.param("id"), c.req.param("sha256"), bytes);
    return c.json(blob, blob.created ? 201 : 200);
  });
