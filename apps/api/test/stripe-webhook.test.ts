// POST /webhooks/stripe (docs/requirements/stripe.md S-3) through the real app, and the path a
// paid top-up takes end to end: route, Stripe's signed event, the billing worker, the wallet.
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, createTopUpResponseSchema, topUpSchema, walletSummarySchema } from "@zs/contracts";
import { signStripeWebhook } from "@zs/core";
import { asService, createRuntimePool, createScopedDatabase, type Transaction } from "@zs/db";
import { createBillingRunner, createBillingWorkerFromPool } from "../src/billing/runner.js";
import { call, clock, createApiHarness, NOW, type ApiHarness } from "./helpers.js";
import { fakeStripe, PREVIOUS_STRIPE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET, stripeApp } from "./stripe-fixtures.js";

const NOW_SECONDS = Math.floor(clock.now().getTime() / 1000);
const UNAUTHORIZED = { error: { code: "Unauthorized", message: "Invalid webhook signature", details: {} } };
const WEBHOOK = { secrets: { current: STRIPE_WEBHOOK_SECRET, previous: PREVIOUS_STRIPE_WEBHOOK_SECRET }, livemode: false };

const eventId = () => `evt_test_${randomUUID().replaceAll("-", "")}`;
const stripeId = (prefix: string) => `${prefix}_test_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
function event(type: string, object: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: eventId(), object: "event", type, livemode: false, created: NOW_SECONDS, data: { object }, ...overrides };
}

interface Post {
  timestamp?: number;
  secret?: string;
  /** Signs this instead of the body sent, for tampering. */
  signedBody?: string;
  header?: string | null;
}
async function post(app: ReturnType<typeof stripeApp>, body: string, options: Post = {}) {
  const header = options.header === undefined
    ? signStripeWebhook(options.secret ?? STRIPE_WEBHOOK_SECRET, options.timestamp ?? NOW_SECONDS, options.signedBody ?? body)
    : options.header;
  const response = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(header === null ? {} : { "Stripe-Signature": header }) },
    body,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as unknown : null };
}

let h: ApiHarness;
let app: ReturnType<typeof stripeApp>;
beforeAll(async () => {
  h = await createApiHarness();
  app = stripeApp(h, { clock, stripeWebhook: WEBHOOK });
});
afterAll(async () => h?.close());

const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(h.database.servicePool, work);
const storedEvents = () => service(async (tx) => (await tx.query<{ id: string; type: string; payload: unknown; attempts: number; processed_at: Date | null }>(
  "SELECT id, type, payload, attempts, processed_at FROM stripe_events ORDER BY received_at, id")).rows);

describe("signed events are stored once (S-3)", () => {
  it("stores a valid event exactly as sent and answers 200 stored:true", async () => {
    const sent = event("checkout.session.expired", { id: stripeId("cs"), object: "checkout.session", metadata: {} });
    const response = await post(app, JSON.stringify(sent));
    expect(response).toMatchObject({ status: 200, body: { received: true, stored: true } });
    const row = (await storedEvents()).find((stored) => stored.id === sent.id);
    expect(row).toEqual({ id: sent.id, type: "checkout.session.expired", payload: sent, attempts: 0, processed_at: null });
  });

  it("answers a redelivery stored:false and changes nothing", async () => {
    const sent = event("charge.refunded", { id: stripeId("ch"), payment_intent: stripeId("pi"), amount_refunded: 100 });
    const body = JSON.stringify(sent);
    expect((await post(app, body)).body).toEqual({ received: true, stored: true });
    const before = await storedEvents();
    // Stripe re-signs a retry at a later time; the event ID is what counts.
    expect(await post(app, body, { timestamp: NOW_SECONDS + 60 })).toMatchObject({ status: 200, body: { received: true, stored: false } });
    expect(await post(app, body)).toMatchObject({ status: 200, body: { received: true, stored: false } });
    expect(await storedEvents()).toEqual(before);
  });

  it("accepts the previous secret during a rotation, and a header with several v1 entries", async () => {
    const rotated = event("checkout.session.expired", { id: stripeId("cs") });
    expect((await post(app, JSON.stringify(rotated), { secret: PREVIOUS_STRIPE_WEBHOOK_SECRET })).body).toEqual({ received: true, stored: true });

    const multi = event("checkout.session.expired", { id: stripeId("cs") });
    const body = JSON.stringify(multi);
    const good = signStripeWebhook(STRIPE_WEBHOOK_SECRET, NOW_SECONDS, body).split(",")[1]!;
    const header = `t=${NOW_SECONDS},v1=${"0".repeat(64)},${good},v0=ignored`;
    expect((await post(app, body, { header })).body).toEqual({ received: true, stored: true });
    const ids = (await storedEvents()).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([rotated.id, multi.id]));
  });

  it("acknowledges an event from the other mode and stores nothing", async () => {
    const live = event("checkout.session.completed", { id: stripeId("cs") }, { livemode: true });
    const before = await storedEvents();
    expect(await post(app, JSON.stringify(live))).toMatchObject({ status: 200, body: { received: true, stored: false } });
    expect(await storedEvents()).toEqual(before);
  });
});

describe("signature and body checks (S-3)", () => {
  it("answers 401 with one identical body for every unsigned, wrongly signed, tampered or stale request", async () => {
    const sent = event("checkout.session.completed", { id: stripeId("cs") });
    const body = JSON.stringify(sent);
    const other = "whsec_" + Buffer.from(["other", "stripe", "z".repeat(24)].join("-")).toString("base64");
    const signature = signStripeWebhook(STRIPE_WEBHOOK_SECRET, NOW_SECONDS, body);
    const before = await storedEvents();
    const attempts: Array<[string, Post]> = [
      ["missing header", { header: null }],
      ["empty header", { header: "" }],
      ["wrong secret", { secret: other }],
      ["tampered body", { signedBody: body.replace("checkout.session.completed", "checkout.session.expired") }],
      ["six minutes early", { timestamp: NOW_SECONDS - 6 * 60 }],
      ["six minutes late", { timestamp: NOW_SECONDS + 6 * 60 }],
      ["no v1 entry", { header: `t=${NOW_SECONDS}` }],
      ["v0 only", { header: signature.replace("v1=", "v0=") }],
      ["no timestamp", { header: signature.replace(/^t=\d+,/, "") }],
      ["bad timestamp", { header: signature.replace(/^t=\d+/, "t=soon") }],
      ["upper-case hex", { header: signature.replace(/v1=(.*)$/, (_m, hex: string) => `v1=${hex.toUpperCase()}`) }],
      ["over-long header", { header: `${signature},${"x".repeat(5000)}` }],
    ];
    for (const [name, options] of attempts) {
      const response = await post(app, body, options);
      expect(response.status, name).toBe(401);
      expect(response.body, name).toEqual(UNAUTHORIZED);
    }
    expect(await storedEvents()).toEqual(before);
  });

  it("answers 400 for a signed body that is not a Stripe event", async () => {
    const before = await storedEvents();
    const bodies = [
      "{not json",
      JSON.stringify({ hello: "world" }),
      JSON.stringify([]),
      JSON.stringify({ ...event("x.y", {}), id: "not_an_event" }),
      JSON.stringify({ ...event("x.y", {}), livemode: "false" }),
      JSON.stringify({ ...event("x.y", {}), data: {} }),
      JSON.stringify({ ...event("x.y", {}), type: "" }),
    ];
    for (const body of bodies) {
      const response = await post(app, body);
      expect(response.status, body).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
    expect(await storedEvents()).toEqual(before);
  });

  it("refuses a body over 256 KiB with 413", async () => {
    const big = event("checkout.session.completed", { id: stripeId("cs"), padding: "x".repeat(256 * 1024) });
    const before = await storedEvents();
    const response = await post(app, JSON.stringify(big));
    expect(response.status).toBe(413);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    expect(await storedEvents()).toEqual(before);
  });

  it("answers 503 when the database is unavailable, so Stripe delivers again", async () => {
    // A runtime pool aimed at a port nothing listens on.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    const pool = createRuntimePool({
      connectionString: `postgres://zs_runtime@127.0.0.1:${port}/postgres`, max: 1, connectionTimeoutMs: 500, onError: () => undefined,
    });
    try {
      const down = stripeApp(h, { clock, stripeWebhook: WEBHOOK, db: createScopedDatabase(pool) });
      const sent = event("checkout.session.completed", { id: stripeId("cs") });
      const response = await post(down, JSON.stringify(sent));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.body).toEqual({ error: { code: "Unavailable", message: "Service unavailable", details: {} } });
      // Signature failures still answer 401 without touching the database.
      expect((await post(down, JSON.stringify(sent), { header: null })).status).toBe(401);
      // The same delivery succeeds once the database is back.
      expect((await post(app, JSON.stringify(sent))).body).toEqual({ received: true, stored: true });
    } finally {
      await pool.end();
    }
  });

  it("is not served without stripeWebhook config", async () => {
    const off = stripeApp(h, { clock });
    const response = await post(off, JSON.stringify(event("checkout.session.completed", { id: stripeId("cs") })));
    expect(response.status).toBe(404);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
    // Nor by the default harness app.
    expect((await post(h.app, "{}")).status).toBe(404);
  });
});

