import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

export const bookingRoutes = new Hono<AppEnv>()
  .get("/slots", async (c) => c.json(await c.var.session.findSlots(c.req.query())))
  .get("/resources", async (c) => c.json({ items: await c.var.session.listResources() }))
  .get("/pages", async (c) => c.json({ items: await c.var.session.listBookingPages() }))
  .get("/bookings", async (c) => c.json(await c.var.session.listBookings(c.req.query())))
  .post("/bookings", async (c) =>
    c.json(await c.var.session.createBooking(await jsonBody(c), idempotencyKey(c)), 201))
  // booking-customer.md BC-6, BC-9: one booking with its customer and the revision for the next change.
  .get("/bookings/:id", async (c) => c.json(await c.var.session.getBooking(c.req.param("id"))))
  // BC-3, BC-4: link, change or clear who an owner-made booking is for; compare-and-set on the revision.
  .post("/bookings/:id/contact/link", async (c) =>
    c.json(await c.var.session.linkBookingContact(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  .post("/bookings/:id/contact/unlink", async (c) =>
    c.json(await c.var.session.unlinkBookingContact(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
