// The native Shopify tier (docs/requirements/connections.md C-21 to C-24, C-27) against real local Postgres and the
// in-process fake Shopify. No test reaches the network.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { shopifyOrdersResponseSchema } from "@zs/contracts";
import { createLocalShopifyPort, createShopifyClient, createShopifyNativeWorker, handleShopifyOperation, parseSealKeys, type HubPort, type ShopifyNativeReport, type ShopifyWorkerOps } from "../../src/index.js";
import { createConnectionsWorker, createComposioClient } from "../../src/index.js";
import { addMember, makeClock, T0, type TestClock } from "../connections/harness.js";
import { FakeComposio } from "../connections/fake-composio.js";
import { CLIENT_ID, CLIENT_SECRET, FakeShopify, mintIdToken, SHOP, SHOP_GID, signWebhook } from "./fake-shopify.js";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const OWNER_EMAIL = "owner@example.com";

let database: TestDatabase;
let fixture: TwoTenantFixture;
let fake: FakeShopify;
let clock: TestClock;
let reports: ShopifyNativeReport[];
let hubCalls: string[];
let hubFails: boolean;
let worker: ReturnType<typeof makeNative>;
let a: { tenantId: string; memberId: string; userId: string };
let b: { tenantId: string; memberId: string; userId: string };

function fakeHub(): HubPort {
  return {
    async createHub(input) {
      hubCalls.push(input.key);
      if (hubFails) return { kind: "failed" };
      const existing = await database.pool.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_members WHERE lower(email)=$1", [input.ownerEmail]);
      const tenantId = createHash("sha256").update(input.key).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5");
      if (existing.rows[0] && existing.rows[0].tenant_id !== tenantId) return { kind: "email_has_hub" };
      await database.pool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [tenantId, input.name]);
      await database.pool.query(
        "INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) SELECT $1,$2,$3,'owner',$4,$4 WHERE NOT EXISTS (SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND lower(email)=$3)",
        [tenantId, randomUUID(), input.ownerEmail, new Date(T0)]);
      return { kind: "ok", tenantId };
    },
    async signInLink(email) { return `https://hub.example.test/sign-in?e=${encodeURIComponent(email)}`; },
  };
}

function makeNative(over: { fetch?: typeof fetch } = {}) {
  return createShopifyNativeWorker({
    service: (work) => asService(database.servicePool, work),
    client: createShopifyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: "2026-10", fetch: over.fetch ?? fake.fetch, timeoutMs: 1000 }),
    clock,
    config: { clientId: CLIENT_ID, secrets: { current: CLIENT_SECRET }, sealKeys: parseSealKeys({ current: KEY_A, currentId: "k1" }), graceDays: 7 },
    hub: fakeHub(),
    newId: randomUUID,
    report: (event) => reports.push(event),
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  a = { tenantId: fixture.a.tenantId, ...(await addMember(fixture, fixture.a.tenantId, "owner")) };
  b = { tenantId: fixture.b.tenantId, ...(await addMember(fixture, fixture.b.tenantId, "owner")) };
}, 120_000);
afterAll(async () => { await database?.close(); });

beforeEach(async () => {
  await database.pool.query("DELETE FROM outbox");
  await database.pool.query("DELETE FROM actions");
  await database.pool.query("DELETE FROM connections");
  await database.pool.query("DELETE FROM shopify_claims");
  await database.pool.query("DELETE FROM shopify_installs");
  await database.pool.query("DELETE FROM shopify_locks");
  await database.pool.query("DELETE FROM shopify_webhook_events");
  await database.pool.query("DELETE FROM tenant_plans");
  await database.pool.query("DELETE FROM tenant_members WHERE lower(email)=$1", [OWNER_EMAIL]);
  fake = new FakeShopify();
  clock = makeClock();
  fake.now = () => clock.now();
  reports = [];
  hubCalls = [];
  hubFails = false;
  worker = makeNative();
});

const token = (over: Record<string, unknown> = {}, secret = CLIENT_SECRET) => mintIdToken(clock.now(), over, secret);
const install = async () => (await database.pool.query("SELECT * FROM shopify_installs")).rows[0];
const connections = async () => (await database.pool.query("SELECT tenant_id, tier, status, reauthorize_reason, external_account_id, account_domain, account_label, revoke_outcome FROM connections ORDER BY created_at")).rows;
const plan = async (tenantId: string) => (await database.pool.query("SELECT billing_provider, shopify_shop_id FROM tenant_plans WHERE tenant_id=$1", [tenantId])).rows[0];
const exchanges = () => fake.calls.filter((c) => c.body?.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange" && c.body.requested_token_type?.toString().includes("offline"));


/** A fetch that, once, runs `hook` after Shopify answered the next Admin GraphQL call: a race landing between a read and the write after it. */
function afterNextGraphql(hook: () => Promise<void>): typeof fetch {
  let armed = true;
  return (async (input, init) => {
    const answer = await fake.fetch(input, init);
    if (armed && String(input).endsWith("/graphql.json")) { armed = false; await hook(); }
    return answer;
  }) as typeof fetch;
}
const bumpGeneration = () => database.pool.query("UPDATE shopify_installs SET generation=generation+1").then(() => undefined);

describe("shopify_open: the plan state (C-29)", () => {
  /** Links the store to a new hub (which stores the Shopify billing row), then sets what the billing runner would have stored. */
  const storePlan = async (plan: string, status: string) => {
    await worker.open({ idToken: token() });
    expect(await worker.createHub({ idToken: token() })).toMatchObject({ outcome: "created" });
    await database.pool.query("UPDATE tenant_plans SET plan=$1, plan_interval='month', status=$2 WHERE shopify_shop_id=$3", [plan, status, SHOP_GID]);
  };

  it("is none for a store that is not linked, and for a linked one until the billing runner has stored a plan", async () => {
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "none" }, link: { state: "none" } });
    await worker.createHub({ idToken: token() });
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "none" }, link: { state: "linked" } });
  });

  it("shows no plan once the connection is disconnected, although the plan row stays", async () => {
    await storePlan("studio", "active");
    await database.pool.query("UPDATE connections SET status='disconnected', account_label=NULL");
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "none" }, link: { state: "none" } });
  });

  it("names the plan when active or past due, calls a trialing one a trial, and treats a canceled one as none", async () => {
    await storePlan("studio", "active");
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "active", name: "Studio" } });
    await database.pool.query("UPDATE tenant_plans SET status='trialing', plan='solo'");
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "trial", name: "Solo" } });
    await database.pool.query("UPDATE tenant_plans SET status='past_due', plan='pro'");
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "active", name: "Pro" } });
    await database.pool.query("UPDATE tenant_plans SET status='canceled'");
    expect(await worker.open({ idToken: token() })).toMatchObject({ plan: { state: "none" } });
  });
});

describe("shopify_open: authenticate, exchange once, store sealed (C-21, C-22)", () => {
  it("exchanges for an expiring offline token, seals it and shows 90 day and 1 hour expiries", async () => {
    const out = await worker.open({ idToken: token() });
    expect(out).toEqual({ outcome: "ok", shop: { domain: SHOP, name: "ZS Test Store" }, plan: { state: "none" }, link: { state: "none" } });
    expect(exchanges()).toHaveLength(1);
    expect(exchanges()[0]!.body).toMatchObject({ expiring: 1 });
    const row = await install();
    expect(row).toMatchObject({ shop_id: SHOP_GID, shop_domain: SHOP, status: "live", generation: "1" });
    expect(Math.round((row.refresh_expires_at.getTime() - T0) / 86_400_000)).toBe(90);
    expect(Math.round((row.access_expires_at.getTime() - T0) / 60_000)).toBe(60);
    // The columns hold sealed text, never the token.
    const [access] = [...fake.currentAccess];
    expect(JSON.stringify(row)).not.toContain(access);
    expect(row.access_sealed).toMatch(/^zss1\./);
  });
  it("a second open reads, it does not exchange again", async () => {
    await worker.open({ idToken: token() });
    await worker.open({ idToken: token() });
    expect(exchanges()).toHaveLength(1);
  });
  it("refuses a forged, wrong-audience or expired token before any request", async () => {
    for (const bad of [token({}, "x".repeat(48)), token({ aud: "other" }), token({ exp: Math.floor(T0 / 1000) - 100 }), "not-a-jwt"])
      expect(await worker.open({ idToken: bad })).toEqual({ outcome: "invalid_token" });
    expect(fake.calls).toHaveLength(0);
    expect(await install()).toBeUndefined();
  });
  it("two first opens at once make one exchange (the lease)", async () => {
    const results = await Promise.all([worker.open({ idToken: token() }), worker.open({ idToken: token() })]);
    expect(exchanges().length).toBeLessThanOrEqual(1);
    expect(results.some((r) => r.outcome === "ok")).toBe(true);
    expect(results.every((r) => r.outcome === "ok" || r.outcome === "busy")).toBe(true);
    expect((await database.pool.query("SELECT 1 FROM shopify_locks")).rowCount).toBe(0);
  });
  it("refuses a store whose answer carries no refresh token (never a non-expiring token)", async () => {
    fake.failNextToken = { status: 200, body: { access_token: "shpat_x", scope: "read_orders" } };
    expect(await worker.open({ idToken: token() })).toEqual({ outcome: "not_supported" });
    expect(await install()).toBeUndefined();
    expect(reports).toContainEqual({ kind: "non_expiring_refused", shop: SHOP });
  });
});

