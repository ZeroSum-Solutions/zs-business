import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// approvals.md F-4, F-7: record where a fact came from, and list a subject's records.
export const sourceRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.var.session.listSources(c.req.query())))
  .post("/", async (c) => c.json(await c.var.session.observeSource(await jsonBody(c), idempotencyKey(c))));
