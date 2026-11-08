// Shopify-billed tenants (docs/requirements/plans.md PL-15..PL-19) against the local Postgres with
// a manual clock and an in-process stand-in for the Partner API's activeSubscription answer,
// written from Shopify's public docs in our own words. Nothing leaves the process. All data is
// synthetic.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSession, createShopifyPlanSync, createShopifySubscriptionReader, setShopifyBilling, SHOPIFY_LINK_CHECKOUT_GATE_MS,
  SHOPIFY_PLAN_KEYS, ShopifyPartnerError, type ShopifySubscriptionReader,
} from "../../src/index.js";
import { createBillingHarness, type BillingHarness } from "./helpers.js";
import { stubPlans } from "./plan-helpers.js";

const DAY = 86_400_000;
const TOKEN = ["shppa", "f".repeat(32)].join("_");
const HANDLES = Object.fromEntries(SHOPIFY_PLAN_KEYS.map((key) => [key, key.replaceAll("_", "-")])) as Record<(typeof SHOPIFY_PLAN_KEYS)[number], string>;

let b: BillingHarness;
beforeAll(async () => { b = await createBillingHarness(); });
afterEach(async () => { await b.settle(); });
afterAll(async () => { await b?.close(); });

let shopSeq = 7_000_000 + Math.floor(Math.random() * 1_000_000);
const newShop = () => {
  shopSeq += 1;
  return { id: `gid://shopify/Shop/${shopSeq}`, domain: `halden-${shopSeq}.myshopify.com` };
};

interface FakeContract {
  billingPeriod?: string;
  trialEndsAt?: Date | null;
  cycleEnd?: Date | null;
  cancelAtEndOfCycle?: boolean;
  handles?: string[];
  shopId?: string;
}

