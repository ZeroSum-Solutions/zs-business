// An in-process fake of the Composio REST API (connections.md C-15), built from the facts the
// contract records: link returns a redirect URL and an account ID before anyone signs in; with
// deferred verification the account stays INITIATED until `complete_auth` redeems the single-use
// `session_uri` for the same `user_id`; GET returns the account with a `state` block of masked
// credentials; execute can answer HTTP 200 with `successful: false`. No test calls the real
// service, and no text of Composio's documentation is copied here.
export interface FakeAccount {
  id: string;
  userId: string;
  toolkit: string;
  authConfigId: string;
  status: string;
  shopDomain: string | null;
  deleted: boolean;
  revoked: boolean;
}
export interface FakeCall { readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly body: unknown; readonly apiKey: string | null }
/**
 * One tool in the fake registry. `versions` is every version the tool has; `listed` is the recent part the
 * registry lists in `available_versions` (all of them when absent), since the real list is capped.
 */
export interface FakeTool {
  toolkit: string;
  versions: string[];
  listed?: string[];
  deprecated?: boolean;
  /** What the registry answers differently when asked for one version. */
  atVersion?: Record<string, { slug?: string; toolkit?: string; deprecated?: boolean }>;
}
export interface FakeShop { id: string; name: string; domain: string }

type Override = { status?: number; json?: unknown; hang?: boolean; bytes?: number; times?: number };

const ORDER = {
  id: 450789469, name: "#1001", created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-02T10:00:00Z",
  financial_status: "paid", fulfillment_status: null, currency: "USD", total_price: "59.00", subtotal_price: "54.00", total_tax: "5.00",
  line_items: [{ title: "Mug", quantity: 2, price: "27.00", sku: "SKU-1", vendor: "secret-vendor" }],
  customer: { id: 207119551, first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "+15555550100", default_address: { city: "x" } },
  token: "should-not-leak", note_attributes: [{ name: "secret", value: "x" }],
};
export const fakeOrder = (id: number | string, extra: Record<string, unknown> = {}) => ({ ...ORDER, id: Number(id), name: `#${id}`, ...extra });

export class FakeComposio {
  readonly accounts = new Map<string, FakeAccount>();
  readonly sessions = new Map<string, { accountId: string; used: boolean }>();
  readonly calls: FakeCall[] = [];
  deferredVerification = true;
  /** `created_at` the fake lists its accounts with (C-4). */
  listedCreatedAt = "2000-01-01T00:00:00.000Z";
  /** The shop the identity tool answers for, by account. */
  readonly shops = new Map<string, FakeShop>();
  orders: unknown[] = [fakeOrder(1001), fakeOrder(1002)];
  /** Path-keyed overrides: `GET /connected_accounts/x` style regexes against "METHOD path". */
  private readonly overrides: { match: RegExp; value: Override }[] = [];
  private counter = 0;
  /** Drops the answer of the next `complete_auth` after it took effect (a lost response). */
  loseNextCompleteAuth = false;
  /** The tool registry `GET /tools/:slug` answers from (A-8): slug to its toolkit and versions, newest first. */
  readonly tools = new Map<string, FakeTool>([
    ["SHOPIFY_QUERY_SHOP", { toolkit: "shopify", versions: ["20261104_00"] }],
    ["SHOPIFY_GET_ORDERS_WITH_FILTERS", { toolkit: "shopify", versions: ["20261104_00"] }],
    ["SHOPIFY_GET_ORDER", { toolkit: "shopify", versions: ["20261104_00"] }],
  ]);
  /** Runs before a request is answered; a test uses it to interleave another writer. */
  gate: ((call: FakeCall) => Promise<void>) | null = null;

  override(match: RegExp, value: Override): void { this.overrides.push({ match, value }); }
  clearOverrides(): void { this.overrides.length = 0; }
  callsTo(pattern: RegExp): FakeCall[] { return this.calls.filter((call) => pattern.test(`${call.method} ${call.path}`)); }

