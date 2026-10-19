import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

/** Membership routes. Any member may read /me; only owners hold the "members" permission. */
export const memberRoutes = new Hono<AppEnv>()
  .get("/me", async (c) => c.json(await c.var.session.me()))
  .get("/members", async (c) => c.json(await c.var.session.listMembers()))
  .post("/members", async (c) =>
    c.json(await c.var.session.inviteMember(await jsonBody(c), idempotencyKey(c)), 201))
  .post("/members/:id/role", async (c) =>
    c.json(await c.var.session.changeMemberRole(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .delete("/members/:id", async (c) =>
    c.json(await c.var.session.removeMember(c.req.param("id"), idempotencyKey(c))));