/** The Partner API as fetch: a contract per shop, or queued failures answered first. */
function fakePartner() {
  const contracts = new Map<string, FakeContract | null>();
  // `before` runs first (another writer acting while the call is out); `answer` then answers normally.
  const failures: Array<{ status?: number; body?: unknown; throws?: boolean; cut?: boolean; before?: () => Promise<void>; answer?: boolean }> = [];
  const requests: Array<{ url: string; headers: Record<string, string>; body: { variables: { appId: string; shopId: string } } }> = [];
  const fetch: typeof globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    const queued = failures.shift();
    if (queued?.before) await queued.before();
    const failure = queued?.answer ? undefined : queued;
    if (failure?.throws) throw new TypeError("fetch failed");
    if (failure?.cut) return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new DOMException("The operation was aborted", "AbortError"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (failure && failure.status !== undefined && failure.status >= 300 && failure.status < 400)
      return new Response(null, { status: failure.status, headers: { location: "https://elsewhere.example.test/" } });
    if (failure) return new Response(JSON.stringify(failure.body ?? {}), { status: failure.status ?? 200, headers: { "content-type": "application/json" } });
    const shopId = body.variables.shopId as string;
    const found = contracts.get(shopId);
    const answer = found ? {
      shop: { id: found.shopId ?? shopId },
      billingPeriod: found.billingPeriod ?? "EVERY_30_DAYS",
      cancelAtEndOfCycle: found.cancelAtEndOfCycle ?? false,
      trialEndsAt: found.trialEndsAt ? found.trialEndsAt.toISOString() : null,
      currentBillingCycle: found.cycleEnd === null ? null : { endTime: (found.cycleEnd ?? new Date(b.h.clock.now().getTime() + 30 * DAY)).toISOString() },
      items: (found.handles ?? [HANDLES.hub_studio]).map((handle) => ({ handle })),
    } : null;
    return new Response(JSON.stringify({ data: { activeSubscription: answer } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { contracts, failures, requests, fetch };
}

let partner = fakePartner();
const reader = (): ShopifySubscriptionReader => createShopifySubscriptionReader({
  config: { partnerId: "5300652", token: TOKEN, appId: "444984655873", planHandles: HANDLES, baseUrl: "https://partners.example.test" },
  fetch: partner.fetch,
});
const reports: Array<{ tenantId: string; outcome: string }> = [];
const sync = (limit = 100) => createShopifyPlanSync({
  service: b.h.service, clock: b.h.clock, reader: reader(), limit, graceDays: 7, sleep: async () => {},
  report: (event) => reports.push(event),
});
const plan = async (tenantId: string) =>
  (await b.h.rows<Record<string, any>>("SELECT * FROM tenant_plans WHERE tenant_id=$1", [tenantId]))[0];
const shopRow = async (tenantId: string, shopId: string) =>
  (await b.h.rows<Record<string, any>>("SELECT * FROM plan_subscriptions WHERE tenant_id=$1 AND id=$2", [tenantId, shopId]))[0];
const link = (tenantId: string, shop: { id: string; domain: string } | null) =>
  b.h.service((tx) => setShopifyBilling(tx, { tenantId, shop, now: b.h.clock.now(), graceDays: 7 }));
/** Runs passes until this tenant has been synced (other tests' tenants may be due too). */
async function syncTenant(tenantId: string) {
  await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id=$1", [tenantId]));
  await b.h.service((tx) => tx.query(
    "UPDATE tenant_plans SET shopify_next_sync_at=$2 WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL AND tenant_id <> $1",
    [tenantId, new Date(b.h.clock.now().getTime() + 365 * DAY)]));
  return sync().runOnce();
}

describe("the Partner API reader (PL-18)", () => {
  it("asks activeSubscription for the shop with the Partner token and parses the contract", async () => {
    partner = fakePartner();
    const shop = newShop();
    const trial = new Date(b.h.clock.now().getTime() + 14 * DAY);
    partner.contracts.set(shop.id, { billingPeriod: "ANNUAL", trialEndsAt: trial, cycleEnd: null, handles: [HANDLES.hub_pro] });
    expect(await reader().active(shop.id)).toEqual({
      shopId: shop.id, billingPeriod: "ANNUAL", trialEndsAt: trial, cycleEnd: null, cancelAtEndOfCycle: false, handles: [HANDLES.hub_pro],
    });
    const sent = partner.requests[0]!;
    expect(sent.url).toBe("https://partners.example.test/5300652/api/2026-10/graphql.json");
    expect(sent.headers["X-Shopify-Access-Token"]).toBe(TOKEN);
    expect(sent.body.variables).toEqual({ appId: "gid://shopify/App/444984655873", shopId: shop.id });
    expect(await reader().active(newShop().id)).toBeNull();
  });

  it("never reads a failure as no contract, and says which failures end the pass", async () => {
    partner = fakePartner();
    const shop = newShop();
    const cases: Array<[Parameters<typeof partner.failures.push>[0], boolean]> = [
      [{ throws: true }, true],
      [{ status: 429 }, true],
      [{ status: 503 }, true],
      [{ status: 200, body: { errors: [{ message: "Too many requests" }] } }, true],
      [{ status: 200, body: { errors: [{ message: "Shop not found" }] } }, false],
      [{ status: 401, body: { errors: "unauthorized" } }, true],
      [{ status: 200, body: { data: { activeSubscription: { shop: { id: shop.id } } } } }, false],
      // An errors field that is not a list is an error, never "no contract".
      [{ status: 200, body: { data: { activeSubscription: null }, errors: { message: "service failure" } } }, false],
      // Upstream text that echoes a token is redacted.
      [{ status: 200, body: { errors: [{ message: `bad token ${TOKEN} and prtapi_${"a".repeat(32)}` }] } }, false],
      // A body cut off after the headers is a transport failure.
      [{ cut: true }, true],
      [{ status: 302 }, true],
      // An answer over 64 KiB is not read to the end.
      [{ status: 200, body: { data: { activeSubscription: null }, pad: "x".repeat(70_000) } }, false],
    ];
    for (const [failure, stopPass] of cases) {
      partner.failures.push(failure);
      const error = await reader().active(shop.id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ShopifyPartnerError);
      expect((error as ShopifyPartnerError).stopPass).toBe(stopPass);
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toMatch(/prtapi_|f{24}/);
    }
    partner.contracts.set(shop.id, { shopId: newShop().id });
    await expect(reader().active(shop.id)).rejects.toThrow(/another shop/);
    // The token goes only to an https origin, whoever builds the reader.
    for (const baseUrl of ["http://partners.example.test", "https://user:pw@partners.example.test", "https://partners.example.test/proxy"])
      expect(() => createShopifySubscriptionReader({ config: { partnerId: "5300652", token: TOKEN, appId: "444984655873", planHandles: HANDLES, baseUrl } }))
        .toThrow();
    expect(() => createShopifySubscriptionReader({ config: { partnerId: "5300652", token: TOKEN, appId: "444984655873", planHandles: HANDLES, baseUrl: "http://127.0.0.1:9" } }))
      .not.toThrow();
  });
});

describe("linking a tenant to its shop (PL-17)", () => {
  it("links, refuses a shop another tenant holds, and clears only when no Shopify plan holds", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await expect(link(tenantId, { id: "gid://shopify/Shop/x", domain: shop.domain })).rejects.toMatchObject({ details: { reason: "shop_invalid" } });
    await expect(link(tenantId, { id: shop.id, domain: "halden.example.com" })).rejects.toMatchObject({ details: { reason: "shop_invalid" } });
    expect(await link(tenantId, { id: shop.id, domain: shop.domain.toUpperCase() })).toEqual({ billingProvider: "shopify", shopId: shop.id });
    // A comped tenant stays comped until a contract is seen.
    expect(await plan(tenantId)).toMatchObject({ billing_provider: "shopify", shopify_shop_id: shop.id, shopify_shop_domain: shop.domain, status: "none" });
    const other = await b.tenant();
    await expect(link(other, shop)).rejects.toMatchObject({ details: { reason: "shop_taken" } });

    partner.contracts.set(shop.id, { handles: [HANDLES.hub_studio] });
    await syncTenant(tenantId);
    expect(await plan(tenantId)).toMatchObject({ status: "active", plan: "studio" });
    await expect(link(tenantId, null)).rejects.toMatchObject({ details: { reason: "shopify_plan_active" } });
    await expect(link(tenantId, newShop())).rejects.toMatchObject({ details: { reason: "shopify_plan_active" } });

    partner.contracts.set(shop.id, null);
    await syncTenant(tenantId);
    expect(await link(tenantId, null)).toEqual({ billingProvider: "stripe", shopId: null });
    expect(await plan(tenantId)).toMatchObject({ billing_provider: "stripe", shopify_shop_id: null, shopify_shop_domain: null });
    // The shop's row stays with this tenant, so no other business can be billed by it.
    await expect(link(other, shop)).rejects.toMatchObject({ details: { reason: "shop_taken" } });
  });

  it("refuses while a Stripe plan, a young plan checkout or an open top-up could still charge", async () => {
    const tenantId = await b.tenant();
    const at = b.h.clock.now();
    await b.h.service((tx) => tx.query(
      `INSERT INTO plan_subscriptions (tenant_id, provider, id, status, plan, plan_interval, started_at, status_since, created_at, updated_at)
       VALUES ($1,'stripe',$2,'past_due','solo','month',$3,$3,$3,$3)`, [tenantId, `sub_${randomUUID().replaceAll("-", "")}`, at]));
    await expect(link(tenantId, newShop())).rejects.toMatchObject({ details: { reason: "stripe_plan_active" } });
    await b.h.service((tx) => tx.query("UPDATE plan_subscriptions SET status='canceled', ended_at=$2 WHERE tenant_id=$1", [tenantId, at]));

    await b.h.service((tx) => tx.query(
      `INSERT INTO plan_checkouts (tenant_id, id, plan, plan_interval, plan_price_id, success_url, cancel_url, created_by, created_at, updated_at)
       VALUES ($1,$2,'studio','month','price_x','https://a.test/','https://a.test/',$2,$3,$3)`, [tenantId, randomUUID(), at]));
    await expect(link(tenantId, newShop())).rejects.toMatchObject({ details: { reason: "stripe_plan_active" } });
    b.h.clock.advance(SHOPIFY_LINK_CHECKOUT_GATE_MS + 1);

    await b.startTopUp(tenantId, 2_500);
    await expect(link(tenantId, newShop())).rejects.toMatchObject({ details: { reason: "stripe_plan_active" } });
    // Age alone never frees the link: a delayed payment can still settle a completed Checkout.
    b.h.clock.advance(7 * DAY);
    await expect(link(tenantId, newShop())).rejects.toMatchObject({ details: { reason: "stripe_plan_active" } });
    await b.h.service((tx) => tx.query("UPDATE wallet_topups SET status='expired' WHERE tenant_id=$1", [tenantId]));
    await expect(link(tenantId, newShop())).resolves.toMatchObject({ billingProvider: "shopify" });
  });
});

describe("the Shopify pass (PL-18)", () => {
  it("stores a trial, then the paid contract, and derives the plan from it", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    const trialEnd = new Date(b.h.clock.now().getTime() + 14 * DAY);
    partner.contracts.set(shop.id, { billingPeriod: "ANNUAL", trialEndsAt: trialEnd, cycleEnd: null, handles: ["unrelated-item", HANDLES.hub_pro] });
    expect(await syncTenant(tenantId)).toMatchObject({ checked: 1, outcomes: { plan_synced: 1 }, stopped: false });
    expect(await shopRow(tenantId, shop.id)).toMatchObject({ provider: "shopify", status: "trialing", plan: "pro", plan_interval: "year", extra_connections: 0 });
    expect(await plan(tenantId)).toMatchObject({
      status: "trialing", plan: "pro", plan_interval: "year", trial_end: trialEnd, stripe_subscription_id: null, read_only_after: null,
      shopify_sync_failures: 0, shopify_synced_at: b.h.clock.now(),
    });

    b.h.clock.advance(15 * DAY);
    const cycleEnd = new Date(b.h.clock.now().getTime() + 365 * DAY);
    partner.contracts.set(shop.id, { billingPeriod: "ANNUAL", trialEndsAt: trialEnd, cycleEnd, cancelAtEndOfCycle: true, handles: [HANDLES.hub_pro] });
    await syncTenant(tenantId);
    expect(await plan(tenantId)).toMatchObject({ status: "active", plan: "pro", current_period_end: cycleEnd, cancel_at_period_end: true });
  });

  it("keeps the plan on an unknown handle or period, and ends mismatch when none was ever known", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    partner.contracts.set(shop.id, { handles: ["mystery"] });
    reports.length = 0;
    expect((await syncTenant(tenantId)).outcomes).toEqual({ mismatch: 1 });
    expect(reports).toEqual([{ tenantId, outcome: "mismatch" }]);
    expect(await plan(tenantId)).toMatchObject({ status: "none", plan: null });

    partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    await syncTenant(tenantId);
    expect(await plan(tenantId)).toMatchObject({ status: "active", plan: "solo", plan_interval: "month" });
    // A known handle with an unknown period keeps both, as the plan and interval count together.
    partner.contracts.set(shop.id, { billingPeriod: "EVERY_90_DAYS", handles: [HANDLES.hub_pro] });
    expect((await syncTenant(tenantId)).outcomes).toEqual({ mismatch: 1 });
    expect(await plan(tenantId)).toMatchObject({ plan: "solo", plan_interval: "month" });
  });

  it("ends the row when the contract is gone, turns read-only, and starts a new contract after", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    // No contract and no row: nothing is written but the sync time.
    expect((await syncTenant(tenantId)).outcomes).toEqual({ no_contract: 1 });
    expect(await shopRow(tenantId, shop.id)).toBeUndefined();
    expect(await plan(tenantId)).toMatchObject({ status: "none", read_only_after: null });

    partner.contracts.set(shop.id, { handles: [HANDLES.hub_studio_founding] });
    await syncTenant(tenantId);
    const firstStart = (await shopRow(tenantId, shop.id))!.started_at;
    expect(await plan(tenantId)).toMatchObject({ status: "active", plan: "studio", founding: true, founding_started_at: firstStart });

    b.h.clock.advance(DAY);
    partner.contracts.set(shop.id, null);
    await syncTenant(tenantId);
    const ended = b.h.clock.now();
    expect(await shopRow(tenantId, shop.id)).toMatchObject({ status: "canceled", ended_at: ended, status_since: ended });
    // PL-18: no grace for Shopify; the founding invite is the operator's to clear.
    expect(await plan(tenantId)).toMatchObject({ status: "canceled", read_only_after: ended, founding_started_at: firstStart });
    const gate = await b.h.service((tx) => tx.query<{ ro: boolean }>("SELECT read_only_after <= $2 AS ro FROM tenant_plans WHERE tenant_id=$1", [tenantId, b.h.clock.now()]));
    expect(gate.rows[0]!.ro).toBe(true);

    b.h.clock.advance(DAY);
    partner.contracts.set(shop.id, { handles: [HANDLES.hub_studio] });
    await syncTenant(tenantId);
    expect(await shopRow(tenantId, shop.id)).toMatchObject({ status: "active", started_at: b.h.clock.now(), ended_at: null });
    expect(await plan(tenantId)).toMatchObject({ status: "active", read_only_after: null });
  });

  it("writes nothing on a failure, backs the tenant off, and stops the pass on throttling", async () => {
    partner = fakePartner();
    const first = await b.tenant();
    const second = await b.tenant();
    const shops = [newShop(), newShop()];
    await link(first, shops[0]!);
    await link(second, shops[1]!);
    partner.contracts.set(shops[0]!.id, { handles: [HANDLES.hub_solo] });
    partner.contracts.set(shops[1]!.id, { handles: [HANDLES.hub_solo] });
    await syncTenant(first);
    b.h.clock.advance(1_000);
    await syncTenant(second);
    // Only these two are due, the first least recently synced.
    await b.h.service((tx) => tx.query(
      "UPDATE tenant_plans SET shopify_next_sync_at=$1 WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL",
      [new Date(b.h.clock.now().getTime() + 365 * DAY)]));
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id = ANY($1::uuid[])", [[first, second]]));
    const before = (await plan(first))!;

    partner.failures.push({ status: 200, body: { errors: [{ message: "Shop not found" }] } });
    partner.contracts.set(shops[1]!.id, null);
    const pass = await sync().runOnce();
    expect(pass).toEqual({ checked: 2, outcomes: { error: 1, no_contract: 1 }, stopped: false });
    expect(await plan(first)).toMatchObject({ status: "active", shopify_synced_at: before.shopify_synced_at, shopify_sync_failures: 1,
      shopify_next_sync_at: new Date(b.h.clock.now().getTime() + 60_000) });
    expect((await shopRow(first, shops[0]!.id))!.status).toBe("active");

    // Not due yet: the next pass leaves it alone.
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=$2 WHERE tenant_id=$1",
      [second, new Date(b.h.clock.now().getTime() + 365 * DAY)]));
    expect((await sync().runOnce()).checked).toBe(0);
    b.h.clock.advance(60_000);
    partner.failures.push({ status: 429 });
    expect(await sync().runOnce()).toEqual({ checked: 1, outcomes: { error: 1 }, stopped: true });
    expect(await plan(first)).toMatchObject({ shopify_sync_failures: 2, shopify_next_sync_at: new Date(b.h.clock.now().getTime() + 120_000) });

    b.h.clock.advance(120_000);
    await sync().runOnce();
    expect(await plan(first)).toMatchObject({ shopify_sync_failures: 0, shopify_next_sync_at: null, shopify_synced_at: b.h.clock.now() });
  });

  it("calls Shopify for no tenant once the deadline has passed", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id=$1", [tenantId]));
    expect(await sync().runOnce({ deadline: b.h.clock.now() })).toEqual({ checked: 0, outcomes: {}, stopped: false });
    expect(partner.requests).toHaveLength(0);
  });

  it("checks the deadline after the pause between calls", async () => {
    partner = fakePartner();
    const tenants = [await b.tenant(), await b.tenant()];
    for (const tenantId of tenants) {
      const shop = newShop();
      await link(tenantId, shop);
      partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    }
    await b.h.service((tx) => tx.query(
      "UPDATE tenant_plans SET shopify_next_sync_at=$1 WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL",
      [new Date(b.h.clock.now().getTime() + 365 * DAY)]));
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id = ANY($1::uuid[])", [tenants]));
    // 2.2 s left: the first call has its budget; after the 500 ms pause the second would not.
    const pass = createShopifyPlanSync({
      service: b.h.service, clock: b.h.clock, reader: reader(), limit: 100, graceDays: 7,
      sleep: async (ms) => { b.h.clock.advance(ms); },
    });
    expect(await pass.runOnce({ deadline: new Date(b.h.clock.now().getTime() + 2_200) })).toEqual({ checked: 1, outcomes: { plan_synced: 1 }, stopped: false });
    expect(partner.requests).toHaveLength(1);
  });

  it("drops an answer and keeps a newer sync when another run synced the tenant during the call", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    const newer = new Date(b.h.clock.now().getTime() + 5);
    const otherRun = async () => {
      await b.h.service((tx) => tx.query(
        "UPDATE tenant_plans SET shopify_synced_at=$2, shopify_sync_failures=0, shopify_next_sync_at=NULL WHERE tenant_id=$1", [tenantId, newer]));
    };
    // A success that raced: skipped, nothing stored.
    partner.failures.push({ before: otherRun, answer: true });
    expect((await syncTenant(tenantId)).outcomes).toEqual({ skipped: 1 });
    expect(await shopRow(tenantId, shop.id)).toBeUndefined();
    // A failure that raced: the newer sync stays, with no failure and no backoff.
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_synced_at=NULL WHERE tenant_id=$1", [tenantId]));
    partner.failures.push({ before: otherRun, status: 200, body: { errors: [{ message: "Shop not found" }] } });
    expect((await syncTenant(tenantId)).outcomes).toEqual({ error: 1 });
    expect(await plan(tenantId)).toMatchObject({ shopify_synced_at: newer, shopify_sync_failures: 0, shopify_next_sync_at: null });
  });

  it("skips, without a call, a tenant another run put into backoff after this pass picked it", async () => {
    partner = fakePartner();
    const tenants = [await b.tenant(), await b.tenant()].sort();
    for (const tenantId of tenants) {
      const shop = newShop();
      await link(tenantId, shop);
      partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    }
    await b.h.service((tx) => tx.query(
      "UPDATE tenant_plans SET shopify_next_sync_at=$1 WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL",
      [new Date(b.h.clock.now().getTime() + 365 * DAY)]));
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id = ANY($1::uuid[])", [tenants]));
    // While the first call is out, another run fails on the second tenant and stores its backoff.
    partner.failures.push({
      before: () => b.h.service(async (tx) => { await tx.query(
        "UPDATE tenant_plans SET shopify_sync_failures=1, shopify_next_sync_at=$2 WHERE tenant_id=$1",
        [tenants[1], new Date(b.h.clock.now().getTime() + 60_000)]); }),
      answer: true,
    });
    expect(await sync().runOnce()).toEqual({ checked: 1, outcomes: { plan_synced: 1, skipped: 1 }, stopped: false });
    expect(partner.requests).toHaveLength(1);
    expect(await plan(tenants[1]!)).toMatchObject({ shopify_sync_failures: 1, shopify_synced_at: null });
  });

  it("skips a tenant whose plan lock wait runs out and goes on with the next", async () => {
    partner = fakePartner();
    const tenants = [await b.tenant(), await b.tenant()].sort();
    for (const tenantId of tenants) {
      const shop = newShop();
      await link(tenantId, shop);
      partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    }
    await b.h.service((tx) => tx.query(
      "UPDATE tenant_plans SET shopify_next_sync_at=$1 WHERE billing_provider='shopify' AND shopify_shop_id IS NOT NULL",
      [new Date(b.h.clock.now().getTime() + 365 * DAY)]));
    await b.h.service((tx) => tx.query("UPDATE tenant_plans SET shopify_next_sync_at=NULL WHERE tenant_id = ANY($1::uuid[])", [tenants]));
    // Calls: the pick, the first tenant's re-read, then its store transaction, which times out.
    let calls = 0;
    const service: typeof b.h.service = (work) => {
      calls += 1;
      if (calls === 3) return Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
      return b.h.service(work);
    };
    const pass = createShopifyPlanSync({ service, clock: b.h.clock, reader: reader(), limit: 100, graceDays: 7, sleep: async () => {} });
    expect(await pass.runOnce()).toEqual({ checked: 2, outcomes: { error: 1, plan_synced: 1 }, stopped: false });
    expect(await plan(tenants[0]!)).toMatchObject({ shopify_sync_failures: 1, shopify_next_sync_at: expect.any(Date) });
    expect(await plan(tenants[1]!)).toMatchObject({ plan: "solo", shopify_sync_failures: 0 });
  });

  it("gives a new contract after an ended one no plan from the ended one", async () => {
    partner = fakePartner();
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    partner.contracts.set(shop.id, { handles: [HANDLES.hub_pro_founding] });
    await syncTenant(tenantId);
    partner.contracts.set(shop.id, null);
    await syncTenant(tenantId);
    const ended = await plan(tenantId);
    expect(ended).toMatchObject({ read_only_after: expect.any(Date) });
    partner.contracts.set(shop.id, { handles: ["mystery"] });
    expect((await syncTenant(tenantId)).outcomes).toEqual({ mismatch: 1 });
    // The ended row stays as it was, so the tenant stays read-only instead of turning comped.
    expect(await shopRow(tenantId, shop.id)).toMatchObject({ status: "canceled", plan: "pro", founding: true });
    expect(await plan(tenantId)).toMatchObject({ plan: ended!.plan, status: ended!.status, read_only_after: ended!.read_only_after, shopify_synced_at: b.h.clock.now() });
    // A recognised contract then starts afresh.
    partner.contracts.set(shop.id, { handles: [HANDLES.hub_solo] });
    expect((await syncTenant(tenantId)).outcomes).toEqual({ plan_synced: 1 });
    expect(await plan(tenantId)).toMatchObject({ plan: "solo", founding: false, read_only_after: null });
  });
});

