// The native Shopify tier over HTTP (docs/requirements/connections.md C-21 to C-24): the worker's environment, its
// eight signed operations, the webhook endpoint, and the API's embedded and claim routes against the real Hono app,
// a real local Postgres, the real native worker in process and the in-process fake Shopify. The core suite covers
// the rules; these tests cover the HTTP shape and the isolation between two tenants.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_SIGNATURE_HEADERS,
  createHttpShopifyPort,
  createLocalShopifyPort,
  createLocalStubSessionCheck,
  createShopifyClient,
  createShopifyNativeWorker,
  parseSealKeys,
  signConnectorRequest,
  type ConnectionLimiter,
  type HubPort,
  type ShopifyPort,
} from "@zs/core";
import { shopifyOpenResponseSchema } from "@zs/contracts";
import { asService } from "@zs/db";
import { createApp, createHs256Verifier, type App } from "../src/app.js";
import { parseConnectionsEnv, parseShopifyNativeEnv } from "../src/connections/config.js";
import { connectionsInternalRoutes } from "../src/connections/internal.js";
import { shopifyWebhookRoutes } from "../src/connections/shopify-webhook.js";
import { call, clock, createApiHarness, signedInMember, SECRET, ORIGIN, type ApiHarness, type MemberSetup } from "./helpers.js";
import { FakeShopify, CLIENT_ID, CLIENT_SECRET, mintIdToken, SHOP, SHOP_GID } from "../../../packages/core/test/shopify/fake-shopify.js";
import { makeClock, T0, addMember } from "../../../packages/core/test/connections/harness.js";

const OWNER_EMAIL = "merchant@example.com";
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const PROJECT_REF = "abcdefghijklmnopqrst";
const SERVICE_KEY = `sb_secret_${"k".repeat(24)}`;
const INTERNAL = ["conn", "internal", "f".repeat(32)].join("-");
const HOST = "worker.haldenrowe.example";

// ---- the worker's environment ------------------------------------------------------------------
const WORKER_ENV = {
  COMPOSIO_API_KEY: ["test", "composio", "k".repeat(20)].join("-"),
  CONNECTIONS_ENV: "preview",
  CONNECTIONS_INTERNAL_SECRET: INTERNAL,
  CONNECTIONS_DATABASE_URL: "postgres://zs_connections@127.0.0.1:55432/zs_dev",
  CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID: "ac_shopify",
  CONNECTIONS_CALLBACK_URL: "https://app.haldenrowe.example/api/connections/callback",
  CRON_SECRET: ["test", "cron", "c".repeat(32)].join("-"),
};
const NATIVE_ENV = {
  SHOPIFY_CLIENT_ID: "a".repeat(32),
  SHOPIFY_CLIENT_SECRET: ["test", "client", "s".repeat(24)].join("-"),
  SHOPIFY_TOKEN_SEAL_KEY: KEY_A,
  SHOPIFY_TOKEN_SEAL_KEY_ID: "k1",
  ZS_TARGET_REF: PROJECT_REF,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  HUB_SIGN_IN_URL: "https://app.haldenrowe.example/auth/confirm",
};
const errorOf = (vars: Record<string, string | undefined>): string => {
  try { parseConnectionsEnv(vars); } catch (error) { return (error as Error).message; }
  throw new Error("accepted");
};