describe("an exchange that finishes after an uninstall does not revive the store (C-22)", () => {
  it("is refused when the row moved while Shopify was being asked", async () => {
    await worker.open({ idToken: token() });
    await database.pool.query("UPDATE shopify_installs SET status='uninstalled', access_sealed=NULL, access_key_id=NULL, refresh_sealed=NULL, refresh_key_id=NULL, access_expires_at=NULL, refresh_expires_at=NULL, uninstalled_at=now()");
    const racing = makeNative({ fetch: afterNextGraphql(bumpGeneration) });
    expect(await racing.open({ idToken: token() })).toEqual({ outcome: "unavailable" });
    expect(await install()).toMatchObject({ status: "uninstalled", access_sealed: null });
    // The merchant opens the app again: nothing moved, the exchange goes through.
    expect(await worker.open({ idToken: token() })).toMatchObject({ outcome: "ok" });
    expect((await install()).status).toBe("live");
  });
});

describe("refresh and recovery (C-22)", () => {
  it("refreshes near expiry, rotates both tokens, and survives a lost response", async () => {
    await worker.open({ idToken: token() });
    const before = await install();
    clock.ms += 56 * 60_000;
    let lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (lose && String(input).endsWith("/oauth/access_token") && JSON.parse(String(init?.body)).grant_type === "refresh_token") { lose = false; throw new Error("lost"); }
      return response;
    };
    const flaky = makeNative({ fetch: lossy });
    const first = await flaky.run({ row: { tenant_id: a.tenantId, id: randomUUID(), external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null }, tool: "shopify_list_orders", arguments: {} });
    expect(first).toEqual({ kind: "error", code: "provider_unavailable" });
    expect((await install()).refresh_sealed).toBe(before.refresh_sealed);
    const second = await flaky.run({ row: { tenant_id: a.tenantId, id: randomUUID(), external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null }, tool: "shopify_list_orders", arguments: {} });
    expect(second.kind).toBe("ok");
    const after = await install();
    expect(after.refresh_sealed).not.toBe(before.refresh_sealed);
    expect(after.access_sealed).not.toBe(before.access_sealed);
    expect(after.refresh_expires_at.getTime()).toBeGreaterThan(before.refresh_expires_at.getTime());
    // The first (lost) refresh used the stored token; the retry used it again, as Shopify allows.
    expect(fake.lastRefreshWithTokens).toHaveLength(2);
    expect(fake.lastRefreshWithTokens[0]).toBe(fake.lastRefreshWithTokens[1]);
  });
  it("two simultaneous refreshes send one refresh request: the lease keeps the other out (C-27)", async () => {
    await worker.open({ idToken: token() });
    const before = await install();
    clock.ms += 56 * 60_000;
    const row = { tenant_id: a.tenantId, id: randomUUID(), external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null } as const;
    // The refresh answers slowly, so both calls are inside it together unless the lease keeps one out.
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/oauth/access_token")) await new Promise((resolve) => setTimeout(resolve, 100));
      return fake.fetch(input, init);
    };
    const racing = makeNative({ fetch: slow });
    const results = await Promise.all([
      racing.run({ row, tool: "shopify_list_orders", arguments: {} }),
      racing.run({ row, tool: "shopify_list_orders", arguments: {} }),
    ]);
    expect(results.some((result) => result.kind === "ok")).toBe(true);
    expect(fake.lastRefreshWithTokens).toHaveLength(1);
    expect((await install()).refresh_sealed).not.toBe(before.refresh_sealed);
  });
  it("an invalid refresh token marks the install and the connection, and reopening the app restores both", async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    const [c] = await connections();
    expect(c.status).toBe("active");
    fake.currentRefresh.clear();
    clock.ms += 56 * 60_000;
    const row = { tenant_id: c.tenant_id, id: (await database.pool.query("SELECT id FROM connections")).rows[0].id, external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null };
    expect(await worker.run({ row, tool: "shopify_list_orders", arguments: {} })).toEqual({ kind: "error", code: "connection_needs_reconnect" });
    expect((await install()).status).toBe("needs_reauth");
    expect((await connections())[0]).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
    expect(await worker.open({ idToken: token() })).toMatchObject({ outcome: "ok", link: { state: "linked", connection: "active" } });
    expect((await install()).status).toBe("live");
    expect((await connections())[0]).toMatchObject({ status: "active", reauthorize_reason: null });
  });
  it("a refresh write that loses the race to an uninstall changes nothing (the generation fence)", async () => {
    await worker.open({ idToken: token() });
    clock.ms += 56 * 60_000;
    const racing: typeof fetch = async (input, init) => {
      const response = await fake.fetch(input, init);
      if (String(input).endsWith("/oauth/access_token") && JSON.parse(String(init?.body)).grant_type === "refresh_token")
        await database.pool.query("UPDATE shopify_installs SET status='uninstalled', access_sealed=NULL, access_key_id=NULL, refresh_sealed=NULL, refresh_key_id=NULL, access_expires_at=NULL, refresh_expires_at=NULL, uninstalled_at=$1, generation=generation+1", [clock.now()]);
      return response;
    };
    const out = await makeNative({ fetch: racing }).run({ row: { tenant_id: a.tenantId, id: randomUUID(), external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null }, tool: "shopify_list_orders", arguments: {} });
    expect(out.kind).toBe("error");
    expect(await install()).toMatchObject({ status: "uninstalled", access_sealed: null, refresh_sealed: null });
  });
  it("the cron pass refreshes an install whose refresh token has under 30 days left", async () => {
    await worker.open({ idToken: token() });
    clock.ms += 61 * 86_400_000;
    fake.expiresIn = 3600;
    const out = await worker.pass({ deadline: clock.ms + 20_000 });
    expect(out.refreshed).toBe(1);
  });
});

