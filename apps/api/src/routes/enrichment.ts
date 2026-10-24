import { Hono, type Context } from "hono";
import type { EnrichmentSession } from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// enrichment.md E-4, E-6, E-7, E-17: a company lookup for one contact. Reads need `enrich` or
// `customers`; requests, lifting a block and the region mark need `enrich` (owners); staff may block.
export function enrichmentRoutes(sessionFor: (c: Context<AppEnv>) => EnrichmentSession) {
  return new Hono<AppEnv>()
    .post("/enrichment/requests", async (c) =>
      c.json(await sessionFor(c).requestEnrichment(await jsonBody(c), idempotencyKey(c)), 201))
    .get("/enrichment/requests/:id", async (c) => c.json(await sessionFor(c).getRequest(c.req.param("id"))))
    .get("/contacts/:id/enrichment", async (c) => c.json(await sessionFor(c).getContactEnrichment(c.req.param("id"))))
    .post("/contacts/:id/enrichment/block", async (c) =>
      c.json(await sessionFor(c).block(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
    .post("/contacts/:id/enrichment/unblock", async (c) =>
      c.json(await sessionFor(c).unblock(c.req.param("id"), idempotencyKey(c))))
    .post("/contacts/:id/region", async (c) =>
      c.json(await sessionFor(c).attestRegion(c.req.param("id"), idempotencyKey(c))));
}
