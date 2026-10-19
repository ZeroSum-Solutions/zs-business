import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// public-intake.md P-12: the owner reviews website intake through the shared dispatcher.
export const intakeRoutes = new Hono<AppEnv>()
  .get("/items", async (c) => c.json(await c.var.session.listIntakeItems(c.req.query())))
  .post("/items/:id/link", async (c) =>
    c.json(await c.var.session.linkIntakeItem(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .post("/items/:id/reject", async (c) =>
    c.json(await c.var.session.rejectIntakeItem(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