describe("shopify_create_hub: a new tenant with no operator (C-21)", () => {
  it("binds the store to a new tenant with billing_provider shopify, only for the verified account owner", async () => {
    await worker.open({ idToken: token() });
    fake.accountOwner = false;
    expect(await worker.createHub({ idToken: token() })).toEqual({ outcome: "not_owner" });
    fake.accountOwner = true;
    fake.emailVerified = false;
    expect(await worker.createHub({ idToken: token() })).toEqual({ outcome: "not_owner" });
    expect(hubCalls).toHaveLength(0);
    fake.emailVerified = true;
    const out = await worker.createHub({ idToken: token() });
    expect(out).toEqual({ outcome: "created", businessName: "ZS Test Store", ownerEmail: OWNER_EMAIL });
    const [row] = await connections();
    expect(row).toMatchObject({ tier: "native", status: "active", external_account_id: SHOP_GID, account_domain: SHOP, account_label: "ZS Test Store" });
    expect(await plan(row.tenant_id)).toEqual({ billing_provider: "shopify", shopify_shop_id: SHOP_GID });
    expect(await worker.open({ idToken: token() })).toMatchObject({ link: { state: "linked", businessName: "ZS Test Store", connection: "active" } });
    expect(await worker.createHub({ idToken: token() })).toEqual({ outcome: "already_linked" });
  });
  it("a retry after a failed provisioning step finishes the same tenant (store-keyed recovery)", async () => {
    await worker.open({ idToken: token() });
    hubFails = true;
    expect(await worker.createHub({ idToken: token() })).toEqual({ outcome: "unavailable" });
    expect(await connections()).toHaveLength(0);
    hubFails = false;
    expect(await worker.createHub({ idToken: token() })).toMatchObject({ outcome: "created" });
    expect(hubCalls).toEqual(["shopify-9001", "shopify-9001"]);
    expect(await connections()).toHaveLength(1);
  });
  it("answers email_has_hub when the owner's email already belongs to a hub, leaving the claim flow", async () => {
    await database.pool.query("INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) VALUES ($1,$2,$3,'owner',$4,$4)", [a.tenantId, randomUUID(), OWNER_EMAIL, new Date(T0)]);
    await worker.open({ idToken: token() });
    expect(await worker.createHub({ idToken: token() })).toEqual({ outcome: "email_has_hub" });
    expect(await connections()).toHaveLength(0);
    await database.pool.query("DELETE FROM tenant_members WHERE lower(email)=$1", [OWNER_EMAIL]);
  });
  it("gives the verified owner a sign-in link, nobody else", async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    expect(await worker.signIn({ idToken: token() })).toEqual({ outcome: "ok", url: `https://hub.example.test/sign-in?e=${encodeURIComponent(OWNER_EMAIL)}` });
    fake.accountOwner = false;
    expect(await worker.signIn({ idToken: token() })).toEqual({ outcome: "not_owner" });
    fake.accountOwner = true;
    fake.email = "someone-else@example.com";
    expect(await worker.signIn({ idToken: token() })).toEqual({ outcome: "not_available" });
  });
  it("gives the sign-in link while the connection needs reconnecting too (the page offers Open ZS Hub then)", async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    await database.pool.query("UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error'");
    expect(await worker.signIn({ idToken: token() })).toMatchObject({ outcome: "ok" });
  });
  it("a returning owner takes the store back into the hub that billed it", async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    await database.pool.query("UPDATE connections SET status='disconnected', account_label=NULL");
    const out = await worker.createHub({ idToken: token() });
    expect(out).toMatchObject({ outcome: "relinked" });
    expect((await connections()).filter((c) => c.status === "active")).toHaveLength(1);
    const active = (await connections()).find((c) => c.status === "active")!;
    expect(await plan(active.tenant_id)).toEqual({ billing_provider: "shopify", shopify_shop_id: SHOP_GID });
  });
});