describe("links that race (PL-17)", () => {
  /** Holds one link's transaction open until `release`, so a second writer must wait for it. */
  function heldLink(tenantId: string, shop: { id: string; domain: string }) {
    let release!: () => void;
    let linked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { linked = resolve; });
    const done = b.h.service(async (tx) => {
      await setShopifyBilling(tx, { tenantId, shop, now: b.h.clock.now(), graceDays: 7 });
      linked();
      await gate;
    });
    return { ready, release, done };
  }

  it("gives two businesses linking one shop at once one link and one shop_taken", async () => {
    const shop = newShop();
    const first = await b.tenant();
    const second = await b.tenant();
    const held = heldLink(first, shop);
    await held.ready;
    const racing = link(second, shop);
    await new Promise((resolve) => setTimeout(resolve, 150));
    held.release();
    await held.done;
    await expect(racing).rejects.toMatchObject({ details: { reason: "shop_taken" } });
    expect(await plan(first)).toMatchObject({ shopify_shop_id: shop.id });
  });

  it("makes a top-up started during a link wait for it, then refuses it", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const held = heldLink(tenantId, newShop());
    await held.ready;
    const racing = session.createTopUp({ amount: 2_500 }, `topup-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    held.release();
    await held.done;
    await expect(racing).rejects.toMatchObject({ details: { reason: "billing_provider" } });
    expect((await b.h.rows("SELECT 1 FROM wallet_topups WHERE tenant_id=$1", [tenantId])).length).toBe(0);
  });
  it("takes one plan lock for a tenant ID in either letter case", async () => {
    const tenantId = await b.tenant();
    const session = await b.session(tenantId);
    const held = heldLink(tenantId.toUpperCase(), newShop());
    await held.ready;
    const racing = session.createTopUp({ amount: 2_500 }, `topup-${randomUUID()}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    held.release();
    await held.done;
    await expect(racing).rejects.toMatchObject({ details: { reason: "billing_provider" } });
    expect((await b.h.rows("SELECT 1 FROM wallet_topups WHERE tenant_id=$1", [tenantId])).length).toBe(0);
  });
});

