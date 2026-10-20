import { Hono, type Context } from "hono";
import type { FollowUpAgent } from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// agents.md G-11: the follow-up agent's status, settings and switches, and its runs. Reads and
// the kill need inbox.drafts; settings, resume and a run now need agents (owners only).
// `POST /runs` exists only when the server has a model configured; otherwise it is a 404.
export function followUpRoutes(agentFor?: (c: Context<AppEnv>) => FollowUpAgent) {
  const routes = new Hono<AppEnv>()
    .get("/", async (c) => c.json(await c.var.session.getFollowUpStatus()))
    .put("/settings", async (c) =>
      c.json(await c.var.session.updateFollowUpSettings(await jsonBody(c), idempotencyKey(c))))
    .post("/kill", async (c) =>
      c.json(await c.var.session.killFollowUp(await jsonBody(c), idempotencyKey(c))))
    .post("/resume", async (c) =>
      c.json(await c.var.session.resumeFollowUp(await jsonBody(c), idempotencyKey(c))))
    .get("/runs", async (c) => c.json(await c.var.session.listFollowUpRuns(c.req.query())))
    .get("/runs/:id", async (c) => c.json(await c.var.session.getFollowUpRun(c.req.param("id"))));
  if (agentFor)
    routes.post("/runs", async (c) =>
      c.json(await agentFor(c).runForMember(c.var.session.principal, await jsonBody(c), idempotencyKey(c)), 201));
  return routes;
}
