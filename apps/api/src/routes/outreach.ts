import type { createOutreachSession } from "@zs/core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

/**
 * Cold-email outreach (docs/requirements/outreach-sequencer.md OS-22), mounted at /v1/outreach only when the API has
 * an OUTREACH_TENANTS allowlist; without it every route is an unknown route (404). A tenant outside the list answers 404
 * from the session as well. Each route needs the `outreach` permission (owners). Writes need an Idempotency-Key. The
 * owner approves an activation through the existing POST /v1/approvals/:id/approve.
 */
export function outreachRoutes(session: (c: Context<AppEnv>) => ReturnType<typeof createOutreachSession>) {
  return new Hono<AppEnv>()
    .get("/campaigns", async (c) => c.json(await session(c).listCampaigns()))
    .post("/campaigns", async (c) => c.json(await session(c).createCampaign(await jsonBody(c), idempotencyKey(c)), 201))
    .get("/campaigns/:id", async (c) => c.json(await session(c).getCampaign(c.req.param("id"))))
    .post("/campaigns/:id/prospects", async (c) =>
      c.json(await session(c).importProspects(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
    .get("/campaigns/:id/prospects", async (c) => c.json(await session(c).listProspects(c.req.param("id"), c.req.query())))
    // OS-8: answers { approvalId }; the owner approves it at /v1/approvals/:id/approve.
    .post("/campaigns/:id/activation", async (c) =>
      c.json(await session(c).requestActivation(c.req.param("id"), idempotencyKey(c)), 201))
    .post("/campaigns/:id/pause", async (c) => c.json(await session(c).pauseCampaign(c.req.param("id"), idempotencyKey(c))))
    .post("/prospects/:id/stop", async (c) => c.json(await session(c).stopProspect(c.req.param("id"), idempotencyKey(c))))
    .get("/mailboxes", async (c) => c.json(await session(c).listMailboxes()));
}
