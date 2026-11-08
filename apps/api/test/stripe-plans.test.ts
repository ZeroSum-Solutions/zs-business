// Hub plans through the real app (docs/requirements/plans.md PL-4..PL-7, PL-13), with an injected
// fetch standing in for Stripe. No network. Fake pilot data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_PLAN_PRICE_KEYS, apiErrorBodySchema, billingPlanSchema, billingPortalResponseSchema, startPlanCheckoutResponseSchema } from "@zs/contracts";
import { createStripePlansClient, parsePlanEnv, setShopifyBilling } from "@zs/core";
import { parseServerEnv } from "../src/config.js";
import { call, createApiHarness, NOW, type ApiHarness } from "./helpers.js";
import { fakeStripe, json, STRIPE_CONFIG, stripeApp } from "./stripe-fixtures.js";

const clock = { now: () => new Date(NOW) };
const RETURN_URL = "https://app.haldenrowe.example/settings/plan";
const PRICES = Object.fromEntries(ALL_PLAN_PRICE_KEYS.map((key) => [key, `price_${key}`]));
let h: ApiHarness;
let stripe: ReturnType<typeof fakeStripe>;
let portalCalls: string[];

beforeAll(async () => { h = await createApiHarness({ clock }); });
afterAll(async () => h?.close());
beforeEach(() => { stripe = fakeStripe(); portalCalls = []; });

function plansApp(on = true, shopifyAppHandle?: string) {
  const fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/v1/billing_portal/sessions")) {
      portalCalls.push(String(init.body));
      return json(200, { id: "bps_test_1", url: "https://billing.stripe.fake.test/p/session/1" });
    }
    const id = `cs_test_${randomUUID().replaceAll("-", "")}`;
    stripe.calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, form: new URLSearchParams(String(init.body)), body: String(init.body) });
    return json(200, { id, url: `https://checkout.stripe.fake.test/c/pay/${id}` });
  };
  return stripeApp(h, {
    clock, stripe: stripe.client(),
    ...(on ? { stripePlans: createStripePlansClient({ stripe: STRIPE_CONFIG, plans: { prices: PRICES, returnUrl: RETURN_URL }, fetch }) } : {}),
    ...(shopifyAppHandle ? { shopifyAppHandle } : {}),
  });
}

describe("GET /v1/billing/plan (PL-7)", () => {
  it("shows a comped tenant the catalog, and says when plans are off", async () => {
    const on = await call(plansApp(), "GET", "/v1/billing/plan", { token: h.a.token });
    expect(on.status).toBe(200);
    expect(billingPlanSchema.parse(on.body)).toMatchObject({ status: "none", plan: null, limits: null, readOnly: false, checkoutEnabled: true,
      portalEnabled: false, trialAvailable: true });
    const off = await call(plansApp(false), "GET", "/v1/billing/plan", { token: h.a.token });
    expect(billingPlanSchema.parse(off.body)).toMatchObject({ checkoutEnabled: false, trialAvailable: false });
  });
});

