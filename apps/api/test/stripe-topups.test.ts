// M5 wallet top-ups through the real app (docs/requirements/stripe.md S-1, S-2), with an
// injected fetch standing in for Stripe's Checkout Sessions endpoint. No network.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorBodySchema, createTopUpResponseSchema, topUpSchema } from "@zs/contracts";
import { CHECKOUT_LIFETIME_MS, CHECKOUT_RETRY_LIMIT_MS } from "@zs/core";
import { call, createApiHarness, NOW, signedInMember, type ApiHarness } from "./helpers.js";
import { CANCEL_URL, fakeStripe, json, STRIPE_KEY, stripeApp, SUCCESS_URL } from "./stripe-fixtures.js";

let now = Date.parse(NOW);
const clock = { now: () => new Date(now) };
let h: ApiHarness;
let stripe: ReturnType<typeof fakeStripe>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
let app: ReturnType<typeof stripeApp>;

beforeAll(async () => { h = await createApiHarness({ clock }); });
afterAll(async () => h?.close());
beforeEach(() => {
  now = Date.parse(NOW);
  stripe = fakeStripe();
  onError = vi.fn<(error: unknown) => void>();
  app = stripeApp(h, { clock, stripe: stripe.client(), onError });
});

/** `key: null` sends no Idempotency-Key. */
const topUp = (token: string, amount: unknown, key: string | null = randomUUID()) =>
  call(app, "POST", "/v1/wallet/top-ups", { token, body: { amount }, ...(key === null ? {} : { key }) });
const topUpRows = (tenantId: string) => h.fixture.service(async (tx) => (await tx.query<{ id: string; amount: string; status: string }>(
  "SELECT id, amount, status FROM wallet_topups WHERE tenant_id=$1 ORDER BY created_at, id", [tenantId])).rows);