describe("parseShopifyNativeEnv (C-22)", () => {
  it("is off, with no error, when no SHOPIFY_ native variable is set", () => {
    expect(parseShopifyNativeEnv({})).toBeNull();
    expect(parseShopifyNativeEnv({ SHOPIFY_BILLING_APP_HANDLE: "zs" })).toBeNull();
    expect(parseConnectionsEnv(WORKER_ENV).worker?.shopify).toBeNull();
  });

  it("parses the whole set with the defaults", () => {
    const parsed = parseConnectionsEnv({ ...WORKER_ENV, ...NATIVE_ENV }).worker?.shopify;
    expect(parsed).toMatchObject({ clientId: "a".repeat(32), apiVersion: "2026-10", graceDays: 7, projectRef: PROJECT_REF, signInUrl: NATIVE_ENV.HUB_SIGN_IN_URL });
    expect(parsed?.sealKeys.current.id).toBe("k1");
    expect(parsed?.secrets).toEqual({ current: NATIVE_ENV.SHOPIFY_CLIENT_SECRET });
  });

  it("is all or none: one variable set makes the required ones required, and errors name variables, never values", () => {
    for (const name of ["SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_TOKEN_SEAL_KEY", "SHOPIFY_TOKEN_SEAL_KEY_ID", "ZS_TARGET_REF", "SUPABASE_SERVICE_ROLE_KEY", "HUB_SIGN_IN_URL"]) {
      const message = errorOf({ ...WORKER_ENV, ...Object.fromEntries(Object.entries(NATIVE_ENV).filter(([key]) => key !== name)), SHOPIFY_API_VERSION: "2026-10" });
      expect(message).toContain(name);
      for (const value of [NATIVE_ENV.SHOPIFY_CLIENT_SECRET, SERVICE_KEY, KEY_A]) expect(message).not.toContain(value);
    }
  });

  it("refuses the SHOPIFY_ variables without the CONNECTIONS_ ones", () => {
    expect(() => parseConnectionsEnv({ ...NATIVE_ENV })).toThrow(/CONNECTIONS_/);
  });

  it("refuses a bad seal key, a half previous-key pair, a repeated secret, a non-quarterly version, a service key of another project and a plain http sign-in URL", () => {
    const bad = (over: Record<string, string>) => errorOf({ ...WORKER_ENV, ...NATIVE_ENV, ...over });
    expect(bad({ SHOPIFY_TOKEN_SEAL_KEY: "short" })).toContain("SHOPIFY_TOKEN_SEAL_KEY");
    expect(bad({ SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS: Buffer.alloc(32, 9).toString("base64") })).toContain("SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS_ID");
    expect(bad({ SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS: KEY_A, SHOPIFY_TOKEN_SEAL_KEY_PREVIOUS_ID: "k0" })).toMatch(/previous seal key must differ/);
    expect(bad({ SHOPIFY_CLIENT_SECRET_PREVIOUS: NATIVE_ENV.SHOPIFY_CLIENT_SECRET })).toContain("SHOPIFY_CLIENT_SECRET_PREVIOUS");
    expect(bad({ SHOPIFY_API_VERSION: "2026-11" })).toContain("SHOPIFY_API_VERSION");
    expect(bad({ SUPABASE_SERVICE_ROLE_KEY: "not-a-key" })).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(bad({ HUB_SIGN_IN_URL: "http://app.example.com/x" })).toContain("HUB_SIGN_IN_URL");
  });
});

// ---- the app, the native worker and two tenants -----------------------------------------------
let h: ApiHarness;
let staffA: MemberSetup;
let fake: FakeShopify;
let nativeClock: ReturnType<typeof makeClock>;
let native: ReturnType<typeof makeNative>;
let hubKeys: string[];
let limiterRefuses = false;
let ownerB: { memberId: string; userId: string };

const limiter: ConnectionLimiter = { async take() { return limiterRefuses ? { ok: false, retryAfterSeconds: 31 } : { ok: true }; } };

function fakeHub(): HubPort {
  return {
    async createHub(input) {
      hubKeys.push(input.key);
      const existing = await h.database.pool.query<{ tenant_id: string }>("SELECT tenant_id FROM tenant_members WHERE lower(email)=$1", [input.ownerEmail]);
      const tenantId = createHash("sha256").update(input.key).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5");
      if (existing.rows[0] && existing.rows[0].tenant_id !== tenantId) return { kind: "email_has_hub" };
      await h.database.pool.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [tenantId, input.name]);
      await h.database.pool.query(
        "INSERT INTO tenant_members (tenant_id,id,email,role,created_at,updated_at) SELECT $1,$2,$3,'owner',$4,$4 WHERE NOT EXISTS (SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND lower(email)=$3)",
        [tenantId, randomUUID(), input.ownerEmail, new Date(T0)]);
      return { kind: "ok", tenantId };
    },
    async signInLink(email) { return `https://hub.example.test/sign-in?e=${encodeURIComponent(email)}`; },
  };
}

function makeNative() {
  return createShopifyNativeWorker({
    service: (work) => asService(h.database.servicePool, work),
    client: createShopifyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: "2026-10", fetch: fake.fetch, timeoutMs: 1000 }),
    clock: nativeClock,
    config: { clientId: CLIENT_ID, secrets: { current: CLIENT_SECRET }, sealKeys: parseSealKeys({ current: KEY_A, currentId: "k1" }), graceDays: 7 },
    hub: fakeHub(),
    newId: randomUUID,
  });
}

