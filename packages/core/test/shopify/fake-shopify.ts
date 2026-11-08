// An in-process Shopify for tests: the token endpoint (token exchange, refresh), the Admin GraphQL endpoint
// (shop, orders, appUninstall) and helpers that mint ID tokens and signed webhooks. No test calls the network.
import { createHmac, randomBytes } from "node:crypto";
import { requestedQueryCost } from "./query-cost.js";

export const CLIENT_ID = "client-id-123";
export const CLIENT_SECRET = "c".repeat(48);
export const SHOP = "zs-test-store.myshopify.com";
export const SHOP_GID = "gid://shopify/Shop/9001";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function mintIdToken(now: Date, over: Record<string, unknown> = {}, secret = CLIENT_SECRET, shop = SHOP): string {
  const t = Math.floor(now.getTime() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: CLIENT_ID, sub: "77", exp: t + 50, nbf: t - 5, iat: t - 5, jti: randomBytes(12).toString("hex"), sid: "sid", ...over });
  return `${header}.${body}.${createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")}`;
}
export const signWebhook = (body: string, secret = CLIENT_SECRET) => createHmac("sha256", secret).update(body).digest("base64");

export interface FakeCall { readonly url: string; readonly headers: Record<string, string>; readonly body: Record<string, unknown> | null }
export interface FakeOrder {
  id: number; name: string; created_at: string; customerId?: number | null; total?: string; currency?: string;
  financialStatus?: unknown; fulfillmentStatus?: unknown; lineItems?: number;
}