describe("claims: an existing hub links a store only with the owner's confirm (C-21)", () => {
  const redeem = (code: string) => worker.redeemClaim({ idToken: token(), code });
  beforeEach(async () => { await worker.open({ idToken: token() }); });

  it("runs the three steps; a leaked code alone binds nothing", async () => {
    const started = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (started.outcome !== "started") throw new Error("claim");
    expect(started.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect((await database.pool.query("SELECT code_hash FROM shopify_claims")).rows[0].code_hash).not.toContain(started.code);
    expect(await redeem(started.code)).toMatchObject({ outcome: "redeemed" });
    // Redeemed, not bound: the owner has not confirmed.
    expect(await connections()).toHaveLength(0);
    expect(await worker.claimStatus({ tenantId: a.tenantId })).toMatchObject({ id: started.claimId, status: "redeemed", shop: { domain: SHOP, name: "ZS Test Store" } });
    expect(await worker.claimConfirm({ tenantId: a.tenantId, claimId: started.claimId, memberId: a.memberId })).toMatchObject({ outcome: "confirmed" });
    expect((await connections())[0]).toMatchObject({ tenant_id: a.tenantId, tier: "native", status: "active" });
    expect(await plan(a.tenantId)).toEqual({ billing_provider: "shopify", shopify_shop_id: SHOP_GID });
    expect(await worker.claimStatus({ tenantId: a.tenantId })).toBeNull();
  });
  it("five wrong codes lock redeeming for an hour, then it opens again", async () => {
    const started = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (started.outcome !== "started") throw new Error("claim");
    for (let i = 0; i < 5; i += 1) expect(await redeem("WRONGCODE" + i)).toEqual({ outcome: "invalid_code" });
    expect(await redeem(started.code)).toMatchObject({ outcome: "locked" });
    clock.ms += 61 * 60_000 - 15 * 60_000 + 15 * 60_000;
    // The claim itself expired meanwhile (15 minutes): a new code is needed.
    expect(await redeem(started.code)).toEqual({ outcome: "invalid_code" });
  });
  it("five wrong codes sent at once all count: the sixth is locked out (no lost increments)", async () => {
    const started = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (started.outcome !== "started") throw new Error("claim");
    const wrong = await Promise.all(Array.from({ length: 5 }, (_, i) => redeem("WRONGCODE" + i)));
    expect(wrong.every((r) => r.outcome === "invalid_code" || r.outcome === "locked")).toBe(true);
    expect((await install()).claim_locked_until).not.toBeNull();
    expect(await redeem(started.code)).toMatchObject({ outcome: "locked" });
  });
  it("a non-owner cannot redeem; an expired claim cannot be confirmed; one open claim per tenant", async () => {
    const first = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (first.outcome !== "started") throw new Error("claim");
    fake.accountOwner = false;
    expect(await redeem(first.code)).toEqual({ outcome: "not_owner" });
    fake.accountOwner = true;
    const second = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (second.outcome !== "started") throw new Error("claim");
    expect((await database.pool.query("SELECT id FROM shopify_claims WHERE status IN ('open','redeemed')")).rowCount).toBe(1);
    expect(await redeem(first.code)).toEqual({ outcome: "invalid_code" });
    expect(await redeem(second.code)).toMatchObject({ outcome: "redeemed" });
    clock.ms += 16 * 60_000;
    expect(await worker.claimConfirm({ tenantId: a.tenantId, claimId: second.claimId, memberId: a.memberId })).toEqual({ outcome: "expired" });
    expect(await connections()).toHaveLength(0);
  });
  it("tenant B cannot confirm or cancel tenant A's claim", async () => {
    const started = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (started.outcome !== "started") throw new Error("claim");
    await redeem(started.code);
    expect(await worker.claimConfirm({ tenantId: b.tenantId, claimId: started.claimId, memberId: b.memberId })).toEqual({ outcome: "not_found" });
    expect(await worker.claimCancel({ tenantId: b.tenantId, claimId: started.claimId })).toEqual({ outcome: "not_found" });
    expect(await worker.claimStatus({ tenantId: b.tenantId })).toBeNull();
    expect(await connections()).toHaveLength(0);
  });
  it("two tenants confirming claims for one store end with exactly one binding", async () => {
    const one = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    const two = await worker.claimStart({ tenantId: b.tenantId, memberId: b.memberId });
    if (one.outcome !== "started" || two.outcome !== "started") throw new Error("claim");
    await redeem(one.code);
    await redeem(two.code);
    const results = await Promise.all([
      worker.claimConfirm({ tenantId: a.tenantId, claimId: one.claimId, memberId: a.memberId }),
      worker.claimConfirm({ tenantId: b.tenantId, claimId: two.claimId, memberId: b.memberId }),
    ]);
    expect(results.filter((r) => r.outcome === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "store_in_use")).toHaveLength(1);
    expect((await connections()).filter((c) => c.status === "active")).toHaveLength(1);
  });
  it("rolls back whole on a billing conflict and keeps the claim retryable (the billing guards stand)", async () => {
    // A tenant with an open Stripe checkout cannot take a Shopify plan (setShopifyBilling's guard).
    await database.pool.query(
      `INSERT INTO plan_checkouts (tenant_id, id, plan, plan_interval, status, created_by, created_at, updated_at)
       VALUES ($1,$2,'solo','month','pending',$3,$4,$4)`, [a.tenantId, randomUUID(), a.memberId, new Date(T0)]);
    const started = await worker.claimStart({ tenantId: a.tenantId, memberId: a.memberId });
    if (started.outcome !== "started") throw new Error("claim");
    await redeem(started.code);
    const out = await worker.claimConfirm({ tenantId: a.tenantId, claimId: started.claimId, memberId: a.memberId });
    expect(out).toEqual({ outcome: "billing_conflict", reason: "stripe_plan_active" });
    expect(await connections()).toHaveLength(0);
    expect(await plan(a.tenantId)).toBeUndefined();
    expect(await worker.claimStatus({ tenantId: a.tenantId })).toMatchObject({ status: "redeemed" });
    // Once the checkout closes, the same claim confirms.
    await database.pool.query("UPDATE plan_checkouts SET status='expired'");
    expect(await worker.claimConfirm({ tenantId: a.tenantId, claimId: started.claimId, memberId: a.memberId })).toMatchObject({ outcome: "confirmed" });
    await database.pool.query("DELETE FROM plan_checkouts");
  });
});

describe("webhooks (C-24)", () => {
  const send = (topic: string, body: object, over: { hmac?: string | null; shop?: string | null; id?: string | null } = {}) => {
    const raw = JSON.stringify(body);
    return worker.webhook({
      rawBody: Buffer.from(raw), hmac: over.hmac === undefined ? signWebhook(raw) : over.hmac, topic,
      shopDomain: over.shop === undefined ? SHOP : over.shop, webhookId: over.id === undefined ? randomUUID() : over.id,
    });
  };
  const uninstallBody = { id: 9001, myshopify_domain: SHOP, domain: "shop.example.com" };
  const redactBody = { shop_id: 9001, shop_domain: SHOP };
  beforeEach(async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
  });

  it("answers 401 to a bad signature, a missing header, or a body that names another shop", async () => {
    expect((await send("app/uninstalled", uninstallBody, { hmac: signWebhook("{}") })).status).toBe(401);
    expect((await send("app/uninstalled", uninstallBody, { hmac: null })).status).toBe(401);
    expect((await send("app/uninstalled", uninstallBody, { id: null })).status).toBe(401);
    expect((await send("app/uninstalled", { ...uninstallBody, myshopify_domain: "other.myshopify.com" })).status).toBe(401);
    expect((await send("shop/redact", { shop_id: 1, shop_domain: "other.myshopify.com" })).status).toBe(401);
    expect((await connections())[0]!.status).toBe("active");
    expect((await install()).status).toBe("live");
  });
  it("uninstall wipes the tokens and disconnects the connection; a repeat does nothing more", async () => {
    fake.uninstalled = true; // Shopify revoked the token
    const id = randomUUID();
    expect((await send("app/uninstalled", uninstallBody, { id })).status).toBe(200);
    expect(await install()).toMatchObject({ status: "uninstalled", access_sealed: null, refresh_sealed: null, access_key_id: null, refresh_key_id: null });
    expect((await connections())[0]).toMatchObject({ status: "disconnected", account_label: null, revoke_outcome: "revoked" });
    expect((await send("app/uninstalled", uninstallBody, { id })).status).toBe(200);
  });
  it("drops an uninstall delayed behind a reinstall: Shopify says the credentials still work", async () => {
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(200);
    expect((await install()).status).toBe("live");
    expect((await connections())[0]!.status).toBe("active");
    expect(reports).toContainEqual({ kind: "delayed_uninstall_dropped", shop: SHOP });
  });
  it("asks for a retry (500) when Shopify cannot be asked", async () => {
    fake.failGraphql = { status: 503 };
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(500);
    expect((await install()).status).toBe("live");
  });
  it("logs the topic, the shop, our status code and the time taken, and no body or header (C-24)", async () => {
    const slow: typeof fetch = async (input, init) => { clock.ms += 250; return fake.fetch(input, init); };
    worker = makeNative({ fetch: slow });
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(200);
    const event = reports.find((report) => report.kind === "webhook");
    expect(event).toEqual({ kind: "webhook", topic: "app/uninstalled", shop: SHOP, status: 200, ms: 250 });
  });
  it("counts a 403 from the shop probe as live, so a misconfigured IP allowlist uninstalls and redacts nothing (C-28)", async () => {
    fake.failGraphql = { status: 403 };
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(200);
    expect((await install()).status).toBe("live");
    expect((await connections())[0]!.status).toBe("active");
    expect(reports).toContainEqual({ kind: "delayed_uninstall_dropped", shop: SHOP });
    expect((await send("shop/redact", redactBody)).status).toBe(200);
    expect((await install()).status).toBe("live");
    expect((await connections())[0]).toMatchObject({ status: "active", account_domain: SHOP });
  });
  it("records customers/data_request and customers/redact and answers 200 (the hub holds no customer data)", async () => {
    expect((await send("customers/data_request", { shop_id: 9001, shop_domain: SHOP, customer: { id: 1 } })).status).toBe(200);
    expect((await send("customers/redact", { shop_id: 9001, shop_domain: SHOP, customer: { id: 1 } })).status).toBe(200);
    expect((await database.pool.query("SELECT topic FROM shopify_webhook_events ORDER BY topic")).rows.map((r) => r.topic)).toEqual(["customers/data_request", "customers/redact"]);
    expect((await connections())[0]!.status).toBe("active");
  });
  it("shop/redact deletes the install, claims and events and blanks the connection's store; a live shop is not redacted", async () => {
    expect((await send("shop/redact", redactBody)).status).toBe(200);
    expect((await install()).status).toBe("live");
    expect((await connections())[0]).toMatchObject({ status: "active", account_domain: SHOP });
    fake.uninstalled = true;
    const id = randomUUID();
    expect((await send("shop/redact", redactBody, { id })).status).toBe(200);
    expect(await install()).toBeUndefined();
    expect((await connections())[0]).toMatchObject({ status: "disconnected", account_domain: "redacted.invalid", external_account_id: "redacted", account_label: null });
    expect((await database.pool.query("SELECT webhook_id FROM shopify_webhook_events")).rows.map((r) => r.webhook_id)).toEqual([id]);
    expect((await send("shop/redact", redactBody, { id })).status).toBe(200);
  });
  it("shop/redact leaves a store that reinstalled between the probe and the delete alone", async () => {
    fake.uninstalled = true;
    worker = makeNative({ fetch: afterNextGraphql(bumpGeneration) });
    expect((await send("shop/redact", redactBody)).status).toBe(200);
    expect(await install()).toMatchObject({ shop_id: SHOP_GID });
    expect((await connections())[0]).toMatchObject({ status: "active", account_domain: SHOP });
    expect(reports).toContainEqual({ kind: "redact_skipped_reinstall", shop: SHOP });
  });
  it("an uninstall that lost the race to a reinstall changes nothing: the connection stays active", async () => {
    fake.uninstalled = true;
    worker = makeNative({ fetch: afterNextGraphql(bumpGeneration) });
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(200);
    expect((await install()).status).toBe("live");
    expect((await connections())[0]!.status).toBe("active");
    expect(reports.some((r) => r.kind === "uninstalled")).toBe(false);
  });
  it("a delivery already handled is acknowledged without asking Shopify again", async () => {
    const id = randomUUID();
    fake.uninstalled = true;
    expect((await send("app/uninstalled", uninstallBody, { id })).status).toBe(200);
    const before = fake.calls.length;
    expect((await send("app/uninstalled", uninstallBody, { id })).status).toBe(200);
    expect(fake.calls.length).toBe(before);
  });
  it("answers 401 to a shop/redact body that names a customer (the topic header is not signed)", async () => {
    const id = "wh-relabelled";
    expect((await send("shop/redact", { ...redactBody, customer: { id: 1 }, orders_to_redact: [1] }, { id })).status).toBe(401);
    expect((await install()).status).toBe("live");
  });
  it("answers 401 to a compliance payload without a numeric shop id or with another shop's id", async () => {
    expect((await send("shop/redact", { shop_domain: SHOP })).status).toBe(401);
    expect((await send("shop/redact", { shop_id: "abc", shop_domain: SHOP })).status).toBe(401);
    expect((await send("customers/redact", { shop_id: 1234, shop_domain: SHOP })).status).toBe(401);
    expect((await install()).status).toBe("live");
  });
  it("a redact leaves no shop name in the dedupe ledger", async () => {
    fake.uninstalled = true;
    const id = randomUUID();
    expect((await send("shop/redact", redactBody, { id })).status).toBe(200);
    expect((await database.pool.query("SELECT shop_domain FROM shopify_webhook_events WHERE webhook_id=$1", [id])).rows[0].shop_domain).toBe("redacted.myshopify.com");
    expect((await database.pool.query("SELECT 1 FROM shopify_webhook_events WHERE shop_domain=$1", [SHOP])).rowCount).toBe(0);
  });
  describe("a shop/redact also anonymises the action history of that shop's connections", () => {
    const OTHER_SHOP = "other-store.myshopify.com";
    const OTHER_GID = "gid://shopify/Shop/777";
    const NAME = "ZS Test Store";
    const shopCopies = (value: unknown) => ({ accountDomain: SHOP, accountLabel: NAME, externalAccountId: SHOP_GID, note: `store ${SHOP} (${SHOP_GID})`, value });
    async function seedAction(tenantId: string, actorId: string, connectionId: string, type: string, payload: object, result: object, withEvent: object | null) {
      const actionId = randomUUID();
      await asService(database.servicePool, async (tx) => {
        await tx.query(
          "INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [tenantId, actionId, actorId, type, JSON.stringify({ tenantId, type: "connection", id: connectionId }), JSON.stringify(payload), `k-${actionId}`, JSON.stringify(result), new Date(T0)]);
        if (withEvent) await tx.query("INSERT INTO outbox (tenant_id,id,action_id,event_type,payload,created_at) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, randomUUID(), actionId, "connection.disconnect_requested", JSON.stringify(withEvent), new Date(T0)]);
      });
      return actionId;
    }
    const connection = (domain: string, label: string | null, id: string) => ({ id, toolkit: "shopify", accountLabel: label, accountDomain: domain, status: "active", reauthorizeReason: null, revokeFailed: false, readBlocked: false, lastCheckedAt: "2026-11-07T00:00:00.000Z", createdAt: "2026-11-07T00:00:00.000Z" });
    /** Every table that can hold a store's identity, as text, for one tenant (or all rows when the tenant is omitted). */
    async function leaks(needles: string[]) {
      const found: string[] = [];
      for (const table of ["actions", "outbox", "connections", "shopify_installs", "shopify_claims", "shopify_webhook_events", "shopify_locks"]) {
        for (const needle of needles) {
          const { rowCount } = await database.pool.query(`SELECT 1 FROM ${table} t WHERE row_to_json(t)::text LIKE $1`, [`%${needle}%`]);
          if (rowCount) found.push(`${table}:${needle}`);
        }
      }
      return found;
    }

    it("keeps the history rows, replaces the shop domain, name and id in result, payload and event, and leaves other shops and tenants alone", async () => {
      const bound = (await connections())[0]!;
      const connectionId = (await database.pool.query<{ id: string }>("SELECT id FROM connections WHERE external_account_id=$1", [SHOP_GID])).rows[0]!.id;
      // Tenant B: a different store whose connection has the SAME connection id (ids are per tenant), so only tenant scoping can tell them apart.
      await asService(database.servicePool, (tx) => tx.query(
        `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
         VALUES ($1,$2,'native','shopify',$3,$4,'Other Store','active',$5,$6,$6,$6)`, [b.tenantId, connectionId, OTHER_GID, OTHER_SHOP, b.memberId, new Date(T0)]));
      const connect = await seedAction(bound.tenant_id, a.userId, connectionId, "connection.connect",
        { connectionId, toolkit: "shopify", externalAccountId: SHOP_GID, accountDomain: SHOP, accountLabel: NAME }, connection(SHOP, NAME, connectionId), null);
      const disconnect = await seedAction(bound.tenant_id, a.userId, connectionId, "connection.disconnect",
        { connectionId }, { ...connection(SHOP, NAME, connectionId), status: "disconnecting", extra: shopCopies(1) }, { connectionId, toolkit: "shopify", store: SHOP, name: NAME });
      await database.pool.query("UPDATE actions SET idempotency_key=$2 WHERE id=$1", [disconnect, `disconnect:${SHOP}`]);
      await database.pool.query("INSERT INTO shopify_locks (shop_domain, held_until, holder) VALUES ($1,$2,$3)", [SHOP, new Date(T0 - 1000), randomUUID()]);
      const bAction = await seedAction(b.tenantId, b.userId, connectionId, "connection.disconnect",
        { connectionId }, connection(OTHER_SHOP, "Other Store", connectionId), { connectionId, toolkit: "shopify" });
      const bBefore = (await database.pool.query("SELECT payload, result FROM actions WHERE id=$1", [bAction])).rows[0];
      expect(await leaks([SHOP, NAME, SHOP_GID, "9001"])).toEqual(expect.arrayContaining(["actions:" + SHOP, "outbox:" + SHOP]));

      fake.uninstalled = true;
      expect((await send("shop/redact", redactBody)).status).toBe(200);

      expect(await leaks([SHOP, NAME, SHOP_GID, "Shop/9001"])).toEqual([]);
      const kept = (await database.pool.query("SELECT id, payload, result FROM actions WHERE tenant_id=$1 ORDER BY created_at, id", [bound.tenant_id])).rows;
      expect(kept.map((r) => r.id).sort()).toEqual([connect, disconnect].sort());
      const byId = Object.fromEntries(kept.map((r) => [r.id, r]));
      expect(byId[connect].payload).toMatchObject({ connectionId, toolkit: "shopify", accountDomain: "redacted.invalid", externalAccountId: "redacted", accountLabel: null });
      expect(byId[connect].result).toMatchObject({ id: connectionId, accountDomain: "redacted.invalid", accountLabel: null, status: "active" });
      expect(byId[disconnect].result).toMatchObject({ status: "disconnecting", accountDomain: "redacted.invalid", accountLabel: null });
      expect((await database.pool.query("SELECT id, idempotency_key FROM actions WHERE id=$1", [disconnect])).rows[0]).toEqual({ id: disconnect, idempotency_key: `redacted:${disconnect}` });
      expect(byId[connect].idempotency_key ?? (await database.pool.query("SELECT idempotency_key FROM actions WHERE id=$1", [connect])).rows[0].idempotency_key).toBe(`k-${connect}`);
      expect(byId[disconnect].result.extra.note).toBe("store redacted.invalid (redacted)");
      expect((await database.pool.query("SELECT payload FROM outbox WHERE action_id=$1", [disconnect])).rows[0].payload).toEqual({ connectionId, toolkit: "shopify", store: "redacted.invalid", name: "redacted" });
      // Tenant B's other shop: rows and connection untouched, byte for byte.
      expect((await database.pool.query("SELECT payload, result FROM actions WHERE id=$1", [bAction])).rows[0]).toEqual(bBefore);
      expect((await database.pool.query("SELECT payload FROM outbox WHERE action_id=$1", [bAction])).rows[0].payload).toEqual({ connectionId, toolkit: "shopify" });
      expect((await database.pool.query("SELECT account_domain, account_label, external_account_id FROM connections WHERE tenant_id=$1", [b.tenantId])).rows[0])
        .toEqual({ account_domain: OTHER_SHOP, account_label: "Other Store", external_account_id: OTHER_GID });
      // A repeat is harmless.
      expect((await send("shop/redact", redactBody)).status).toBe(200);
      expect(await leaks([SHOP, NAME, SHOP_GID])).toEqual([]);
    });
    it("a redact that raced a delete and a reinstall (same generation, new incarnation) leaves the fresh install and its history alone", async () => {
      const connectionId = (await database.pool.query<{ id: string }>("SELECT id FROM connections WHERE external_account_id=$1", [SHOP_GID])).rows[0]!.id;
      const tenantId = (await connections())[0]!.tenant_id;
      const id = await seedAction(tenantId, a.userId, connectionId, "connection.connect", { accountDomain: SHOP }, connection(SHOP, NAME, connectionId), null);
      fake.uninstalled = true;
      // Between the probe and the lock another redact deleted the install and a reinstall recreated it at generation 1.
      worker = makeNative({ fetch: afterNextGraphql(async () => {
        await database.pool.query("UPDATE shopify_installs SET created_at=created_at + interval '1 minute'");
      }) });
      expect((await send("shop/redact", redactBody)).status).toBe(200);
      expect(await install()).toMatchObject({ shop_id: SHOP_GID });
      expect((await database.pool.query("SELECT payload FROM actions WHERE id=$1", [id])).rows[0].payload).toEqual({ accountDomain: SHOP });
      expect(reports).toContainEqual({ kind: "redact_skipped_reinstall", shop: SHOP });
    });
    it("a live shop's history is not touched (the redact is skipped)", async () => {
      const connectionId = (await database.pool.query<{ id: string }>("SELECT id FROM connections WHERE external_account_id=$1", [SHOP_GID])).rows[0]!.id;
      const tenantId = (await connections())[0]!.tenant_id;
      const id = await seedAction(tenantId, a.userId, connectionId, "connection.connect", { accountDomain: SHOP }, connection(SHOP, NAME, connectionId), null);
      expect((await send("shop/redact", redactBody)).status).toBe(200);
      expect((await database.pool.query("SELECT payload FROM actions WHERE id=$1", [id])).rows[0].payload).toEqual({ accountDomain: SHOP });
    });
  });
  it("answers 500 inside Shopify's 5 s limit when Shopify is slow, and Shopify retries", async () => {
    const slow = (async (input, init) => {
      if (!String(input).endsWith("/graphql.json")) return fake.fetch(input, init);
      await new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("never")), 30_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); });
      });
      return fake.fetch(input, init);
    }) as typeof fetch;
    worker = createShopifyNativeWorker({
      service: (work) => asService(database.servicePool, work),
      client: createShopifyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: "2026-10", fetch: slow, timeoutMs: 6000 }),
      clock, config: { clientId: CLIENT_ID, secrets: { current: CLIENT_SECRET }, sealKeys: parseSealKeys({ current: KEY_A, currentId: "k1" }), graceDays: 7 },
      hub: fakeHub(), newId: randomUUID, report: (event) => reports.push(event),
    });
    const started = Date.now();
    expect((await send("app/uninstalled", uninstallBody)).status).toBe(500);
    expect(Date.now() - started).toBeLessThan(4800);
    expect((await install()).status).toBe("live");
  }, 15_000);
  it("an unknown topic is 200 and ignored", async () => {
    expect((await send("orders/create", { id: 1 })).status).toBe(200);
  });
});