  /**
   * The person signs in and consents: the account stays INITIATED when verification is deferred.
   * Like the real redirect (observed 2026-11-07), the callback then carries `session_uri` only: no account
   * ID, user ID or toolkit. A test passes the returned value as `sessionUri` and no `accountId`.
   */
  consent(accountId: string): string {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("no such account");
    const sessionUri = `session-${++this.counter}-${accountId}`;
    this.sessions.set(sessionUri, { accountId, used: false });
    if (!this.deferredVerification) account.status = "ACTIVE";
    return sessionUri;
  }
  /** Seeds an ACTIVE account, as if an earlier connect had finished. */
  seed(account: Partial<FakeAccount> & { id: string; userId: string }): FakeAccount {
    const full: FakeAccount = { toolkit: "shopify", authConfigId: "ac_shopify", status: "ACTIVE", shopDomain: "testshop.myshopify.com", deleted: false, revoked: false, ...account };
    this.accounts.set(full.id, full);
    this.shops.set(full.id, { id: "8812345", name: "Test Shop", domain: full.shopDomain ?? "testshop.myshopify.com" });
    return full;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v3\.1/, "");
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) as unknown : undefined;
    const call: FakeCall = { method, path, query: url.searchParams, body, apiKey: headers.get("x-api-key") };
    this.calls.push(call);
    await this.gate?.(call);
    const signal = init?.signal ?? undefined;
    const override = this.overrides.find((entry) => entry.match.test(`${method} ${path}`) && (entry.value.times === undefined || entry.value.times > 0));
    if (override) {
      if (override.value.times !== undefined) override.value.times -= 1;
      if (override.value.hang) return new Promise<Response>((_, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: signal?.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError" }));
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
      if (override.value.bytes !== undefined) {
        const total = override.value.bytes;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { const chunk = new Uint8Array(64 * 1024).fill(97); for (let sent = 0; sent < total; sent += chunk.length) controller.enqueue(chunk); controller.close(); },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }
      return json(override.value.status ?? 200, override.value.json ?? {});
    }
    const r = this.route(method, path, body, url.searchParams);
    if (this.loseNextCompleteAuth && path === "/connected_accounts/complete_auth" && r.status === 200) {
      this.loseNextCompleteAuth = false;
      throw new TypeError("fetch failed");
    }
    return json(r.status, r.body);
  };

  private route(method: string, path: string, body: unknown, query: URLSearchParams): { status: number; body: unknown } {
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === "POST" && path === "/connected_accounts/link") {
      const id = `ca_${++this.counter}`;
      // The real hosted form never takes the store from the link (C-17): the owner types it there, so the fake's store is fixed.
      const shop = null;
      this.accounts.set(id, {
        id, userId: String(b["user_id"]), toolkit: "shopify", authConfigId: String(b["auth_config_id"]), status: "INITIATED", shopDomain: shop, deleted: false, revoked: false,
      });
      this.shops.set(id, { id: "8812345", name: "Test Shop", domain: shop ?? "testshop.myshopify.com" });
      return { status: 201, body: { link_token: `lt_${id}`, redirect_url: `https://connect.composio.test/link/${id}`, expires_at: "2026-11-06T12:00:00.000Z", connected_account_id: id } };
    }
    if (method === "POST" && path === "/connected_accounts/complete_auth") {
      const session = this.sessions.get(String(b["session_uri"]));
      if (!session || session.used) return { status: 404, body: { error: { message: "not found" } } };
      const account = this.accounts.get(session.accountId)!;
      if (account.userId !== b["user_id"]) return { status: 400, body: { error: { message: "user mismatch" } } };
      session.used = true;
      account.status = "ACTIVE";
      return { status: 200, body: { connected_account_id: account.id, toolkit_slug: account.toolkit } };
    }
    // C-13: the app's own uninstall through the proxy (`revoked` records it). Only the catalog's fixed request is accepted; a
    // second uninstall finds the token dead, as Shopify answers it (401).
    if (method === "POST" && path === "/tools/execute/proxy") {
      const account = this.accounts.get(String(b["connected_account_id"]));
      if (!account || account.deleted) return { status: 404, body: { error: { message: "gone" } } };
      const query = ((b["body"] ?? {}) as Record<string, unknown>)["query"];
      if (account.userId !== b["user_id"] || b["method"] !== "POST" || b["endpoint"] !== "/graphql.json" || typeof query !== "string" || !query.includes("appUninstall"))
        return { status: 400, body: { error: { message: "not the uninstall request" } } };
      if (account.revoked) return { status: 200, body: { status: 401, data: { errors: "[API] Invalid API key or access token" } } };
      account.revoked = true;
      return { status: 200, body: { status: 200, data: { data: { appUninstall: { app: { id: "gid://shopify/App/1" }, userErrors: [] } } }, headers: {} } };
    }
    if (method === "GET" && path === "/connected_accounts") {
      // C-4: the list the worker reads to check that a refused link made nothing. Accounts the fake holds are listed with
      // `listedCreatedAt` (long ago by default, so a seeded account is not "new"); a test overrides the path for other cases.
      const users = query.getAll("user_ids");
      const configs = query.getAll("auth_config_ids");
      const items = [...this.accounts.values()].filter((a) => !a.deleted && (users.length === 0 || users.includes(a.userId)) && (configs.length === 0 || configs.includes(a.authConfigId)))
        .map((a) => ({ id: a.id, user_id: a.userId, created_at: this.listedCreatedAt }));
      return { status: 200, body: { items, next_cursor: null, total_items: items.length } };
    }
    const match = /^\/connected_accounts\/([^/]+)$/.exec(path);
    if (match) {
      const account = this.accounts.get(decodeURIComponent(match[1]!));
      if (!account || account.deleted) return { status: 404, body: { error: { message: "gone" } } };
      if (method === "GET")
        return { status: 200, body: {
          id: account.id, status: account.status, user_id: account.userId, toolkit: { slug: account.toolkit }, auth_config: { id: account.authConfigId },
          state: { val: { access_token: "shpat_masked_ABCDEF", refresh_token: "r_masked" } }, data: { access_token: "should-not-leak" },
        } };
      if (method === "DELETE") { account.deleted = true; return { status: 200, body: { success: true } }; }
    }
    const tool = /^\/tools\/([A-Z0-9_]+)$/.exec(path);
    if (method === "GET" && tool) {
      const entry = this.tools.get(tool[1]!);
      // `toolkit_versions` asks for the tool at one version: unknown versions answer 404, like an unknown slug.
      const asked = query.get("toolkit_versions");
      const version = asked === null || asked === "latest" ? entry?.versions[0] : entry?.versions.find((v) => v === asked);
      if (!entry || version === undefined) return { status: 404, body: { error: { message: "no such tool" } } };
      const at = asked === null ? undefined : entry.atVersion?.[asked];
      return {
        status: 200,
        body: {
          slug: at?.slug ?? tool[1], name: "x", toolkit: { slug: at?.toolkit ?? entry.toolkit, name: "Shopify" }, version,
          available_versions: entry.listed ?? entry.versions, is_deprecated: at?.deprecated ?? entry.deprecated ?? false,
        },
      };
    }
    const exec = /^\/tools\/execute\/([A-Z0-9_]+)$/.exec(path);
    if (method === "POST" && exec) {
      const keys = Object.keys(b).sort().join(",");
      if (keys !== "arguments,connected_account_id,user_id,version") return { status: 400, body: { error: { message: "bad envelope" } } };
      const account = this.accounts.get(String(b["connected_account_id"]));
      if (!account || account.deleted || account.userId !== b["user_id"]) return { status: 404, body: { error: { message: "no account" } } };
      if (typeof b["version"] !== "string" || b["version"] === "") return { status: 400, body: { error: { message: "version" } } };
      const slug = exec[1]!;
      if (slug === "SHOPIFY_QUERY_SHOP") {
        const shop = this.shops.get(account.id)!;
        return { status: 200, body: { successful: true, error: null, data: { shop: { id: `gid://shopify/Shop/${shop.id}`, name: shop.name, myshopifyDomain: shop.domain, email: "owner@example.com" } } } };
      }
      if (slug === "SHOPIFY_GET_ORDERS_WITH_FILTERS") return { status: 200, body: { successful: true, error: null, data: { orders: this.orders } } };
      if (slug === "SHOPIFY_GET_ORDER") {
        const id = (b["arguments"] as Record<string, unknown>)["order_id"];
        return { status: 200, body: { successful: true, error: null, data: fakeOrder(String(id)) } };
      }
    }
    return { status: 404, body: { error: { message: "unknown route" } } };
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
