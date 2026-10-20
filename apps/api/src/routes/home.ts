import { Hono } from "hono";
import type { AppEnv } from "../app.js";

// inbox-home.md H-3..H-5: this week against last week; needs reports (owners only).
export const homeRoutes = new Hono<AppEnv>()
  .get("/results", async (c) => c.json(await c.var.session.homeResults(c.req.query())));
