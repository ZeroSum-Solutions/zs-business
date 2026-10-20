import { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

export const crmRoutes = new Hono<AppEnv>()
  .get("/contacts", async (c) => c.json(await c.var.session.listContacts(c.req.query())))
  .get("/contacts/:id", async (c) => c.json(await c.var.session.getContact(c.req.param("id"))))
  .post("/contacts", async (c) => {
    const output = await c.var.session.upsertContact(await jsonBody(c), idempotencyKey(c));
    // 201 when this action created the contact, 200 when it matched an existing one.
    return c.json(output, output.result.created ? 201 : 200);
  })
  .get("/pipelines", async (c) => c.json({ items: await c.var.session.listPipelines() }))
  .get("/deals", async (c) => c.json(await c.var.session.listDeals(c.req.query())))
  .post("/deals", async (c) =>
    c.json(await c.var.session.createDeal(await jsonBody(c), idempotencyKey(c)), 201))
  .post("/deals/:id/stage", async (c) =>
    c.json(await c.var.session.moveDealStage(c.req.param("id"), await jsonBody(c), idempotencyKey(c))))
  // inbox-home.md H-1: value and lead source, with the same revision check as a stage move.
  .post("/deals/:id/details", async (c) =>
    c.json(await c.var.session.setDealDetails(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