describe("a paid top-up end to end (S-1..S-5)", () => {
  let e2e: ApiHarness;
  beforeAll(async () => { e2e = await createApiHarness(); });
  afterAll(async () => e2e?.close());

  it("credits the wallet once after Stripe's checkout.session.completed", async () => {
    const stripe = fakeStripe();
    const api = stripeApp(e2e, { clock, stripe: stripe.client(), stripeWebhook: WEBHOOK });
    const created = await call(api, "POST", "/v1/wallet/top-ups", { token: e2e.a.token, key: randomUUID(), body: { amount: 2_000 } });
    expect(created.status).toBe(201);
    const { topup } = createTopUpResponseSchema.parse(created.body);
    const request = stripe.calls[0]!.form;
    const sessionId = [...stripe.sessions.values()][0]!.id;
    const paymentIntent = stripeId("pi");

    // The session as Stripe reports it, its metadata echoed from our request.
    const completed = event("checkout.session.completed", {
      id: sessionId,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      amount_total: 2_000,
      currency: "usd",
      payment_intent: paymentIntent,
      client_reference_id: request.get("client_reference_id"),
      metadata: { zs_tenant: request.get("metadata[zs_tenant]"), zs_topup: request.get("metadata[zs_topup]") },
    });
    expect((await post(api, JSON.stringify(completed))).body).toEqual({ received: true, stored: true });
    // Stored only: no money moves until the worker runs.
    expect(walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.a.token })).body).balance).toBe(0);

    const worker = createBillingWorkerFromPool({ pool: e2e.database.servicePool, clock, generateId: randomUUID });
    const runner = createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 50 });
    expect(await runner.run()).toEqual({ passes: 1, claimed: 1, outcomes: { credited: 1 }, budgetSpent: false });

    const wallet = await call(api, "GET", "/v1/wallet", { token: e2e.a.token });
    expect(wallet.status).toBe(200);
    expect(walletSummarySchema.parse(wallet.body)).toEqual({ currency: "usd", balance: 2_000, reserved: 0, available: 2_000 });
    const list = await call(api, "GET", "/v1/wallet/top-ups", { token: e2e.a.token });
    expect((list.body as { items: unknown[] }).items.map((item) => topUpSchema.parse(item))).toEqual([
      { ...topup, status: "paid", paidAt: NOW },
    ]);

    // A redelivery is not stored again, and a later event for the same session credits nothing.
    expect((await post(api, JSON.stringify(completed))).body).toEqual({ received: true, stored: false });
    const succeeded = event("checkout.session.async_payment_succeeded", completed.data.object);
    expect((await post(api, JSON.stringify(succeeded))).body).toEqual({ received: true, stored: true });
    expect(await runner.run()).toEqual({ passes: 1, claimed: 1, outcomes: { already_credited: 1 }, budgetSpent: false });
    expect(await runner.run()).toEqual({ passes: 1, claimed: 0, outcomes: {}, budgetSpent: false });
    expect(walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.a.token })).body).balance).toBe(2_000);

    // Tenant B's wallet and list are untouched.
    expect(walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.b.token })).body).balance).toBe(0);
    expect((await call(api, "GET", "/v1/wallet/top-ups", { token: e2e.b.token })).body).toEqual({ items: [] });
    const processed = await asService(e2e.database.servicePool, async (tx) => (await tx.query<{ id: string; outcome: string }>(
      "SELECT id, outcome FROM stripe_events ORDER BY received_at, id")).rows);
    expect(processed).toEqual(expect.arrayContaining([
      { id: completed.id, outcome: "credited" }, { id: succeeded.id, outcome: "already_credited" },
    ]));
  });

  it("credits nothing for a session event that names another tenant's top-up", async () => {
    const stripe = fakeStripe();
    const api = stripeApp(e2e, { clock, stripe: stripe.client(), stripeWebhook: WEBHOOK });
    const created = createTopUpResponseSchema.parse((await call(api, "POST", "/v1/wallet/top-ups", {
      token: e2e.b.token, key: randomUUID(), body: { amount: 1_000 },
    })).body);
    const before = walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.a.token })).body).balance;
    // Tenant A's ID with tenant B's top-up: no such row in A.
    const forged = event("checkout.session.completed", {
      id: stripeId("cs"), mode: "payment", payment_status: "paid", amount_total: 1_000, currency: "usd",
      payment_intent: stripeId("pi"), metadata: { zs_tenant: e2e.a.tenantId, zs_topup: created.topup.id },
    });
    expect((await post(api, JSON.stringify(forged))).body).toEqual({ received: true, stored: true });
    const worker = createBillingWorkerFromPool({ pool: e2e.database.servicePool, clock, generateId: randomUUID });
    expect(await createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 50 }).run())
      .toEqual({ passes: 1, claimed: 1, outcomes: { not_ours: 1 }, budgetSpent: false });
    expect(walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.a.token })).body).balance).toBe(before);
    expect(walletSummarySchema.parse((await call(api, "GET", "/v1/wallet", { token: e2e.b.token })).body).balance).toBe(0);
  });
});
