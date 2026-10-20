import { PENDING_GRANT_HEADER } from "@zs/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

/**
 * Google Calendar connections (google-calendar.md G-1, G-2, G-5). Listing needs "calendar";
 * connecting and disconnecting decide what the public pages offer, so they need the owner-only
 * "publish". A grant the callback staged arrives in a header (the dashboard keeps it in a Strict
 * cookie); confirming it takes no Idempotency-Key, since it runs under the key the grant derives.
 */
export const calendarRoutes = new Hono<AppEnv>()
  .get("/calendar/connections", async (c) => c.json(await c.var.session.listCalendarConnections()))
  .post("/calendar/google/connect", async (c) => {
    const answer = await c.var.session.startGoogleConnect(await jsonBody(c), idempotencyKey(c));
    // The URL carries a signed state; no cache may keep it.
    c.header("Cache-Control", "no-store");
    return c.json(answer, 200);
  })
  .get("/calendar/google/pending", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await c.var.session.pendingGoogleConnect(c.req.header(PENDING_GRANT_HEADER)));
  })
  .post("/calendar/google/confirm", async (c) =>
    c.json(await c.var.session.confirmGoogleConnect(c.req.header(PENDING_GRANT_HEADER))))
  .post("/calendar/connections/:id/disconnect", async (c) =>
    c.json(await c.var.session.disconnectCalendar(c.req.param("id"), idempotencyKey(c))));
