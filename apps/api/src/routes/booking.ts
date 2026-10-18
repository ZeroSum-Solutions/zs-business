import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

export const bookingRoutes = new Hono<AppEnv>()
  .get("/slots", async (c) => c.json(await c.var.session.findSlots(c.req.query())))
  .get("/resources", async (c) => c.json({ items: await c.var.session.listResources() }))
  .get("/bookings", async (c) => c.json(await c.var.session.listBookings(c.req.query())))
  .post("/bookings", async (c) =>
    c.json(await c.var.session.createBooking(await jsonBody(c), idempotencyKey(c)), 201));