describe("native reads and disconnect (C-13, C-23)", () => {
  let connectionId: string;
  const row = () => ({ tenant_id: "", id: connectionId, external_account_id: SHOP_GID, account_domain: SHOP, status: "active", last_error_code: null, revoke_outcome: null as null });
  beforeEach(async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    const c = (await database.pool.query("SELECT tenant_id, id FROM connections")).rows[0];
    connectionId = c.id;
    (row as unknown as { tenantId: string }).tenantId = c.tenant_id;
  });
  const input = async (tool: string, args: Record<string, unknown> = {}) => ({ row: { ...row(), tenant_id: (await database.pool.query("SELECT tenant_id FROM connections")).rows[0].tenant_id }, tool, arguments: args });

  it("lists orders over GraphQL without the customer object", async () => {
    fake.orders = [{ id: 1001, name: "#1001", created_at: "2026-11-01T10:00:00Z", customerId: 55 }];
    const out = await worker.run(await input("shopify_list_orders"));
    expect(out).toMatchObject({ kind: "ok", projected: { orders: [{ id: "1001" }] } });
    const call = fake.calls.filter((c) => c.url.endsWith("/graphql.json")).at(-1)!;
    expect(String(call.body?.query)).not.toMatch(/customer|email|firstName|lastName/i);
  });
  it("keeps a list of 50 within Shopify's 1,000-point query cost by cutting the line-item page, and reads one order with 50", async () => {
    fake.orders = [{ id: 1001, name: "#1001", created_at: "2026-11-01T10:00:00Z", lineItems: 8 }];
    const listed = await worker.run(await input("shopify_list_orders", { limit: 50 }));
    expect(listed).toMatchObject({ kind: "ok", projected: { orders: [{ id: "1001" }] } });
    expect(fake.costs.at(-1)).toBeLessThanOrEqual(1000);
    expect((listed as { projected: { orders: Array<{ line_items: unknown[] }> } }).projected.orders[0]!.line_items).toHaveLength(3);
    const few = await worker.run(await input("shopify_list_orders", { limit: 5 }));
    expect((few as { projected: { orders: Array<{ line_items: unknown[] }> } }).projected.orders[0]!.line_items).toHaveLength(8);
    const one = await worker.run(await input("shopify_get_order", { orderId: "1001" }));
    expect(one).toMatchObject({ kind: "ok", projected: { id: "1001" } });
    expect((one as { projected: { line_items: unknown[] } }).projected.line_items).toHaveLength(8);
    expect(fake.costs.every((cost) => cost <= 1000)).toBe(true);
  });
  it("tells a revoked token (reauthorize) from a permission failure (stays active) and a throttle", async () => {
    fake.failGraphql = { status: 403 };
    expect(await worker.run(await input("shopify_list_orders"))).toEqual({ kind: "error", code: "provider_permission_denied" });
    expect((await connections())[0]).toMatchObject({ status: "active" });
    fake.failGraphql = { status: 429 };
    expect(await worker.run(await input("shopify_list_orders"))).toMatchObject({ kind: "error", code: "provider_rate_limited" });
    fake.failGraphql = null;
    fake.uninstalled = true;
    expect(await worker.run(await input("shopify_list_orders"))).toEqual({ kind: "error", code: "connection_needs_reconnect" });
    expect((await connections())[0]).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });
  it("a 401 for a token that was rotated meanwhile does not flip the connection to reauthorize", async () => {
    fake.failGraphql = { status: 401 };
    const stale = makeNative({ fetch: afterNextGraphql(bumpGeneration) });
    expect(await stale.run(await input("shopify_list_orders"))).toEqual({ kind: "error", code: "provider_unavailable" });
    expect((await connections())[0]).toMatchObject({ status: "active" });
    expect((await install()).status).toBe("live");
  });
  it("disconnect uninstalls the app with the stored token, wipes the tokens and ends the row", async () => {
    await database.pool.query("UPDATE connections SET status='disconnecting'");
    const out = await worker.finishDisconnect(await input("x").then((i) => i.row));
    expect(out).toBe("disconnected");
    expect(fake.uninstalled).toBe(true);
    expect(await install()).toMatchObject({ status: "uninstalled", access_sealed: null });
    expect((await connections())[0]).toMatchObject({ status: "disconnected", account_label: null, revoke_outcome: "revoked" });
  });
  it("disconnect stays pending while Shopify is unreachable and finishes later", async () => {
    await database.pool.query("UPDATE connections SET status='disconnecting'");
    fake.failGraphql = { status: 503 };
    expect(await worker.finishDisconnect(await input("x").then((i) => i.row))).toBe("pending");
    fake.failGraphql = null;
    expect(await worker.finishDisconnect(await input("x").then((i) => i.row))).toBe("disconnected");
  });
});