function build(shopify: ShopifyPort | null, shopifyAppHandle?: string): App {
  return createApp({
    ...(shopifyAppHandle ? { shopifyAppHandle } : {}),
    verifier: createHs256Verifier(SECRET, { clock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
    clock,
    db: h.database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    ...(shopify === null ? {} : {
      connections: {
        connector: {} as never,
        stateSecrets: { current: ["conn", "state", "e".repeat(32)].join("-") },
        returnUrl: "https://app.haldenrowe.example/account/connections",
        limiter,
        shopify,
      },
    }),
  });
}

let on: App;
let off: App;

beforeAll(async () => {
  h = await createApiHarness({ clock, activepieces: {} });
  staffA = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
  ownerB = { ...(await addMember(h.fixture, h.b.tenantId, "owner")) };
}, 120_000);
afterAll(async () => { await h?.close(); });

beforeEach(async () => {
  for (const table of ["connections", "shopify_claims", "shopify_installs", "shopify_locks", "shopify_webhook_events", "tenant_plans", "connector_request_nonces"])
    await h.database.pool.query(`DELETE FROM ${table}`);
  await h.database.pool.query("DELETE FROM tenant_members WHERE lower(email)=$1", [OWNER_EMAIL]);
  fake = new FakeShopify();
  nativeClock = makeClock();
  fake.now = () => nativeClock.now();
  fake.email = OWNER_EMAIL;
  hubKeys = [];
  limiterRefuses = false;
  native = makeNative();
  on = build(createLocalShopifyPort(native));
  off = build(null);
});

const token = (over: Record<string, unknown> = {}) => mintIdToken(nativeClock.now(), over);
const embedded = (app: App, op: string, idToken: string | null, body?: unknown) =>
  app.request(`${ORIGIN}/public/v1/shopify/embedded/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(idToken === null ? {} : { authorization: `Bearer ${idToken}` }) },
    body: JSON.stringify(body ?? {}),
  });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("off without the Shopify port (C-21)", () => {
  it("the embedded routes and the claim routes are unknown routes (404)", async () => {
    for (const op of ["open", "create-hub", "sign-in", "redeem-claim"]) expect((await embedded(off, op, token())).status, op).toBe(404);
    expect((await call(off, "POST", "/v1/shopify/claims", { token: h.a.token, body: {} })).status).toBe(404);
    expect((await call(off, "GET", "/v1/shopify/claims/current", { token: h.a.token })).status).toBe(404);
  });
});

describe("the embedded routes (C-21, C-22)", () => {
  it("refuse a missing or malformed token with a 401 and reach no worker", async () => {
    expect((await embedded(on, "open", null)).status).toBe(401);
    expect((await embedded(on, "open", "not-a-token")).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("open shows the store, never sets a cookie, and is not cacheable", async () => {
    const response = await embedded(on, "open", token());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ outcome: "ok", shop: { domain: SHOP, name: "ZS Test Store" }, plan: { state: "none" }, planUrl: null, link: { state: "none" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("open adds Shopify's plan selection page when the app handle is configured (C-29)", async () => {
    const withHandle = build(createLocalShopifyPort(native), "zs-business-connections");
    const body = await json(await embedded(withHandle, "open", token())) as { planUrl: string };
    expect(body.planUrl).toBe(`https://admin.shopify.com/store/${SHOP.replace(".myshopify.com", "")}/charges/zs-business-connections/pricing_plans`);
  });

  it("accepts an open answer from an older worker that has no plan, and still adds planUrl (deploy overlap)", async () => {
    const older: ShopifyPort = { ...createLocalShopifyPort(native), open: async () => ({ outcome: "ok", shop: { domain: SHOP, name: "ZS Test Store" }, link: { state: "none" } }) };
    const response = await embedded(build(older, "zs-business-connections"), "open", token());
    expect(response.status).toBe(200);
    const body = await json(response) as Record<string, unknown>;
    expect(body).not.toHaveProperty("plan");
    expect(body.planUrl).toContain("/charges/zs-business-connections/pricing_plans");
    expect(shopifyOpenResponseSchema.safeParse({ outcome: "ok", shop: { domain: SHOP, name: "x" }, link: { state: "none" } }).success).toBe(true);
  });

  it("accepts an open answer from a newer worker with a field it does not know, and drops that field (either deploy order)", () => {
    const newer = { outcome: "ok", shop: { domain: SHOP, name: "x" }, plan: { state: "none" }, link: { state: "none" }, future: { anything: 1 } };
    const parsed = shopifyOpenResponseSchema.safeParse(newer);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("future");
    // The fields it reads stay strict.
    expect(shopifyOpenResponseSchema.safeParse({ ...newer, plan: { state: "active", name: "Solo", extra: 1 } }).success).toBe(false);
    expect(shopifyOpenResponseSchema.safeParse({ ...newer, link: { state: "none", extra: 1 } }).success).toBe(false);
  });

  it("a forged token is a 401 (so the page retries with a fresh one), not a crash", async () => {
    const forged = await embedded(on, "open", mintIdToken(nativeClock.now(), {}, "z".repeat(48)));
    expect(forged.status).toBe(401);
  });

  it("create-hub makes the hub, then open shows it linked; a second create-hub says already_linked", async () => {
    await embedded(on, "open", token());
    const created = await json(await embedded(on, "create-hub", token()));
    expect(created).toMatchObject({ outcome: "created", ownerEmail: OWNER_EMAIL });
    expect(hubKeys).toEqual(["shopify-9001"]);
    expect(await json(await embedded(on, "open", token()))).toMatchObject({ link: { state: "linked", connection: "active" } });
    expect(await json(await embedded(on, "create-hub", token()))).toEqual({ outcome: "already_linked" });
    const plan = (await h.database.pool.query("SELECT billing_provider FROM tenant_plans WHERE shopify_shop_id=$1", [SHOP_GID])).rows[0];
    expect(plan.billing_provider).toBe("shopify");
  });

  it("sign-in returns the one-time link only to the verified store owner of a linked store", async () => {
    await embedded(on, "open", token());
    expect(await json(await embedded(on, "sign-in", token()))).toEqual({ outcome: "not_available" });
    await embedded(on, "create-hub", token());
    const out = await json(await embedded(on, "sign-in", token()));
    expect(out).toMatchObject({ outcome: "ok" });
    expect(String(out.url)).toMatch(/^https:\/\/hub\.example\.test\/sign-in/);
    fake.accountOwner = false;
    expect(await json(await embedded(on, "sign-in", token()))).toEqual({ outcome: "not_owner" });
  });

  it("a rate-limited caller gets 429 with Retry-After", async () => {
    limiterRefuses = true;
    const response = await embedded(on, "open", token());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
  });

  it("an unreachable worker is a 503, not a leak", async () => {
    const dead = createHttpShopifyPort({
      workerUrl: `https://${HOST}`, env: "preview", secrets: { current: INTERNAL }, clock: nativeClock,
      fetch: async () => { throw new Error("down"); },
    });
    const response = await embedded(build(dead), "open", token());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("down");
  });

  it("redeem-claim rejects a malformed code without reaching the worker", async () => {
    expect(await json(await embedded(on, "redeem-claim", token(), { code: "short" }))).toEqual({ outcome: "invalid_code" });
    expect(await json(await embedded(on, "redeem-claim", token(), {}))).toEqual({ outcome: "invalid_code" });
  });
});