describe("POST /v1/wallet/top-ups (S-1, S-2)", () => {
  it("records a pending top-up and answers 201 with the Checkout URL", async () => {
    const response = await topUp(h.a.token, 2_500);
    expect(response.status).toBe(201);
    const body = createTopUpResponseSchema.parse(response.body);
    expect(body.topup).toEqual({
      id: body.topup.id, amount: 2_500, currency: "usd", status: "pending", refunded: 0, createdAt: NOW, paidAt: null,
    });
    const session = [...stripe.sessions.values()][0]!;
    expect(body.checkoutUrl).toBe(session.url);

    // One request to Stripe, keyed and parameterised from the stored row and config.
    expect(stripe.calls).toHaveLength(1);
    const [request] = stripe.calls;
    expect(request!.url).toBe("https://stripe.fake.test/v1/checkout/sessions");
    expect(request!.headers).toMatchObject({
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Idempotency-Key": `zst-${body.topup.id}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(Object.fromEntries(request!.form)).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "2500",
      "line_items[0][price_data][product_data][name]": "Message credit",
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      client_reference_id: body.topup.id,
      "metadata[zs_tenant]": h.a.tenantId,
      "metadata[zs_topup]": body.topup.id,
      "payment_intent_data[metadata][zs_tenant]": h.a.tenantId,
      "payment_intent_data[metadata][zs_topup]": body.topup.id,
      expires_at: String(Math.floor((Date.parse(NOW) + CHECKOUT_LIFETIME_MS) / 1000)),
    });
    expect(await topUpRows(h.a.tenantId)).toContainEqual({ id: body.topup.id, amount: "2500", status: "pending" });
  });

  it("needs an Idempotency-Key and writes nothing without one", async () => {
    const before = await topUpRows(h.a.tenantId);
    const response = await topUp(h.a.token, 1_000, null);
    expect(response.status).toBe(400);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    expect(stripe.calls).toHaveLength(0);
    expect(await topUpRows(h.a.tenantId)).toEqual(before);
  });

  it("replays the same top-up and its stored Checkout URL for the same key", async () => {
    const key = randomUUID();
    const first = createTopUpResponseSchema.parse((await topUp(h.a.token, 1_200, key)).body);
    now += 5 * 60_000;
    const retry = await topUp(h.a.token, 1_200, key);
    expect(retry.status).toBe(201);
    const second = createTopUpResponseSchema.parse(retry.body);
    expect(second).toEqual(first);
    // S-2: the session URL was stored, so the retry answers it without asking Stripe again.
    expect(stripe.calls).toHaveLength(1);
    expect((await topUpRows(h.a.tenantId)).filter((row) => row.id === first.topup.id)).toHaveLength(1);

    // Another key names another top-up.
    const other = createTopUpResponseSchema.parse((await topUp(h.a.token, 1_200)).body);
    expect(other.topup.id).not.toBe(first.topup.id);
  });

  it("refuses the same key with another amount", async () => {
    const key = randomUUID();
    expect((await topUp(h.a.token, 1_000, key)).status).toBe(201);
    const reused = await topUp(h.a.token, 1_500, key);
    expect(reused.status).toBe(409);
    expect(stripe.calls).toHaveLength(1);
  });

  it("refuses staff, who lack the billing permission, and anonymous callers", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const before = await topUpRows(h.a.tenantId);
    const refused = await topUp(staff.token, 1_000);
    expect(refused.status).toBe(403);
    expect(apiErrorBodySchema.parse(refused.body).error.code).toBe("Forbidden");
    expect((await call(app, "GET", "/v1/wallet/top-ups", { token: staff.token })).status).toBe(403);
    expect((await call(app, "POST", "/v1/wallet/top-ups", { body: { amount: 1_000 }, key: randomUUID() })).status).toBe(401);
    expect(stripe.calls).toHaveLength(0);
    expect(await topUpRows(h.a.tenantId)).toEqual(before);
  });

  it("is not found without Stripe config", async () => {
    const off = stripeApp(h, { clock });
    const response = await call(off, "POST", "/v1/wallet/top-ups", { token: h.a.token, key: randomUUID(), body: { amount: 1_000 } });
    expect(response.status).toBe(404);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
  });

  it("refuses amounts outside the configured range or not whole minor units", async () => {
    const before = await topUpRows(h.a.tenantId);
    for (const amount of [499, 50_001, 0, -100, 12.5, "1000", null, 100_000_001]) {
      const response = await topUp(h.a.token, amount);
      expect(response.status, String(amount)).toBe(400);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("ValidationFailed");
    }
    expect((await call(app, "POST", "/v1/wallet/top-ups", { token: h.a.token, key: randomUUID(), body: { amount: 1_000, currency: "eur" } })).status)
      .toBe(400);
    expect(stripe.calls).toHaveLength(0);
    expect(await topUpRows(h.a.tenantId)).toEqual(before);
    // The bounds themselves are allowed.
    expect((await topUp(h.a.token, 500)).status).toBe(201);
    expect((await topUp(h.a.token, 50_000)).status).toBe(201);
  });

  it.each([
    ["Stripe unreachable", () => { throw new TypeError("fetch failed"); }],
    ["Stripe 429", () => json(429, { error: { type: "rate_limit_error" } })],
    ["Stripe 500", () => json(500, { error: { type: "api_error" } })],
    ["Stripe 409 (key in flight)", () => json(409, { error: { type: "idempotency_error" } })],
    ["an unreadable success", () => json(200, { id: "not-a-session" })],
  ])("answers 503 with Retry-After when %s, and the retry with the same key succeeds", async (_label, answer) => {
    const key = randomUUID();
    stripe.answerNext(answer);
    const failed = await topUp(h.a.token, 3_000, key);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("1");
    expect(apiErrorBodySchema.parse(failed.body).error.code).toBe("Unavailable");
    expect(onError).not.toHaveBeenCalled();
    // The pending top-up committed before Stripe was asked; the retry names it and pays it.
    const pending = (await topUpRows(h.a.tenantId)).filter((row) => row.amount === "3000" && row.status === "pending");
    const retry = await topUp(h.a.token, 3_000, key);
    expect(retry.status).toBe(201);
    const body = createTopUpResponseSchema.parse(retry.body);
    expect(pending.map((row) => row.id)).toContain(body.topup.id);
    expect(stripe.calls).toHaveLength(2);
    expect(stripe.calls[1]!.body).toBe(stripe.calls[0]!.body);
  });

  it("answers 500 for any other Stripe refusal and reports it, without leaking Stripe's words", async () => {
    stripe.answerNext(() => json(400, { error: { type: "invalid_request_error", code: "parameter_invalid", message: "secret detail" } }));
    const response = await topUp(h.a.token, 4_000);
    expect(response.status).toBe(500);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Internal");
    expect(JSON.stringify(response.body)).not.toContain("secret detail");
    expect(JSON.stringify(response.body)).not.toContain("parameter_invalid");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ name: "StripeRequestFailed", code: "stripe_400_parameter_invalid", retry: false });
  });

  it("refuses a retry past the retry window with 409 topup_closed, without asking Stripe again", async () => {
    const key = randomUUID();
    expect((await topUp(h.a.token, 1_000, key)).status).toBe(201);
    // At the limit itself the retry still goes through, with the stored session URL.
    now += CHECKOUT_RETRY_LIMIT_MS;
    expect((await topUp(h.a.token, 1_000, key)).status).toBe(201);
    now += 1;
    const late = await topUp(h.a.token, 1_000, key);
    expect(late.status).toBe(409);
    expect(apiErrorBodySchema.parse(late.body).error).toMatchObject({ code: "Conflict", details: { reason: "topup_closed" } });
    expect(stripe.calls).toHaveLength(1);
  });

  it("refuses a retry for a top-up that is no longer pending with 409 topup_closed", async () => {
    const key = randomUUID();
    const first = createTopUpResponseSchema.parse((await topUp(h.a.token, 1_000, key)).body);
    await h.fixture.service((tx) => tx.query(
      "UPDATE wallet_topups SET status='expired', updated_at=$3 WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, first.topup.id, new Date(now)]));
    const retry = await topUp(h.a.token, 1_000, key);
    expect(retry.status).toBe(409);
    expect(apiErrorBodySchema.parse(retry.body).error.details).toEqual({ reason: "topup_closed" });
    expect(stripe.calls).toHaveLength(1);
  });
});

