import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// M4b site releases. Owners only (the "publish" permission). Publishing compiles the spec,
// stores the files, records the release and makes it live; activate is the rollback.
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
  .post("/:id/sync", async (c) => c.json(await c.var.session.syncSite(c.req.param("id"))));