describe("claims: an existing hub links an installed store (C-22)", () => {
  async function startClaim(token_ = h.a.token) {
    const response = await call(on, "POST", "/v1/shopify/claims", { token: token_, body: {} });
    return { response, code: String(response.body.code ?? ""), id: String(response.body.claimId ?? "") };
  }

  it("owner starts, the store redeems with the code, the owner confirms, and the plan is Shopify-billed", async () => {
    await embedded(on, "open", token());
    const { response, code, id } = await startClaim();
    expect(response.status).toBe(201);
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The code is shown once: the status call never returns it.
    const status = await call(on, "GET", "/v1/shopify/claims/current", { token: h.a.token });
    expect(status.body).toMatchObject({ claim: { id, status: "open" } });
    expect(JSON.stringify(status.body)).not.toContain(code);

    expect(await json(await embedded(on, "redeem-claim", token(), { code: code.toLowerCase() }))).toMatchObject({ outcome: "redeemed" });
    expect((await call(on, "GET", "/v1/shopify/claims/current", { token: h.a.token })).body).toMatchObject({ claim: { status: "redeemed", shop: { domain: SHOP } } });

    const confirmed = await call(on, "POST", `/v1/shopify/claims/${id}/confirm`, { token: h.a.token, body: {} });
    expect(confirmed.status).toBe(200);
    expect((await h.database.pool.query("SELECT tenant_id, tier, status FROM connections")).rows).toEqual([{ tenant_id: h.a.tenantId, tier: "native", status: "active" }]);
    expect((await h.database.pool.query("SELECT billing_provider FROM tenant_plans WHERE tenant_id=$1", [h.a.tenantId])).rows[0].billing_provider).toBe("shopify");
  });

  it("staff cannot start, read or confirm a claim (owners only), and there is no token, no claim", async () => {
    expect((await startClaim(staffA.token)).response.status).toBe(403);
    expect((await call(on, "GET", "/v1/shopify/claims/current", { token: staffA.token })).status).toBe(403);
    expect((await call(on, "POST", "/v1/shopify/claims", { body: {} })).status).toBe(401);
  });

  it("two tenants: B's owner cannot confirm or cancel A's claim, and sees none of it", async () => {
    await embedded(on, "open", token());
    const { code, id } = await startClaim();
    await embedded(on, "redeem-claim", token(), { code });
    const asB = await signedInMember(h.database, h.fixture, h.b.tenantId, "owner");
    expect((await call(on, "POST", `/v1/shopify/claims/${id}/confirm`, { token: asB.token, body: {} })).status).toBe(404);
    expect((await call(on, "DELETE", `/v1/shopify/claims/${id}`, { token: asB.token })).status).toBe(404);
    expect((await call(on, "GET", "/v1/shopify/claims/current", { token: asB.token })).body).toEqual({ claim: null });
    expect((await h.database.pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
    void ownerB;
  });

  it("a wrong code redeems nothing, and five wrong codes lock the store for an hour", async () => {
    await embedded(on, "open", token());
    await startClaim();
    for (let i = 0; i < 5; i += 1) expect(await json(await embedded(on, "redeem-claim", token(), { code: "ABCDEFGH23" }))).toEqual({ outcome: "invalid_code" });
    expect(await json(await embedded(on, "redeem-claim", token(), { code: "ABCDEFGH23" }))).toMatchObject({ outcome: "locked" });
  });

  it("an owner cancels their claim; confirming it afterwards is a conflict", async () => {
    await embedded(on, "open", token());
    const { code, id } = await startClaim();
    await embedded(on, "redeem-claim", token(), { code });
    expect((await call(on, "DELETE", `/v1/shopify/claims/${id}`, { token: h.a.token })).status).toBe(200);
    expect((await call(on, "POST", `/v1/shopify/claims/${id}/confirm`, { token: h.a.token, body: {} })).status).toBe(409);
    expect((await call(on, "DELETE", `/v1/shopify/claims/${id}`, { token: h.a.token })).status).toBe(404);
  });

  it("a bad claim id is a 404", async () => {
    expect((await call(on, "POST", "/v1/shopify/claims/not-a-uuid/confirm", { token: h.a.token, body: {} })).status).toBe(404);
  });
});

// ---- the worker's signed routes and the webhook endpoint --------------------------------------
describe("POST /internal/shopify/<operation> (C-21)", () => {
  const nonces = new Set<string>();
  const app = (enabled: boolean) => connectionsInternalRoutes({
    worker: { takeNonce: async (jti: string) => !nonces.has(jti) && (nonces.add(jti), true) } as never,
    native: enabled ? native : null,
    env: "preview",
    secrets: { current: INTERNAL },
    clock: nativeClock,
  });
  const send = (a: ReturnType<typeof app>, path: string, body: unknown, over: { sign?: boolean; secret?: string; text?: string } = {}) => {
    const text = over.text ?? JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (over.sign !== false) Object.assign(headers, signConnectorRequest({ secret: over.secret ?? INTERNAL, env: "preview", host: HOST, path, body: text, now: nativeClock.now() }));
    return a.request(`https://${HOST}${path}`, { method: "POST", headers, body: text });
  };

  it("runs an operation for a correctly signed request, with no cache and no token in the answer", async () => {
    const response = await send(app(true), "/internal/shopify/open", { idToken: token() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await response.json());
    expect(text).toContain(SHOP);
    for (const secret of fake.currentAccess) expect(text).not.toContain(secret);
  });

  it("refuses unsigned, wrongly signed and replayed requests with 401 and runs nothing", async () => {
    const a = app(true);
    const body = { idToken: token() };
    expect((await send(a, "/internal/shopify/open", body, { sign: false })).status).toBe(401);
    expect((await send(a, "/internal/shopify/open", body, { secret: "x".repeat(40) })).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json", ...signConnectorRequest({ secret: INTERNAL, env: "preview", host: HOST, path: "/internal/shopify/open", body: text, now: nativeClock.now(), jti: randomBytes(16).toString("base64url") }) };
    const once = await a.request(`https://${HOST}/internal/shopify/open`, { method: "POST", headers, body: text });
    const twice = await a.request(`https://${HOST}/internal/shopify/open`, { method: "POST", headers, body: text });
    expect([once.status, twice.status]).toEqual([200, 401]);
    expect(headers[CONNECTOR_SIGNATURE_HEADERS.signature]).toBeDefined();
  });

  it("a signature for another operation does not carry over (the path is signed)", async () => {
    const text = JSON.stringify({ idToken: token() });
    const headers = { "content-type": "application/json", ...signConnectorRequest({ secret: INTERNAL, env: "preview", host: HOST, path: "/internal/shopify/open", body: text, now: nativeClock.now() }) };
    const response = await app(true).request(`https://${HOST}/internal/shopify/sign_in`, { method: "POST", headers, body: text });
    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown operation and for every operation when the native tier is off", async () => {
    expect((await send(app(true), "/internal/shopify/export", {})).status).toBe(404);
    expect((await send(app(false), "/internal/shopify/open", { idToken: token() })).status).toBe(404);
  });

  it("a body that does not fit the operation's schema is a 400 (an extra key too)", async () => {
    expect((await send(app(true), "/internal/shopify/open", { idToken: "x" })).status).toBe(400);
    expect((await send(app(true), "/internal/shopify/open", { idToken: token(), extra: 1 })).status).toBe(400);
    expect((await send(app(true), "/internal/shopify/claim_start", { tenantId: "no", memberId: "no" })).status).toBe(400);
  });

  it("carries the claim operations over the signed route too", async () => {
    await native.open({ idToken: token() });
    const out = await send(app(true), "/internal/shopify/claim_start", { tenantId: h.a.tenantId, memberId: h.a.memberId });
    expect(await json(out)).toMatchObject({ outcome: "started" });
  });
});

describe("POST /webhooks/shopify (C-24)", () => {
  async function post(body: string, headers: Record<string, string>) {
    const a = shopifyWebhookRoutes({ native });
    return a.request(`https://${HOST}/webhooks/shopify`, { method: "POST", headers, body });
  }
  const signed = async (body: string, topic: string, shop = SHOP) => {
    const { signWebhook } = await import("../../../packages/core/test/shopify/fake-shopify.js");
    return { "x-shopify-hmac-sha256": signWebhook(body), "x-shopify-topic": topic, "x-shopify-shop-domain": shop, "x-shopify-webhook-id": randomUUID() };
  };

  it("answers 200 to a correctly signed compliance webhook and 401 to a bad tag", async () => {
    const body = JSON.stringify({ shop_id: 9001, shop_domain: SHOP, customer: { id: 1 }, orders_requested: [] });
    expect((await post(body, await signed(body, "customers/data_request"))).status).toBe(200);
    expect((await post(body, { ...(await signed(body, "customers/data_request")), "x-shopify-hmac-sha256": "AAAA" })).status).toBe(401);
    expect((await post(body, { "x-shopify-topic": "customers/redact" })).status).toBe(401);
  });

  it("uninstall disconnects the store; the answer is empty", async () => {
    await embedded(on, "open", token());
    await embedded(on, "create-hub", token());
    const body = JSON.stringify({ id: 9001, myshopify_domain: SHOP });
    fake.uninstalled = true;
    const response = await post(body, await signed(body, "app/uninstalled"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect((await h.database.pool.query("SELECT status FROM shopify_installs")).rows[0].status).toBe("uninstalled");
  });

  it("refuses a body over 64 KiB with 413 and is off (404) without the native tier", async () => {
    const big = "x".repeat(256 * 1024 + 1);
    expect((await post(big, { "content-length": String(big.length), ...(await signed(big, "customers/redact")) })).status).toBe(413);
    const off = shopifyWebhookRoutes({ native: null });
    expect((await off.request(`https://${HOST}/webhooks/shopify`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await off.request(`https://${HOST}/webhooks/shopify`, { method: "GET" })).status).toBe(404);
  });

  it("a worker error is a 500 so Shopify retries, and its text is not echoed", async () => {
    const errors: unknown[] = [];
    const a = shopifyWebhookRoutes({ native: { webhook: async () => { throw new Error("secret detail"); } }, onError: (e) => errors.push(e) });
    const response = await a.request(`https://${HOST}/webhooks/shopify`, { method: "POST", body: "{}" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(errors).toHaveLength(1);
  });
});
