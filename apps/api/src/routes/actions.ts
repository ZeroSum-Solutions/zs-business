import { Hono } from "hono";
import type { AppEnv } from "../app.js";

// Backlog B05: the owner's redacted action log and one action's receipt.
export const actionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json(await c.var.session.listActions(c.req.query())))
  .get("/:id", async (c) => c.json(await c.var.session.getAction(c.req.param("id"))));