export class FakeShopify {
  readonly calls: FakeCall[] = [];
  now = () => new Date();
  expiresIn = 3600;
  refreshExpiresIn = 7_776_000;
  accountOwner = true;
  emailVerified = true;
  email = "owner@example.com";
  shopName = "ZS Test Store";
  shopGid = SHOP_GID;
  /** Next token endpoint answer overrides: a status and body. */
  failNextToken: { status: number; body: unknown } | null = null;
  failGraphql: { status: number; body?: unknown } | null = null;
  graphqlErrors: unknown[] | null = null;
  orders: FakeOrder[] = [];
  /** Orders of other stores, by myshopify domain; `orders` is SHOP's. */
  ordersByShop: Record<string, FakeOrder[]> = {};
  /** Other stores' identity, by myshopify domain (the shop query answers for the store it is sent to). */
  otherShops: Record<string, { gid: string; name: string }> = {};
  /** Answer an orders query with every order, ignoring `first` and the search: a store that misreads the search. */
  ignoreSearch = false;
  /** The store each issued access token belongs to: a token answers only for its own store. */
  readonly tokenShop = new Map<string, string>();
  /** Requested cost of every Admin GraphQL query that reached the fake (Shopify's documented defaults). */
  readonly costs: number[] = [];
  /** Hang the next Admin GraphQL call until the caller aborts it. */
  hangGraphql = false;
  currentAccess = new Set<string>();
  currentRefresh = new Set<string>();
  uninstalled = false;
  private n = 0;
  /** Refresh tokens that have been replaced by a newer one that was then used (retired). */
  retired = new Set<string>();
  lastRefreshWithTokens: string[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.calls.push({ url, headers, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/admin/oauth/access_token")) {
      if (this.failNextToken) { const f = this.failNextToken; this.failNextToken = null; return json(f.status, f.body); }
      if (body?.client_id !== CLIENT_ID || body?.client_secret !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
      if (body?.grant_type === "urn:ietf:params:oauth:grant-type:token-exchange") {
        const claims = JSON.parse(Buffer.from(String(body.subject_token).split(".")[1]!, "base64url").toString()) as { exp: number };
        if (claims.exp * 1000 < this.now().getTime()) return json(400, { error: "invalid_request" });
        const online = body.requested_token_type === "urn:shopify:params:oauth:token-type:online-access-token";
        const access = `shpat_${++this.n}_${randomBytes(4).toString("hex")}`;
        this.currentAccess.add(access);
        this.tokenShop.set(access, new URL(url).host);
        if (online) {
          return json(200, {
            access_token: access, scope: "read_orders", expires_in: 86399, associated_user_scope: "read_orders",
            associated_user: { id: 77, first_name: "Owen", last_name: "Owner", email: this.email, email_verified: this.emailVerified, account_owner: this.accountOwner, locale: "en", collaborator: false },
          });
        }
        if (body.expiring === 1 || body.expiring === "1") {
          // A new exchange retires every other refresh token of the app on the store (S2).
          this.currentRefresh.forEach((token) => this.retired.add(token));
          this.currentRefresh.clear();
          const refresh = `shprt_${++this.n}_${randomBytes(4).toString("hex")}`;
          this.currentRefresh.add(refresh);
          return json(200, { access_token: access, scope: "read_orders", expires_in: this.expiresIn, refresh_token: refresh, refresh_token_expires_in: this.refreshExpiresIn });
        }
        return json(200, { access_token: access, scope: "read_orders" });
      }
      if (body?.grant_type === "refresh_token") {
        const given = String(body.refresh_token);
        this.lastRefreshWithTokens.push(given);
        if (!this.currentRefresh.has(given)) return json(401, { error: "invalid_request" });
        const access = `shpat_${++this.n}_${randomBytes(4).toString("hex")}`;
        const refresh = `shprt_${++this.n}_${randomBytes(4).toString("hex")}`;
        this.currentRefresh.add(refresh);
        this.currentAccess.add(access);
        this.tokenShop.set(access, new URL(url).host);
        return json(200, { access_token: access, scope: "read_orders", expires_in: this.expiresIn, refresh_token: refresh, refresh_token_expires_in: this.refreshExpiresIn });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.includes("/admin/api/") && url.endsWith("/graphql.json")) {
      if (this.hangGraphql) {
        this.hangGraphql = false;
        await new Promise<never>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (this.failGraphql) return json(this.failGraphql.status, this.failGraphql.body ?? { errors: "x" });
      const token = headers["x-shopify-access-token"];
      const shop = new URL(url).host;
      if (!token || !this.currentAccess.has(token) || this.uninstalled || (this.tokenShop.get(token) ?? shop) !== shop)
        return json(401, { errors: "[API] Invalid API key or access token" });
      if (this.graphqlErrors) return json(200, { errors: this.graphqlErrors });
      const query = String(body?.query ?? "");
      const variables = (body?.variables ?? {}) as Record<string, unknown>;
      // Shopify checks the requested cost before it runs a query (shopify.dev: "Single query limit").
      const cost = requestedQueryCost(query, variables);
      this.costs.push(cost);
      if (cost > 1000)
        return json(200, { errors: [{ message: `Query cost is ${cost}, which exceeds the single query max cost limit (1000).`, extensions: { code: "MAX_COST_EXCEEDED", cost, maxCost: 1000 } }] });
      if (query.includes("appUninstall")) {
        this.uninstalled = true;
        return json(200, { data: { appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } } });
      }
      if (query.includes("shop {") || query.includes("shop{")) {
        const other = this.otherShops[shop];
        return json(200, { data: { shop: other ? { id: other.gid, name: other.name, myshopifyDomain: shop } : { id: this.shopGid, name: this.shopName, myshopifyDomain: SHOP } } });
      }
      const stock = shop === SHOP ? this.orders : (this.ordersByShop[shop] ?? []);
      if (query.includes("orders(")) {
        if (this.ignoreSearch) return json(200, { data: { orders: { nodes: stock.map((o) => this.node(o, Number(variables["lineItems"] ?? 0), query)) } } });
        // Newest first, only those the search's created_at range admits, at most `first`, each line-item page cut to size.
        const first = Number(variables["first"]);
        const bounds = [...String(variables["query"] ?? "").matchAll(/created_at:(>=|<=)'([^']+)'/g)].map(([, cmp, at]) => ({ after: cmp === ">=", at: Date.parse(at!) }));
        const inRange = (o: FakeOrder) => {
          const t = Date.parse(o.created_at);
          return Number.isNaN(t) || bounds.every((b) => (b.after ? t >= b.at : t <= b.at));
        };
        const picked = stock.filter(inRange).sort((x, y) => (Date.parse(y.created_at) || 0) - (Date.parse(x.created_at) || 0)).slice(0, first);
        return json(200, { data: { orders: { nodes: picked.map((o) => this.node(o, Number(variables["lineItems"] ?? 0), query)), pageInfo: { hasNextPage: false, endCursor: null } } } });
      }
      if (query.includes("order(")) {
        const wanted = String(variables["id"] ?? "");
        const found = stock.find((o) => `gid://shopify/Order/${o.id}` === wanted);
        return json(200, { data: { order: found ? this.node(found, Number(variables["lineItems"] ?? 0), query) : null } });
      }
      return json(200, { errors: [{ message: "unknown query" }] });
    }
    return json(404, {});
  };

  /** The order as Shopify would answer it: only the top-level fields the query selects, line items cut to the page asked for. */
  private node(o: FakeOrder, lineItemPage: number, query: string) {
    const full = this.fullNode(o, lineItemPage);
    return Object.fromEntries(Object.entries(full).filter(([key]) => new RegExp(`\\b${key}\\b`).test(query)));
  }
  private fullNode(o: FakeOrder, lineItemPage: number) {
    const items = Array.from({ length: o.lineItems ?? 1 }, (_, i) => ({ title: i === 0 ? "Mug" : `Item ${i + 1}`, quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "12.50" } } }));
    return {
      id: `gid://shopify/Order/${o.id}`, legacyResourceId: String(o.id), name: o.name, createdAt: o.created_at, updatedAt: o.created_at,
      displayFinancialStatus: "financialStatus" in o ? o.financialStatus : "PAID",
      displayFulfillmentStatus: "fulfillmentStatus" in o ? o.fulfillmentStatus : "UNFULFILLED", currencyCode: o.currency ?? "USD",
      totalPriceSet: { shopMoney: { amount: o.total ?? "30.00" } }, subtotalPriceSet: { shopMoney: { amount: "25.00" } }, totalTaxSet: { shopMoney: { amount: "5.00" } },
      lineItems: { nodes: items.slice(0, lineItemPage) },
    };
  }
}
