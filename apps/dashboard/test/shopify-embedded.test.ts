// The embedded Shopify app on the dashboard side (docs/requirements/connections.md C-21): the page's HTML and policy,
// the session-token proxy, the claim routes through the generic proxy, and the page script run against a fake document.
import { describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { EMBEDDED_CLIENT_PARAMS, EMBEDDED_CLIENT_SOURCE } from "../src/lib/server/shopify-embedded-client";
import { APP_BRIDGE_URL, embeddedPolicy, frameAncestors, renderEmbeddedPage, shopFromQuery } from "../src/lib/server/shopify-embedded-page";
import { embeddedConfigFrom, proxyEmbedded } from "../src/lib/server/shopify-embedded";

const CLIENT_ID = "a".repeat(32);
const NONCE = "n".repeat(24);
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const TOKEN = [b64('{"alg":"HS256","typ":"JWT"}'), b64('{"dest":"https://halden-rowe.myshopify.com"}'), b64("signature-bytes-here")].join(".");

describe("the page and its policy", () => {
  it("loads App Bridge as the first script, after the API key meta, with no async, defer or module", () => {
    const html = renderEmbeddedPage({ clientId: CLIENT_ID, nonce: NONCE });
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    const firstScript = head.indexOf("<script");
    expect(head.slice(firstScript, head.indexOf("</script>") + 9)).toBe(`<script src="${APP_BRIDGE_URL}"></script>`);
    expect(head.indexOf(`<meta name="shopify-api-key" content="${CLIENT_ID}">`)).toBeGreaterThan(-1);
    expect(head.indexOf('name="shopify-api-key"')).toBeLessThan(firstScript);
    expect(head).not.toMatch(/\b(async|defer|type="module")\b/);
    expect(html).toContain('name="design-source"');
  });

  it("puts the nonce on every inline script and style, and nothing page-supplied in the markup", () => {
    const html = renderEmbeddedPage({ clientId: CLIENT_ID, nonce: NONCE });
    expect(html.match(/<script(?![^>]*src=)[^>]*>/g)).toEqual([`<script nonce="${NONCE}">`]);
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(() => renderEmbeddedPage({ clientId: "short", nonce: NONCE })).toThrow(/client ID/);
    expect(() => renderEmbeddedPage({ clientId: CLIENT_ID, nonce: 'x"><script>' })).toThrow(/nonce/);
  });

  it("allows framing by that shop's admin and admin.shopify.com only, and by nobody for an unknown shop", () => {
    expect(shopFromQuery("Halden-Rowe.myshopify.com")).toBe("halden-rowe.myshopify.com");
    for (const bad of [null, "", "evil.example.com", "x.myshopify.com.evil.com", "a b.myshopify.com", "https://x.myshopify.com", "*.myshopify.com"]) expect(shopFromQuery(bad), String(bad)).toBeNull();
    expect(frameAncestors("halden-rowe.myshopify.com")).toBe("frame-ancestors https://halden-rowe.myshopify.com https://admin.shopify.com");
    expect(frameAncestors(null)).toBe("frame-ancestors 'none'");
    const policy = embeddedPolicy("halden-rowe.myshopify.com", NONCE);
    expect(policy).toContain(`script-src 'nonce-${NONCE}' https://cdn.shopify.com`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("is left out of the dashboard's frame ban, and every other path keeps it", async () => {
    const rules = await nextConfig.headers!();
    const general = rules.find((rule) => rule.headers.some((header) => header.key === "X-Frame-Options"))!;
    const matches = (path: string) => new RegExp(`^${general.source}$`).test(path);
    for (const path of ["/", "/sign-in", "/account/connections", "/api/shopify/open", "/shopify", "/shopify/application", "/shopify/app-two"]) expect(matches(path), path).toBe(true);
    for (const path of ["/shopify/app", "/shopify/app/", "/shopify/app/extra"]) expect(matches(path), path).toBe(false);
  });
});

// ---- the session-token proxy -------------------------------------------------------------------
const config = (fetchImpl: typeof fetch) => ({ apiUrl: "https://api.example.test", trustProxy: false, fetch: fetchImpl });
function post(body: string, headers: Record<string, string> = {}, url = "https://hub.example.test/api/shopify/open") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, host: "hub.example.test", "sec-fetch-site": "same-origin", ...headers },
    body,
  });
}
const okFetch = () => vi.fn(async (_url: unknown, _init?: unknown) => Response.json({ outcome: "ok" }, { headers: { "retry-after": "12" } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("POST /api/shopify/<op> (the dashboard half of C-21)", () => {
  it("is off without an API (404) and for an unknown operation", async () => {
    expect(embeddedConfigFrom({})).toBeNull();
    expect((await proxyEmbedded(post("{}"), "open", null)).status).toBe(404);
    expect((await proxyEmbedded(post("{}"), "export", config(okFetch()))).status).toBe(404);
    expect((await proxyEmbedded(new Request("https://hub.example.test/api/shopify/open", { method: "GET" }), "open", config(okFetch()))).status).toBe(404);
  });

  it("forwards the bearer and the body to the API's embedded route, and nothing else of the caller", async () => {
    const upstream = okFetch();
    const response = await proxyEmbedded(post('{"code":"ABCDEFGH23"}', { cookie: "session=secret", "x-forwarded-for": "9.9.9.9" }), "redeem-claim", config(upstream));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("12");
    const [url, init] = upstream.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.example.test/public/v1/shopify/embedded/redeem-claim");
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('{"code":"ABCDEFGH23"}');
  });

  it("passes the browser's address on only behind a trusted proxy", async () => {
    const upstream = okFetch();
    await proxyEmbedded(post("{}", { "x-forwarded-for": "203.0.113.5" }), "open", { ...config(upstream), trustProxy: true });
    expect(new Headers((upstream.mock.calls[0]![1] as RequestInit).headers).get("x-forwarded-for")).toBe("203.0.113.5");
  });

  it("refuses a missing or malformed token (401), another site (403), a non-JSON body (400) and a big body (413) without calling the API", async () => {
    const upstream = okFetch();
    const c = config(upstream);
    const unauthorized = await proxyEmbedded(post("{}", { authorization: "" }), "open", c);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-shopify-retry-invalid-session-request")).toBe("1");
    expect((await proxyEmbedded(post("{}", { authorization: "Bearer not-a-jwt" }), "open", c)).status).toBe(401);
    expect((await proxyEmbedded(post("{}", { "sec-fetch-site": "cross-site" }), "open", c)).status).toBe(403);
    expect((await proxyEmbedded(post("{}", { origin: "https://evil.example" }), "open", c)).status).toBe(403);
    expect((await proxyEmbedded(post("{}", { "content-type": "text/plain" }), "open", c)).status).toBe(400);
    expect((await proxyEmbedded(post("x".repeat(3000)), "open", c)).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 502 when the API is unreachable, without its error text", async () => {
    const response = await proxyEmbedded(post("{}"), "open", config((async () => { throw new Error("connect ECONNREFUSED 10.0.0.1"); }) as unknown as typeof fetch));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("ECONNREFUSED");
  });
});

// ---- the owner's claim calls through the generic proxy ------------------------------------------
describe("the generic proxy and /v1/shopify (C-22)", () => {
  const setup = { ok: true as const, config: { apiUrl: "https://api.example.test", supabaseUrl: "https://x.supabase.test", supabaseAnonKey: "k".repeat(30), trustProxy: false } };
  const status = async (method: string, path: string) => {
    const response = await proxyApiRequest(new Request(`https://hub.example.test/api/${path}`, { method, headers: { host: "hub.example.test", "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) }), path.split("/"), setup);
    return response.status;
  };
  it("lets only the four claim calls through (a signed-out caller reaches the 401, anything else the 404)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [method, path] of [["POST", "v1/shopify/claims"], ["GET", "v1/shopify/claims/current"], ["POST", `v1/shopify/claims/${id}/confirm`], ["DELETE", `v1/shopify/claims/${id}`]] as const)
      expect(await status(method, path), `${method} ${path}`).not.toBe(404);
    for (const [method, path] of [["GET", "v1/shopify/claims"], ["POST", "v1/shopify/claims/current"], ["GET", `v1/shopify/claims/${id}`], ["POST", "v1/shopify/other"], ["GET", "v1/shopify"], ["POST", `v1/shopify/claims/${id}/cancel`], ["DELETE", "v1/shopify/claims/current"]] as const)
      expect(await status(method, path), `${method} ${path}`).toBe(404);
  });
});

// ---- the page script against a fake document ----------------------------------------------------
class FakeNode {
  children: FakeNode[] = [];
  listeners: Record<string, Array<() => void>> = {};
  attrs: Record<string, string> = {};
  text = "";
  disabled = false;
  value = "";
  focused = false;
  constructor(readonly tag: string) {}
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(" "); }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  addEventListener(name: string, handler: () => void) { (this.listeners[name] ??= []).push(handler); }
  appendChild(node: FakeNode) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; this.text = ""; }
  focus() { this.focused = true; }
  click() { for (const handler of this.listeners.click ?? []) handler(); }
  all(): FakeNode[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  querySelector(selector: string): FakeNode | null {
    const match = (node: FakeNode) => (selector.startsWith(".") ? (node.attrs.class ?? "").split(" ").includes(selector.slice(1)) : node.tag === selector);
    return this.children.flatMap((child) => child.all()).find(match) ?? null;
  }
}

function runClient(options: { framed?: boolean; answers: Array<{ status: number; body: unknown }> }) {
  const app = new FakeNode("main");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const opened: Array<{ href: string | null }> = [];
  const document = { getElementById: () => app, createElement: (tag: string) => new FakeNode(tag) };
  const win: { top: object | undefined; self: object | undefined; location: { reload: ReturnType<typeof vi.fn> }; open: ReturnType<typeof vi.fn> } = {
    top: options.framed === false ? undefined : {},
    self: undefined,
    location: { reload: vi.fn() },
    open: vi.fn(() => { const tab = { opener: {}, location: { href: null as string | null }, close: vi.fn() }; opened.push(tab.location); return tab; }),
  };
  if (options.framed === false) { win.top = win.self; }
  const queue = [...options.answers];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 503, body: {} };
    return { status: next.status, ok: next.status >= 200 && next.status < 300, json: async () => next.body };
  };
  const shopify = { idToken: async () => TOKEN };
  new Function(...EMBEDDED_CLIENT_PARAMS, EMBEDDED_CLIENT_SOURCE)(document, win, fetchImpl, shopify);
  return { app, calls, win, opened };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (app: FakeNode) => app.all().map((node) => node.text).join(" | ");
const button = (app: FakeNode, label: string) => app.all().find((node) => node.tag === "button" && node.text === label)!;
const SHOP = { domain: "halden-rowe.myshopify.com", name: "Halden & Rowe" };

describe("the page script", () => {
  it("outside the Shopify admin it asks to open the app from there and calls nothing", async () => {
    const { app, calls } = runClient({ framed: false, answers: [] });
    await settle();
    expect(texts(app)).toContain("Open this app from your Shopify admin");
    expect(calls).toHaveLength(0);
  });

  it("calls open with the session token as a bearer, no cookies and no referrer", async () => {
    const { app, calls } = runClient({ answers: [{ status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } }] });
    await settle();
    expect(calls[0]!.url).toBe("/api/shopify/open");
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.credentials).toBe("omit");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(texts(app)).toContain("Halden & Rowe");
    expect(texts(app)).toContain("Not linked to a ZS Hub yet");
    expect(button(app, "Create my ZS Hub")).toBeDefined();
    expect(button(app, "I already have a hub")).toBeDefined();
  });

  it("shows connection status and a link to the hub for a linked store, and opens the hub from the sign-in link", async () => {
    const { app, calls, opened } = runClient({
      answers: [
        { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "linked", businessName: "Halden & Rowe Jewelers", connection: "active" } } },
        { status: 200, body: { outcome: "ok", url: "https://hub.example.test/sign-in?x=1" } },
      ],
    });
    await settle();
    expect(texts(app)).toContain("Connected");
    expect(texts(app)).toContain("Halden & Rowe Jewelers");
    button(app, "Open ZS Hub").click();
    await settle();
    expect(calls[1]!.url).toBe("/api/shopify/sign-in");
    expect(opened[0]!.href).toBe("https://hub.example.test/sign-in?x=1");
  });

  it("says reconnect is needed when the connection needs reauthorizing", async () => {
    const { app } = runClient({ answers: [{ status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "linked", businessName: "Halden", connection: "reauthorize" } } }] });
    await settle();
    expect(texts(app)).toContain("Reconnect needed");
  });

  it("creates a hub on request, then offers to open it", async () => {
    const { app, calls } = runClient({
      answers: [
        { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } },
        { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      ],
    });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    expect(calls[1]!.url).toBe("/api/shopify/create-hub");
    expect(texts(app)).toContain("owner@example.com");
    expect(button(app, "Open ZS Hub")).toBeDefined();
  });

  it("explains a refused hub creation and lets the person try again", async () => {
    const { app } = runClient({ answers: [{ status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } }, { status: 200, body: { outcome: "not_owner" } }] });
    await settle();
    const create = button(app, "Create my ZS Hub");
    create.click();
    await settle();
    expect(texts(app)).toContain("Only the store owner can create a hub");
    expect(create.disabled).toBe(false);
  });

  it("redeems a code typed by the owner and sends it in the body", async () => {
    const { app, calls } = runClient({
      answers: [
        { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } },
        { status: 200, body: { outcome: "redeemed", businessName: "Halden & Rowe" } },
      ],
    });
    await settle();
    button(app, "I already have a hub").click();
    const input = app.all().find((node) => node.tag === "input")!;
    input.value = "abcde fghj2";
    button(app, "Link this store").click();
    await settle();
    expect(calls[1]!.url).toBe("/api/shopify/redeem-claim");
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ code: "abcde fghj2" });
    expect(texts(app)).toContain("Confirm link");
  });

  it("tells a locked-out caller how long to wait", async () => {
    const { app } = runClient({
      answers: [
        { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } },
        { status: 200, body: { outcome: "locked", retryAfterSeconds: 1800 } },
      ],
    });
    await settle();
    button(app, "I already have a hub").click();
    button(app, "Link this store").click();
    await settle();
    expect(texts(app)).toContain("Try again in 30 minutes");
  });

  it("maps a 401 to a reload prompt and an outage to a retry, and never throws", async () => {
    const expired = runClient({ answers: [{ status: 401, body: {} }] });
    await settle();
    expect(texts(expired.app)).toContain("Your Shopify session expired");
    button(expired.app, "Reload").click();
    expect(expired.win.location.reload).toHaveBeenCalled();
    const down = runClient({ answers: [{ status: 502, body: {} }] });
    await settle();
    expect(texts(down.app)).toContain("not reachable right now");
    expect(button(down.app, "Try again")).toBeDefined();
  });

  it("writes text only: markup in a store name is never parsed", async () => {
    const { app } = runClient({ answers: [{ status: 200, body: { outcome: "ok", shop: { domain: SHOP.domain, name: '<img src=x onerror="alert(1)">' }, link: { state: "none" } } }] });
    await settle();
    expect(app.all().some((node) => node.tag === "img")).toBe(false);
    expect(texts(app)).toContain('<img src=x onerror="alert(1)">');
  });
});