describe("shopify_orders: recent orders for the embedded page (C-30)", () => {
  const DAY = 86_400_000;
  const iso = (daysAgo: number) => new Date(clock.now().getTime() - daysAgo * DAY).toISOString();
  const lastQuery = () => fake.calls.filter((c) => c.url.endsWith("/graphql.json")).at(-1)!.body as { query: string; variables: { first: number; query: string } };
  const link = async () => { await worker.open({ idToken: token() }); await worker.createHub({ idToken: token() }); };

  it("answers not_linked with no Shopify call at all for a store that was never opened", async () => {
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "not_linked" });
    expect(fake.calls).toHaveLength(0);
    expect(await install()).toBeUndefined();
  });

  it("answers not_linked with no Shopify call for an installed store without a hub, even with its token near the end", async () => {
    await worker.open({ idToken: token() });
    const before = await install();
    clock.ms += 56 * 60_000;
    const seen = fake.calls.length;
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "not_linked" });
    expect(fake.calls).toHaveLength(seen);
    expect((await install()).access_sealed).toBe(before.access_sealed);
  });

  it("answers not_linked with no Shopify call after a disconnect, and stores no token again", async () => {
    await link();
    const connectionId = (await database.pool.query("SELECT tenant_id, id FROM connections")).rows[0];
    await database.pool.query("UPDATE connections SET status='disconnecting'");
    const row = { tenant_id: connectionId.tenant_id, id: connectionId.id, external_account_id: SHOP_GID, account_domain: SHOP, status: "disconnecting", last_error_code: null, revoke_outcome: null };
    expect(await worker.finishDisconnect(row)).toBe("disconnected");
    const seen = fake.calls.length;
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "not_linked" });
    clock.ms += 56 * 60_000;
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "not_linked" });
    expect(fake.calls).toHaveLength(seen);
    expect(await install()).toMatchObject({ status: "uninstalled", access_sealed: null, refresh_sealed: null });
  });

  it("for a linked store gets the access token once and makes one Shopify call", async () => {
    await link();
    const seen = fake.calls.length;
    expect(await worker.orders({ idToken: token() })).toMatchObject({ outcome: "ok" });
    expect(fake.calls.slice(seen).map((c) => c.url.split("/").at(-1))).toEqual(["graphql.json"]);
  });

  it("hands the caller's abort signal to the worker through the route handler and the local port", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const stub = { orders: async (_input: { idToken: string }, signal?: AbortSignal) => { seen.push(signal); return { outcome: "not_linked" as const }; } } as unknown as ShopifyWorkerOps;
    const controller = new AbortController();
    expect(await handleShopifyOperation(stub, "orders", JSON.stringify({ idToken: "aaaa.bbbb.cccc" }), controller.signal)).toEqual({ status: 200, body: { outcome: "not_linked" } });
    expect(await createLocalShopifyPort(stub).orders({ idToken: "aaaa.bbbb.cccc" }, controller.signal)).toEqual({ outcome: "not_linked" });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it("aborts the real Shopify call when the caller's signal fires, and answers unavailable", async () => {
    await link();
    fake.hangGraphql = true;
    const controller = new AbortController();
    const pending = worker.orders({ idToken: token() }, controller.signal);
    const graphqlCalls = () => fake.calls.filter((c) => c.url.endsWith("/graphql.json")).length;
    const before = graphqlCalls();
    for (let i = 0; i < 200 && graphqlCalls() === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(graphqlCalls()).toBe(before + 1);
    controller.abort();
    expect(await pending).toEqual({ outcome: "unavailable" });
  });

  it("asks Shopify only for the fields the table shows, well within the single-query cost limit", async () => {
    await link();
    fake.orders = [{ id: 1, name: "#1", created_at: iso(1), lineItems: 3 }];
    await worker.orders({ idToken: token() });
    const q = lastQuery().query;
    expect(q).not.toMatch(/lineItems|title|legacyResourceId|\bid\b|customer/);
    expect(fake.costs.at(-1)).toBe(152);
  });

  it("answers not_linked, not the orders, when a disconnect commits while Shopify answers", async () => {
    await link();
    fake.orders = [{ id: 1, name: "#1", created_at: iso(1) }];
    const raced = makeNative({ fetch: afterNextGraphql(() => database.pool.query("UPDATE connections SET status='disconnected', account_label=NULL").then(() => undefined)) });
    expect(await raced.orders({ idToken: token() })).toEqual({ outcome: "not_linked" });
  });

  it("gives each store only its own orders, and a third store without a hub not_linked", async () => {
    const OTHER = "other-store.myshopify.com";
    const THIRD = "third-store.myshopify.com";
    fake.otherShops = { [OTHER]: { gid: "gid://shopify/Shop/9002", name: "Other Store" }, [THIRD]: { gid: "gid://shopify/Shop/9003", name: "Third Store" } };
    fake.orders = [{ id: 1, name: "#A-1", created_at: iso(1) }];
    fake.ordersByShop = { [OTHER]: [{ id: 2, name: "#B-1", created_at: iso(1) }], [THIRD]: [{ id: 3, name: "#C-1", created_at: iso(1) }] };
    const other = () => mintIdToken(clock.now(), {}, CLIENT_SECRET, OTHER);
    const third = () => mintIdToken(clock.now(), {}, CLIENT_SECRET, THIRD);
    try {
      await link();
      fake.email = "owner-b@example.com";
      await worker.open({ idToken: other() });
      expect(await worker.createHub({ idToken: other() })).toMatchObject({ outcome: "created" });
      await worker.open({ idToken: third() });
      const mine = await worker.orders({ idToken: token() });
      const theirs = await worker.orders({ idToken: other() });
      expect(mine).toMatchObject({ outcome: "ok", summary: { count: 1 } });
      expect(theirs).toMatchObject({ outcome: "ok", summary: { count: 1 } });
      if (mine.outcome !== "ok" || theirs.outcome !== "ok") throw new Error("unreachable");
      expect(mine.orders.map((o) => o.name)).toEqual(["#A-1"]);
      expect(theirs.orders.map((o) => o.name)).toEqual(["#B-1"]);
      const seen = fake.calls.length;
      expect(await worker.orders({ idToken: third() })).toEqual({ outcome: "not_linked" });
      expect(fake.calls).toHaveLength(seen);
    } finally {
      await database.pool.query("DELETE FROM connections");
      await database.pool.query("DELETE FROM tenant_members WHERE lower(email)='owner-b@example.com'");
    }
  });

  it("authenticates like open: a bad token is invalid_token before any request", async () => {
    for (const bad of [token({}, "x".repeat(48)), token({ aud: "other" }), "not-a-jwt"]) expect(await worker.orders({ idToken: bad })).toEqual({ outcome: "invalid_token" });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns the 10 newest orders newest first and a summary over all of those fetched", async () => {
    await link();
    fake.orders = Array.from({ length: 12 }, (_, i) => ({ id: 2000 + i, name: `#${2000 + i}`, created_at: iso(12 - i), total: "10.50" }));
    const out = await worker.orders({ idToken: token() });
    expect(out).toMatchObject({ outcome: "ok", summary: { count: 12, total: { amount: "126.00", currency: "USD" } } });
    if (out.outcome !== "ok") throw new Error("unreachable");
    expect(out.orders.map((o) => o.name)).toEqual(Array.from({ length: 10 }, (_, i) => `#${2011 - i}`));
    expect(out.orders[0]).toEqual({ name: "#2011", createdAt: iso(1), displayFinancialStatus: "paid", displayFulfillmentStatus: "unfulfilled", total: { amount: "10.50", currency: "USD" } });
  });

  it("asks for the last 60 days from the injected clock, 50 at most, and works for a reauthorize connection too", async () => {
    await link();
    clock.ms += 3 * DAY;
    await worker.orders({ idToken: token() });
    const q = lastQuery();
    expect(q.variables.first).toBe(50);
    expect(q.variables.query).toBe(`created_at:>='${iso(60)}' created_at:<='${iso(0)}'`);
    await database.pool.query("UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error'");
    expect(await worker.orders({ idToken: token() })).toMatchObject({ outcome: "ok" });
  });

  it("never selects or returns customer data", async () => {
    await link();
    fake.orders = [{ id: 1, name: "#1", created_at: iso(1), customerId: 55 }];
    const out = await worker.orders({ idToken: token() });
    expect(lastQuery().query).not.toMatch(/customer|email|firstName|lastName|phone|address/i);
    expect(JSON.stringify(out)).not.toMatch(/customer|email|55/i);
    if (out.outcome !== "ok") throw new Error("unreachable");
    expect(Object.keys(out.orders[0]!).sort()).toEqual(["createdAt", "displayFinancialStatus", "displayFulfillmentStatus", "name", "total"]);
  });

  it("skips an order that does not fit the contract instead of cutting it, and keeps the rest", async () => {
    await link();
    fake.orders = [
      { id: 1, name: "#1", created_at: iso(1) },
      { id: 2, name: "x".repeat(101), created_at: iso(2) },
      { id: 3, name: "#3", created_at: "+010000-01-01T00:00:00.000Z" },
      { id: 4, name: "#4", created_at: iso(3), currency: "usd" },
      { id: 5, name: "#5", created_at: iso(4), total: "1234567890123456.00" },
      { id: 6, name: "#6", created_at: iso(5), financialStatus: "P".repeat(61) },
      { id: 7, name: "#7", created_at: iso(5), fulfillmentStatus: 7 },
      { id: 8, name: "#8", created_at: "1" },
      { id: 9, name: "#9", created_at: "March 5" },
      { id: 10, name: "#10", created_at: "2026-02-30T00:00:00Z" },
      { id: 11, name: "#11", created_at: iso(6), fulfillmentStatus: null },
    ];
    const out = await worker.orders({ idToken: token() });
    expect(shopifyOrdersResponseSchema.safeParse(out).success).toBe(true);
    if (out.outcome !== "ok") throw new Error("unreachable");
    expect(out.orders.map((o) => o.name)).toEqual(["#1", "#11"]);
    expect(out.orders[1]).toMatchObject({ displayFulfillmentStatus: null });
    expect(out.summary.count).toBe(2);
  });

  it("skips an order Shopify returns from outside the 60-day window, and keeps an offset time as an exact instant", async () => {
    await link();
    fake.ignoreSearch = true;
    const inside = new Date(clock.now().getTime() - DAY);
    const offset = `${new Date(inside.getTime() - 5 * 3_600_000).toISOString().slice(0, 19)}-05:00`;
    fake.orders = [
      { id: 1, name: "#1", created_at: offset },
      { id: 2, name: "#2", created_at: iso(61) },
      { id: 3, name: "#3", created_at: new Date(clock.now().getTime() + DAY).toISOString() },
    ];
    const out = await worker.orders({ idToken: token() });
    if (out.outcome !== "ok") throw new Error("unreachable");
    expect(out.orders.map((o) => [o.name, o.createdAt])).toEqual([["#1", inside.toISOString().replace(/\.\d{3}Z$/, ".000Z")]]);
    expect(out.summary.count).toBe(1);
  });

  it("reads only the 50 newest of more orders in the window", async () => {
    await link();
    fake.orders = Array.from({ length: 60 }, (_, i) => ({ id: 5000 + i, name: `#${5000 + i}`, created_at: iso(59 - i * 0.9), total: "1.00" }));
    const out = await worker.orders({ idToken: token() });
    expect(out).toMatchObject({ outcome: "ok", summary: { count: 50, total: { amount: "50.00", currency: "USD" } } });
    if (out.outcome !== "ok") throw new Error("unreachable");
    expect(out.orders[0]!.name).toBe("#5059");
  });

  it("sums the largest valid amounts into a total the contract still accepts", async () => {
    await link();
    fake.orders = Array.from({ length: 50 }, (_, i) => ({ id: 3000 + i, name: `#${3000 + i}`, created_at: iso(1 + i / 100), total: "999999999999999.99" }));
    const out = await worker.orders({ idToken: token() });
    expect(shopifyOrdersResponseSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ outcome: "ok", summary: { count: 50, total: { amount: "49999999999999999.50", currency: "USD" } } });
  });

  it("is empty with a null total when there are no orders, and has no total across currencies", async () => {
    await link();
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "ok", orders: [], summary: { count: 0, total: null } });
    fake.orders = [{ id: 1, name: "#1", created_at: iso(1) }, { id: 2, name: "#2", created_at: iso(2), currency: "CAD" }];
    expect(await worker.orders({ idToken: token() })).toMatchObject({ outcome: "ok", summary: { count: 2, total: null } });
  });

  it("refreshes a token near its end first, and answers busy while another refresh holds the lease", async () => {
    await link();
    clock.ms += 56 * 60_000;
    expect(await worker.orders({ idToken: token() })).toMatchObject({ outcome: "ok" });
    expect(fake.calls.filter((c) => c.body?.grant_type === "refresh_token")).toHaveLength(1);
    expect(reports).toContainEqual({ kind: "refreshed", shop: SHOP });
    clock.ms += 56 * 60_000;
    await database.pool.query("INSERT INTO shopify_locks (shop_domain, held_until, holder) VALUES ($1,$2,$3)", [SHOP, new Date(clock.now().getTime() + 30_000), randomUUID()]);
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "busy" });
  });

  it("maps a Shopify failure to unavailable, and a revoked token marks the connection reauthorize", async () => {
    await link();
    fake.failGraphql = { status: 403 };
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "unavailable" });
    fake.failGraphql = { status: 429 };
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "unavailable" });
    expect((await connections())[0]).toMatchObject({ status: "active" });
    fake.failGraphql = { status: 401 };
    expect(await worker.orders({ idToken: token() })).toEqual({ outcome: "unavailable" });
    expect((await connections())[0]).toMatchObject({ status: "reauthorize", reauthorize_reason: "auth_error" });
  });
});

