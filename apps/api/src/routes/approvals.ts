import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// approvals.md A-5..A-11: propose an action, an owner decides, approving also runs it.
export const approvalRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.var.session.listApprovals(c.req.query())))
  .post("/", async (c) =>
    c.json(await c.var.session.requestApproval(await jsonBody(c), idempotencyKey(c)), 201))
  .get("/:id", async (c) => c.json(await c.var.session.getApproval(c.req.param("id"))))
  .post("/:id/approve", async (c) =>
    c.json(await c.var.session.approveApproval(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .post("/:id/reject", async (c) =>
    c.json(await c.var.session.rejectApproval(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .post("/:id/revoke", async (c) =>
    c.json(await c.var.session.revokeApproval(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
