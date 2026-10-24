import { Hono, type Context } from "hono";
import type { FollowUpAgent, TemplateSession, TemplatedAgents } from "@zs/core";
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

/** G-19, A-15: how the routes get one request's template session and templated agents. */
export interface TemplateRouteFactories {
  readonly session: (c: Context<AppEnv>) => TemplateSession;
  readonly agents: (c: Context<AppEnv>) => TemplatedAgents;
}

// agents.md G-14: the other agent kinds' status, settings and switches. The follow-up kind keeps
// its own routes above (`/v1/agents/followup`), so its ID is refused here. Mounted after them.
// G-19, G-20, A-15: a templated kind also has its template, revisions, standing approval, wording
// suggestion and runs. `template-suggestion` is a 404 when the server has no suggestion model.
export function agentKindRoutes(templates?: TemplateRouteFactories) {
  const routes = new Hono<AppEnv>()
    .get("/:agentKind", async (c) => c.json(await c.var.session.getAgentKindStatus(c.req.param("agentKind"))))
    .put("/:agentKind/settings", async (c) =>
      c.json(await c.var.session.updateAgentKindSettings(c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c))))
    .post("/:agentKind/kill", async (c) =>
      c.json(await c.var.session.killAgentKind(c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c))))
    .post("/:agentKind/resume", async (c) =>
      c.json(await c.var.session.resumeAgentKind(c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c))));
  if (templates)
    routes
      .get("/:agentKind/template", async (c) => c.json(await templates.session(c).getTemplate(c.req.param("agentKind"))))
      .post("/:agentKind/template/revisions", async (c) =>
        c.json(await templates.session(c).createRevision(c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c)), 201))
      .post("/:agentKind/template/approve", async (c) =>
        c.json(await templates.session(c).approveTemplate(c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c))))
      .post("/:agentKind/template-suggestion", async (c) =>
        c.json(await templates.agents(c).suggest(c.var.session.principal, c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c))))
      .post("/:agentKind/runs", async (c) =>
        c.json(await templates.agents(c).runForMember(c.var.session.principal, c.req.param("agentKind"), await jsonBody(c), idempotencyKey(c)), 201));
  return routes;
}
