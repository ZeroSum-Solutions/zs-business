import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// inbox-home.md I-8: threads are read with inbox.drafts; drafts and discards need inbox.drafts,
// approving needs approve (owners only) and runs the send through an approval (approvals.md A-6, A-7).
// inbound-email.md IE-24: these member routes are the only reads that show sender threads and email
// entries; MCP and automation tokens do not see them until slice 4 (IE-33).
const MEMBER_EMAIL = { includeEmail: true } as const;
export const inboxRoutes = new Hono<AppEnv>()
  .get("/threads", async (c) => c.json(await c.var.session.listThreads(c.req.query(), MEMBER_EMAIL)))
  .get("/threads/:threadId", async (c) => c.json(await c.var.session.getThread(c.req.param("threadId"), MEMBER_EMAIL)))
  .post("/replies", async (c) =>
    c.json(await c.var.session.draftReply(await jsonBody(c), idempotencyKey(c)), 201))
  .post("/replies/:id/approve", async (c) =>
    c.json(await c.var.session.approveReply(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .post("/replies/:id/discard", async (c) =>
    c.json(await c.var.session.discardReply(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