describe("the pass sweeps old rows (C-24)", () => {
  const DAYS = 24 * 3_600_000;
  const seedClaim = (tenantId: string, status: string, expiresAt: number, hash: string) => database.pool.query(
    `INSERT INTO shopify_claims (tenant_id,id,code_hash,status,shop_id,shop_domain,shop_name,expires_at,redeemed_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'Store',$7,$8,$9,$9)`,
    [tenantId, randomUUID(), hash.repeat(64), status, SHOP_GID, SHOP, new Date(expiresAt), status === "open" ? null : new Date(T0 - 1000), new Date(T0 - 3_600_000)]);
  const claimStatuses = async () => (await database.pool.query("SELECT tenant_id, status FROM shopify_claims ORDER BY status")).rows.map((r) => `${r.tenant_id === a.tenantId ? "a" : "b"}:${r.status}`);

  it("removes webhook ids older than 30 days, keeps fresh ones, drops stale locks and expires lapsed claims", async () => {
    const event = (id: string, ageMs: number) => database.pool.query(
      "INSERT INTO shopify_webhook_events (webhook_id, topic, shop_domain, received_at) VALUES ($1,'app/uninstalled',$2,$3)", [id, SHOP, new Date(T0 - ageMs)]);
    await event("old", 30 * DAYS + 1000);
    await event("fresh", 29 * DAYS);
    await database.pool.query("INSERT INTO shopify_locks (shop_domain, held_until, holder) VALUES ($1,$2,$3), ($4,$5,$3)", [SHOP, new Date(T0 - 1000), randomUUID(), "other.myshopify.com", new Date(T0 + 30_000)]);
    await seedClaim(a.tenantId, "redeemed", T0 - 1000, "a");
    await seedClaim(a.tenantId, "confirmed", T0 - 1000, "c");
    await seedClaim(b.tenantId, "open", T0 + 60_000, "b");

    await worker.pass({ deadline: clock.ms + 20_000 });

    expect((await database.pool.query("SELECT webhook_id FROM shopify_webhook_events ORDER BY webhook_id")).rows.map((r) => r.webhook_id)).toEqual(["fresh"]);
    expect((await database.pool.query("SELECT shop_domain FROM shopify_locks")).rows.map((r) => r.shop_domain)).toEqual(["other.myshopify.com"]);
    // The lapsed redeemed claim expires; a confirmed one and a live open one are left alone.
    expect(await claimStatuses()).toEqual(["a:confirmed", "a:expired", "b:open"]);
  });
});