describe("POST /v1/billing/plan/checkout (PL-4, PL-5)", () => {
  it("answers 201 with the Checkout URL, needs a key, and is 404 when plans are off", async () => {
    const app = plansApp();
    const response = await call(app, "POST", "/v1/billing/plan/checkout", { token: h.b.token, key: randomUUID(), body: { plan: "studio", interval: "year" } });
    expect(response.status).toBe(201);
    const body = startPlanCheckoutResponseSchema.parse(response.body);
    expect(body.checkout).toMatchObject({ plan: "studio", interval: "year", status: "pending", trialDays: 14 });
    expect(stripe.calls.at(-1)!.headers["Idempotency-Key"]).toBe(`zsp-${body.checkout.id}`);
    expect(stripe.calls.at(-1)!.form.get("line_items[0][price]")).toBe("price_hub_studio_year");
    const unkeyed = await call(app, "POST", "/v1/billing/plan/checkout", { token: h.b.token, body: { plan: "studio", interval: "year" } });
    expect(unkeyed.status).toBe(400);
    const open = await call(app, "POST", "/v1/billing/plan/checkout", { token: h.b.token, key: randomUUID(), body: { plan: "pro", interval: "month" } });
    expect(open.status).toBe(409);
    expect(apiErrorBodySchema.parse(open.body).error).toMatchObject({ code: "Conflict",
      details: { reason: "checkout_open", checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.fake\.test\//) } });
    const off = await call(plansApp(false), "POST", "/v1/billing/plan/checkout", { token: h.b.token, key: randomUUID(), body: { plan: "solo", interval: "month" } });
    expect(off.status).toBe(404);
  });
});

describe("POST /v1/billing/portal (PL-6)", () => {
  it("is 409 before a customer exists and opens the Portal after", async () => {
    const app = plansApp();
    expect((await call(app, "POST", "/v1/billing/portal", { token: h.a.token })).status).toBe(409);
    await h.fixture.service((tx) => tx.query(
      "INSERT INTO tenant_plans (tenant_id, stripe_customer_id, created_at, updated_at) VALUES ($1,'cus_test_portal1',now(),now()) ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id",
      [h.a.tenantId]));
    const opened = await call(app, "POST", "/v1/billing/portal", { token: h.a.token });
    expect(opened.status).toBe(200);
    expect(billingPortalResponseSchema.parse(opened.body).url).toMatch(/^https:\/\/billing\.stripe\.fake\.test\//);
    expect(new URLSearchParams(portalCalls[0]).get("customer")).toBe("cus_test_portal1");
  });
});

describe("plan environment (PL-13)", () => {
  it("is off without plan variables, refuses a partial price map, and never echoes values", () => {
    expect(parsePlanEnv({})).toBeNull();
    const partial = JSON.stringify({ hub_solo_month: "price_secretish1" });
    let message = "";
    try { parsePlanEnv({ STRIPE_PLAN_PRICES: partial, STRIPE_PLAN_RETURN_URL: RETURN_URL }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/STRIPE_PLAN_PRICES/);
    expect(message).not.toContain("price_secretish1");
    expect(() => parsePlanEnv({ STRIPE_PLAN_PRICES: JSON.stringify(PRICES) })).toThrow(/STRIPE_PLAN_RETURN_URL/);
    expect(parsePlanEnv({ STRIPE_PLAN_PRICES: JSON.stringify(PRICES), STRIPE_PLAN_RETURN_URL: RETURN_URL, STRIPE_PLAN_TRIAL_DAYS: "0" }))
      .toMatchObject({ returnUrl: RETURN_URL, trialDays: 0 });
    // Plan variables without the S-9 Stripe variables are a mistake, not a quiet "off".
    const server = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub", JWT_VERIFIER: "hs256",
      JWT_SECRET: ["test", "jwt", "s".repeat(32)].join("-") };
    expect(() => parseServerEnv({ ...server, STRIPE_PLAN_PRICES: JSON.stringify(PRICES), STRIPE_PLAN_RETURN_URL: RETURN_URL }))
      .toThrow(/STRIPE_PLAN_PRICES needs the STRIPE_ top-up variables/);
  });
});

describe("a Shopify-billed tenant (PL-19, PL-20)", () => {
  it("gets Shopify's plan page and no Stripe Checkout, Portal or trial", async () => {
    const shop = { id: "gid://shopify/Shop/90210", domain: "halden-rowe.myshopify.com" };
    const link = (value: typeof shop | null) =>
      h.fixture.service((tx) => setShopifyBilling(tx, { tenantId: h.b.tenantId, shop: value, now: clock.now(), graceDays: 7 }));
    // The earlier tests left this tenant's checkouts open; PL-17 refuses a link while one is young.
    await h.fixture.service((tx) => tx.query("UPDATE plan_checkouts SET status='expired' WHERE tenant_id=$1 AND status='pending'", [h.b.tenantId]));
    await link(shop);
    try {
      const view = billingPlanSchema.parse((await call(plansApp(true, "zs-business-connections"), "GET", "/v1/billing/plan", { token: h.b.token })).body);
      expect(view).toMatchObject({ billingProvider: "shopify", checkoutEnabled: false, portalEnabled: false, trialAvailable: false,
        shopifyManageUrl: "https://admin.shopify.com/store/halden-rowe/charges/zs-business-connections/pricing_plans" });
      expect(billingPlanSchema.parse((await call(plansApp(), "GET", "/v1/billing/plan", { token: h.b.token })).body).shopifyManageUrl).toBeNull();
      const refused = await call(plansApp(), "POST", "/v1/billing/plan/checkout", {
        token: h.b.token, key: randomUUID(), body: { plan: "solo", interval: "month" } });
      expect(refused.status).toBe(409);
      expect(apiErrorBodySchema.parse(refused.body)).toMatchObject({ error: { details: { reason: "billing_provider" } } });
    } finally {
      await link(null);
    }
  });

  it("reads SHOPIFY_BILLING_APP_HANDLE as an app handle, or leaves the link off", () => {
    const server = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub", JWT_VERIFIER: "hs256",
      JWT_SECRET: ["test", "jwt", "s".repeat(32)].join("-") };
    expect(parseServerEnv(server).shopifyAppHandle).toBeNull();
    expect(parseServerEnv({ ...server, SHOPIFY_BILLING_APP_HANDLE: "zs-business-connections" }).shopifyAppHandle).toBe("zs-business-connections");
    for (const bad of ["", "Has Space", "https://apps.shopify.com/x", "-lead"])
      expect(() => parseServerEnv({ ...server, SHOPIFY_BILLING_APP_HANDLE: bad })).toThrow(/SHOPIFY_BILLING_APP_HANDLE/);
  });
});