describe("GET /v1/wallet/top-ups", () => {
  it("lists the caller's own tenant only, newest first", async () => {
    const before = await call(app, "GET", "/v1/wallet/top-ups", { token: h.b.token });
    expect(before.status).toBe(200);
    // Later than every top-up the tests above made, so these come first in each list.
    now += 10 * 60_000;
    const mineA = createTopUpResponseSchema.parse((await topUp(h.a.token, 777)).body).topup;
    now += 1_000;
    const mineB1 = createTopUpResponseSchema.parse((await topUp(h.b.token, 888)).body).topup;
    now += 1_000;
    const mineB2 = createTopUpResponseSchema.parse((await topUp(h.b.token, 999)).body).topup;

    const listA = await call(app, "GET", "/v1/wallet/top-ups", { token: h.a.token });
    const listB = await call(app, "GET", "/v1/wallet/top-ups", { token: h.b.token });
    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    const itemsA = (listA.body as { items: unknown[] }).items.map((item) => topUpSchema.parse(item));
    const itemsB = (listB.body as { items: unknown[] }).items.map((item) => topUpSchema.parse(item));
    expect(itemsA[0]!.id).toBe(mineA.id);
    expect(itemsB.slice(0, 2).map((item) => item.id)).toEqual([mineB2.id, mineB1.id]);
    const idsA = new Set(itemsA.map((item) => item.id));
    for (const item of itemsB) expect(idsA.has(item.id)).toBe(false);
    expect(itemsB.map((item) => item.id)).not.toContain(mineA.id);
    // Under the runtime role, tenant B's scope cannot read A's rows directly either.
    expect((await h.fixture.b.run((tx) => tx.query("SELECT id FROM wallet_topups WHERE id=$1", [mineA.id]))).rows).toEqual([]);
  });
});