describe("the Composio worker hands native rows over (C-26)", () => {
  it("run, disconnect and the pass treat a native row as native and never ask Composio", async () => {
    await worker.open({ idToken: token() });
    await worker.createHub({ idToken: token() });
    const composio = new FakeComposio();
    const connectionsWorker = createConnectionsWorker({
      service: (work) => asService(database.servicePool, work),
      composio: createComposioClient({ apiKey: "test-key", baseUrl: "https://composio.test/api/v3.1", fetch: composio.fetch, timeoutMs: 1500 }),
      clock, config: { env: "preview", callbackUrl: "https://dashboard.example.test/api/connections/callback", authConfigIds: { shopify: "ac_shopify" } },
      native: worker,
    });
    const c = (await database.pool.query("SELECT tenant_id, id FROM connections")).rows[0];
    fake.orders = [{ id: 7, name: "#7", created_at: "2026-11-01T10:00:00Z" }];
    expect(await connectionsWorker.run({ tenantId: c.tenant_id, connectionId: c.id, tool: "shopify_list_orders", arguments: {} })).toMatchObject({ outcome: "ok" });
    await database.pool.query("UPDATE connections SET status='disconnecting'");
    expect(await connectionsWorker.disconnect({ tenantId: c.tenant_id, connectionId: c.id })).toEqual({ outcome: "disconnected" });
    const pass = await connectionsWorker.pass();
    expect(pass.stopped).toBeNull();
    expect(composio.calls).toHaveLength(0);
  });
});
