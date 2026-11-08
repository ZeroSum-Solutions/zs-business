import { beforeEach, describe, expect, it } from "vitest";
import { createShopifyClient } from "../../src/shopify/client.js";
import { CLIENT_ID, CLIENT_SECRET, FakeShopify, mintIdToken, SHOP } from "./fake-shopify.js";

const NOW = new Date("2026-11-07T12:00:00Z");
let fake: FakeShopify;
const client = () => createShopifyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: "2026-10", fetch: fake.fetch, timeoutMs: 1000 });
beforeEach(() => { fake = new FakeShopify(); fake.now = () => NOW; });

describe("Shopify client (C-22)", () => {
  it("exchanges an ID token for an expiring offline token with expiring=1", async () => {
    const out = await client().exchangeOffline(SHOP, mintIdToken(NOW));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(fake.calls[0]!.body).toMatchObject({ requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token", expiring: 1, grant_type: "urn:ietf:params:oauth:grant-type:token-exchange" });
    expect(out.tokens.refreshToken).toMatch(/^shprt_/);
    expect(out.tokens.expiresInSeconds).toBe(3600);
    expect(out.tokens.refreshExpiresInSeconds).toBe(7_776_000);
  });
  it("refuses an offline answer that has no refresh token (a non-expiring token)", async () => {
    const real = fake.fetch;
    fake.failNextToken = { status: 200, body: { access_token: "shpat_x", scope: "read_orders" } };
    const out = await client().exchangeOffline(SHOP, mintIdToken(NOW));
    expect(out).toEqual({ kind: "failed", reason: "non_expiring" });
    void real;
  });
  it("reads the online user: owner flag and verified email", async () => {
    const out = await client().exchangeOnline(SHOP, mintIdToken(NOW));
    expect(out).toEqual({ kind: "ok", user: { id: "77", email: "owner@example.com", emailVerified: true, accountOwner: true } });
    expect(fake.calls[0]!.body).toMatchObject({ requested_token_type: "urn:shopify:params:oauth:token-type:online-access-token" });
  });
  it("rotates on refresh and treats 401 invalid_request as a dead refresh token", async () => {
    const first = await client().exchangeOffline(SHOP, mintIdToken(NOW));
    if (first.kind !== "ok") throw new Error("exchange");
    const second = await client().refresh(SHOP, first.tokens.refreshToken);
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
    expect(await client().refresh(SHOP, "shprt_unknown")).toEqual({ kind: "failed", reason: "invalid_grant" });
  });
  it("maps statuses: 429, 5xx, network", async () => {
    fake.failNextToken = { status: 429, body: {} };
    expect(await client().refresh(SHOP, "x")).toEqual({ kind: "failed", reason: "rate_limited" });
    fake.failNextToken = { status: 503, body: {} };
    expect(await client().refresh(SHOP, "x")).toEqual({ kind: "failed", reason: "unavailable" });
    const broken = createShopifyClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiVersion: "2026-10", fetch: async () => { throw new Error("down"); }, timeoutMs: 1000 });
    expect(await broken.refresh(SHOP, "x")).toEqual({ kind: "failed", reason: "unavailable" });
  });
  it("sends the access token only in the header and reads the shop", async () => {
    const first = await client().exchangeOffline(SHOP, mintIdToken(NOW));
    if (first.kind !== "ok") throw new Error("exchange");
    const shop = await client().readShop(SHOP, first.tokens.accessToken);
    expect(shop).toEqual({ kind: "ok", shop: { id: "gid://shopify/Shop/9001", name: "ZS Test Store", domain: SHOP } });
    const call = fake.calls.at(-1)!;
    expect(call.url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect(call.headers["x-shopify-access-token"]).toBe(first.tokens.accessToken);
    expect(call.url).not.toContain(first.tokens.accessToken);
  });
  it("tells a rejected token (401/403) from a throttle and a server error", async () => {
    expect(await client().readShop(SHOP, "bad")).toEqual({ kind: "failed", reason: "unauthorized" });
    const first = await client().exchangeOffline(SHOP, mintIdToken(NOW));
    if (first.kind !== "ok") throw new Error("exchange");
    fake.failGraphql = { status: 403, body: { errors: "Non-expiring access tokens are no longer accepted for the Admin API" } };
    expect(await client().readShop(SHOP, first.tokens.accessToken)).toEqual({ kind: "failed", reason: "forbidden" });
    fake.failGraphql = { status: 429 };
    expect(await client().readShop(SHOP, first.tokens.accessToken)).toEqual({ kind: "failed", reason: "rate_limited" });
    fake.failGraphql = null;
    fake.graphqlErrors = [{ message: "Throttled", extensions: { code: "THROTTLED" } }];
    expect(await client().readShop(SHOP, first.tokens.accessToken)).toEqual({ kind: "failed", reason: "rate_limited" });
    fake.graphqlErrors = [{ message: "Access denied for customer field", extensions: { code: "ACCESS_DENIED" } }];
    expect(await client().readShop(SHOP, first.tokens.accessToken)).toEqual({ kind: "failed", reason: "forbidden" });
  });
  it("refuses a shop that is not a myshopify.com host before any request", async () => {
    await expect(client().exchangeOffline("evil.example.com", mintIdToken(NOW))).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });
});