describe("the plan for a Shopify tenant (PL-15, PL-19)", () => {
  it("offers Shopify's plan page, no Stripe trial, Checkout, Portal or top-up", async () => {
    const tenantId = await b.tenant();
    const shop = newShop();
    await link(tenantId, shop);
    const actorId = await b.owner(tenantId);
    const session = (handle?: string) => createSession({
      db: b.h.database.db, clock: b.h.clock, generateId: randomUUID,
      billing: { stripe: b.stripe.client, plans: stubPlans() }, ...(handle ? { shopifyBilling: { appHandle: handle } } : {}),
    }, { tenantId, actorId });
    const view = await session("zs-business-connections").getBillingPlan();
    expect(view).toMatchObject({
      billingProvider: "shopify", checkoutEnabled: false, portalEnabled: false, trialAvailable: false, trialDays: 0,
      shopifyManageUrl: `https://admin.shopify.com/store/${shop.domain.replace(".myshopify.com", "")}/charges/zs-business-connections/pricing_plans`,
    });
    expect((await session().getBillingPlan()).shopifyManageUrl).toBeNull();
    await expect(session().createTopUp({ amount: 2_500 }, `topup-${randomUUID()}`))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "billing_provider" } });

    // A Stripe tenant gets no Shopify link.
    const stripeTenant = await b.tenant();
    const stripeView = await createSession({
      db: b.h.database.db, clock: b.h.clock, generateId: randomUUID,
      billing: { stripe: b.stripe.client, plans: stubPlans() }, shopifyBilling: { appHandle: "zs-business-connections" },
    }, { tenantId: stripeTenant, actorId: await b.owner(stripeTenant) }).getBillingPlan();
    expect(stripeView).toMatchObject({ billingProvider: "stripe", shopifyManageUrl: null, trialAvailable: true });
  });

  it("refuses a top-up's Checkout, a replay included, once the tenant is linked to Shopify", async () => {
    const tenantId = await b.tenant();
    const key = `topup-${randomUUID()}`;
    const started = await (await b.session(tenantId)).createTopUp({ amount: 2_500 }, key);
    expect(started.checkoutUrl).toBeTruthy();
    // Linked by hand, past the link gate, to reach the second check.
    await b.h.service((tx) => tx.query(
      "INSERT INTO tenant_plans (tenant_id, billing_provider, created_at, updated_at) VALUES ($1,'shopify',$2,$2) ON CONFLICT (tenant_id) DO UPDATE SET billing_provider='shopify'",
      [tenantId, b.h.clock.now()]));
    await expect((await b.session(tenantId)).createTopUp({ amount: 2_500 }, `topup-${randomUUID()}`))
      .rejects.toMatchObject({ details: { reason: "billing_provider" } });
    await expect((await b.session(tenantId)).createTopUp({ amount: 2_500 }, key))
      .rejects.toMatchObject({ details: { reason: "billing_provider" } });
  });
});
