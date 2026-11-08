// The embedded Shopify app on the dashboard side (docs/requirements/connections.md C-21): the page's HTML and policy,
// the session-token proxy, the claim routes through the generic proxy, and the page script run against a fake document.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SHOPIFY_EMBEDDED_ADDRESS_HEADER, SHOPIFY_EMBEDDED_ADDRESS_SIGNATURE_HEADER, shopifyEmbeddedAddressMessage } from "@zs/contracts";
import nextConfig from "../next.config";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { EMBEDDED_CLIENT_PARAMS, EMBEDDED_CLIENT_SOURCE } from "../src/lib/server/shopify-embedded-client";
import { APP_BRIDGE_URL, embeddedPolicy, frameAncestors, renderEmbeddedPage, shopFromQuery } from "../src/lib/server/shopify-embedded-page";
import { embeddedConfigFrom, proxyEmbedded, type EmbeddedConfig } from "../src/lib/server/shopify-embedded";

const CLIENT_ID = "a".repeat(32);
/** HMAC-SHA256 under "v" x 32 of the address note for 203.0.113.5 and token aaaa.bbbb.cccc; apps/api's test pins the same. */
const ADDRESS_VECTOR = "pyAmXzMBfL5iUyDdYwm13m7UwxccPS8MFUPMJX5Q1Y0";
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

  it("signs the browser's address for the API with the shared secret, bound to the token (C-30)", async () => {
    const secret = "s".repeat(40);
    const sent = async (headers: Record<string, string>, over: Partial<EmbeddedConfig>) => {
      const upstream = okFetch();
      await proxyEmbedded(post("{}", headers), "orders", { ...config(upstream), ...over });
      return new Headers((upstream.mock.calls[0]![1] as RequestInit).headers);
    };
    const signed = await sent({ "x-forwarded-for": "198.51.100.1, 203.0.113.5" }, { trustProxy: true, addressSecret: secret });
    // The right-most entry is the one the trusted proxy appended (as for sign-in); a caller writes the rest.
    expect(signed.get(SHOPIFY_EMBEDDED_ADDRESS_HEADER)).toBe("203.0.113.5");
    expect(signed.get(SHOPIFY_EMBEDDED_ADDRESS_SIGNATURE_HEADER)).toBe(createHmac("sha256", secret).update(shopifyEmbeddedAddressMessage("203.0.113.5", TOKEN)).digest("base64url"));
    // The pinned vector the API's test checks too, so both halves agree on the message.
    expect(createHmac("sha256", "v".repeat(32)).update(shopifyEmbeddedAddressMessage("203.0.113.5", "aaaa.bbbb.cccc")).digest("base64url")).toBe(ADDRESS_VECTOR);
    for (const over of [{ trustProxy: false, addressSecret: secret }, { trustProxy: true, addressSecret: null }]) {
      const plain = await sent({ "x-forwarded-for": "203.0.113.5" }, over);
      expect(plain.get(SHOPIFY_EMBEDDED_ADDRESS_HEADER), JSON.stringify(over)).toBeNull();
      expect(plain.get(SHOPIFY_EMBEDDED_ADDRESS_SIGNATURE_HEADER)).toBeNull();
    }
    expect(embeddedConfigFrom({ ZS_API_URL: "https://api.example.test", CONNECTIONS_EMBEDDED_ADDRESS_SECRET: secret })?.addressSecret).toBe(secret);
    expect(embeddedConfigFrom({ ZS_API_URL: "https://api.example.test", CONNECTIONS_EMBEDDED_ADDRESS_SECRET: "short" })?.addressSecret).toBeNull();
  });

  it("aborts the API call when the browser's request is aborted", async () => {
    let seen: AbortSignal | undefined;
    const upstream = (async (_url: unknown, init?: RequestInit) => { seen = init?.signal ?? undefined; return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))); }) as unknown as typeof fetch;
    const controller = new AbortController();
    const request = new Request(post("{}"), { signal: controller.signal });
    const pending = proxyEmbedded(request, "orders", config(upstream));
    for (let i = 0; i < 50 && seen === undefined; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect((await pending).status).toBe(502);
    expect(seen?.aborted).toBe(true);
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

type Answer = { status: number; body: unknown; headers?: Record<string, string>; wait?: Promise<unknown> } | { hang: true };
interface FakeTimer { id: number; at: number; ms: number; fn: () => void }

/** Runs the page script against a fake document, a fake clock and a timer queue that honours delays and clearTimeout. */
function runClient(options: { framed?: boolean; search?: string; hidden?: boolean; gate?: Promise<void>; orders?: Answer[]; answers: Answer[] }) {
  const app = new FakeNode("main");
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const orderCalls: Array<{ url: string; init: RequestInit }> = [];
  const opened: Array<{ href: string | null }> = [];
  const document = { getElementById: () => app, createElement: (tag: string) => new FakeNode(tag), visibilityState: options.hidden ? "hidden" : "visible" };
  const timers: FakeTimer[] = [];
  const clock = { ms: 1_000_000 };
  let nextId = 0;
  const win: { top: object | undefined; self: object | undefined; Date: { now: () => number }; location: { reload: ReturnType<typeof vi.fn>; search: string }; open: ReturnType<typeof vi.fn>; setTimeout: (fn: () => void, ms: number) => number; clearTimeout: (id: number) => void } = {
    top: options.framed === false ? undefined : {},
    self: undefined,
    location: { reload: vi.fn(), search: options.search ?? "?shop=halden-rowe.myshopify.com&host=abc" },
    Date: { now: () => clock.ms },
    setTimeout: (fn, ms) => { nextId += 1; timers.push({ id: nextId, at: clock.ms + ms, ms, fn }); return nextId; },
    clearTimeout: (id) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); },
    open: vi.fn(() => { const tab = { opener: {}, location: { href: null as string | null }, close: vi.fn() }; opened.push(tab.location); return tab; }),
  };
  if (options.framed === false) { win.top = win.self; }
  const queue = [...options.answers];
  const orderQueue = [...(options.orders ?? [])];
  const fetchImpl = async (url: string, init: RequestInit) => {
    // C-30: the orders read has its own answers and call list, so the sequences the older tests assert stay as they were.
    const isOrders = url.endsWith("/orders");
    (isOrders ? orderCalls : calls).push({ url, init });
    if (isOrders && options.gate) await options.gate;
    const next = (isOrders ? orderQueue : queue).shift() ?? { status: 503, body: {} };
    // A hung request ends only when the page aborts it, as fetch does.
    if ("hang" in next) return new Promise<never>((_, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
    if (next.wait) await next.wait;
    const headers = new Headers(next.headers ?? {});
    return { status: next.status, ok: next.status >= 200 && next.status < 300, headers, json: async () => next.body };
  };
  const shopify = { idToken: async () => TOKEN };
  new Function(...EMBEDDED_CLIENT_PARAMS, EMBEDDED_CLIENT_SOURCE)(document, win, fetchImpl, shopify);
  /** Moves the clock forward, firing every due timer in order and letting its promises settle. */
  const advance = async (ms: number) => {
    const target = clock.ms + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > target) break;
      timers.shift();
      clock.ms = due.at;
      due.fn();
      await settle();
    }
    clock.ms = target;
    await settle();
  };
  const polls = () => timers.filter((timer) => timer.fn.name === "refreshPlan");
  return { app, calls, orderCalls, win, opened, timers, clock, advance, polls };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (app: FakeNode) => app.all().map((node) => node.text).join(" | ");
const button = (app: FakeNode, label: string) => app.all().find((node) => node.tag === "button" && node.text === label)!;
const SHOP = { domain: "halden-rowe.myshopify.com", name: "Halden & Rowe" };

const PLAN_URL = "https://admin.shopify.com/store/halden-rowe/charges/zs-business-connections/pricing_plans";
const link = (app: FakeNode, label: string) => app.all().find((node) => node.tag === "a" && node.text === label);

describe("the footer (C-29)", () => {
  it("links privacy, terms and support, outside the element the script replaces", () => {
    const html = renderEmbeddedPage({ clientId: CLIENT_ID, nonce: NONCE });
    expect(html).toContain('href="https://zerosumsolutions.com/privacy#shopify"');
    expect(html).toContain('href="https://zerosumsolutions.com/terms#shopify"');
    expect(html).toContain('href="mailto:devin@zerosumsolutions.com"');
    expect(html.indexOf("</main>")).toBeLessThan(html.indexOf('<footer class="legal">'));
  });
});


describe("the plan on the page (C-29)", () => {
  const LINKED = { state: "linked", businessName: "Halden", connection: "active" };
  const ok = (plan: unknown, planUrl: string | null | undefined, link: unknown = LINKED) => ({ status: 200, body: { outcome: "ok", shop: SHOP, plan, ...(planUrl === undefined ? {} : { planUrl }), link } });
  const WELCOME = "?embedded=1&host=abc&plan=welcome&plan_handle=hub-solo&shop=halden-rowe.myshopify.com";

  it("with no plan shows Choose a plan to the exact pricing page, opened at the top level", async () => {
    const { app } = runClient({ answers: [ok({ state: "none" }, PLAN_URL)] });
    await settle();
    const choose = link(app, "Choose a plan")!;
    expect(choose.attrs.href).toBe(PLAN_URL);
    expect(choose.attrs.target).toBe("_top");
    expect(link(app, "Change plan")).toBeUndefined();
  });

  it("with a plan shows its name and a Change plan link to the same page", async () => {
    const { app } = runClient({ answers: [ok({ state: "active", name: "Studio" }, PLAN_URL)] });
    await settle();
    expect(texts(app)).toContain("Plan: Studio");
    expect(link(app, "Change plan")!.attrs.href).toBe(PLAN_URL);
    expect(link(app, "Choose a plan")).toBeUndefined();
  });

  it("marks a trial", async () => {
    const { app } = runClient({ answers: [ok({ state: "trial", name: "Solo" }, PLAN_URL)] });
    await settle();
    expect(texts(app)).toContain("Plan: Solo (free trial)");
  });

  it("treats an answer with no plan as no plan, and keeps Choose a plan when the address is there", async () => {
    const { app } = runClient({ answers: [ok(undefined, PLAN_URL)] });
    await settle();
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
  });

  it("shows no plan link when the app handle is unset or the address is not a Shopify admin one", async () => {
    for (const planUrl of [null, undefined, "https://evil.example/store/x/charges/y/pricing_plans", "javascript:alert(1)"]) {
      const { app } = runClient({ answers: [ok({ state: "none" }, planUrl)] });
      await settle();
      expect(app.all().some((node) => node.attrs["data-testid"] === "plan-link"), String(planUrl)).toBe(false);
    }
  });

  it("shows no plan, no Choose a plan and no confirming state for a store without a hub, even after the welcome redirect", async () => {
    for (const search of [undefined, WELCOME]) {
      const { app, polls } = runClient({ ...(search ? { search } : {}), answers: [ok({ state: "none" }, PLAN_URL, { state: "none" })] });
      await settle();
      expect(texts(app)).toContain("Not linked to a ZS Hub yet");
      expect(app.all().some((node) => node.attrs["data-testid"] === "plan-state")).toBe(false);
      expect(texts(app)).not.toContain("Confirming your plan");
      expect(polls()).toHaveLength(0);
    }
  });

  it("offers Choose a plan on the screen shown after the hub is made", async () => {
    const { app, calls } = runClient({ search: WELCOME, answers: [
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
      { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      ok({ state: "none" }, PLAN_URL),
    ] });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open", "/api/shopify/create-hub", "/api/shopify/open"]);
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
    expect(texts(app)).not.toContain("Confirming your plan");
  });

  it("keeps Choose a plan on the created screen when Open ZS Hub is clicked while the plan is read", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, calls } = runClient({ answers: [
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
      { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      { ...ok({ state: "none" }, PLAN_URL), wait: gate },
      { status: 200, body: { outcome: "ok", url: "https://hub.example.test/sign-in" } },
    ] });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    button(app, "Open ZS Hub").click();
    await settle();
    expect(texts(app)).toContain("Your hub opened in a new tab.");
    release();
    await settle();
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open", "/api/shopify/create-hub", "/api/shopify/open", "/api/shopify/sign-in"]);
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
    expect(texts(app)).toContain("Your hub opened in a new tab.");
  });

  it("offers Try again when the read after creating the hub fails, and shows Choose a plan once it works", async () => {
    const { app, calls } = runClient({ answers: [
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
      { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      { status: 503, body: {} },
      ok({ state: "none" }, PLAN_URL),
    ] });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    expect(texts(app)).toContain("Your plan could not be loaded just now.");
    button(app, "Try again").click();
    await settle();
    expect(calls).toHaveLength(4);
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
  });

  it("shows the unlinked screen, not a plan block, when the read after creating the hub finds the store unlinked", async () => {
    const { app } = runClient({ answers: [
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
      { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
    ] });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    expect(texts(app)).toContain("Not linked to a ZS Hub yet");
    expect(link(app, "Choose a plan")).toBeUndefined();
  });

  it("does not confirm a plan after already_linked on a welcome page that first saw no hub", async () => {
    const { app, polls } = runClient({ search: WELCOME, answers: [
      ok({ state: "none" }, PLAN_URL, { state: "none" }),
      { status: 200, body: { outcome: "already_linked" } },
      ok({ state: "none" }, PLAN_URL),
    ] });
    await settle();
    button(app, "Create my ZS Hub").click();
    await settle();
    await settle();
    expect(texts(app)).toContain("Connected");
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
    expect(polls()).toHaveLength(0);
  });

  it("shows the current plan, not a confirming state, when the welcome link brings back a merchant who already has one", async () => {
    const { app, polls } = runClient({ search: WELCOME, answers: [ok({ state: "active", name: "Solo" }, PLAN_URL)] });
    await settle();
    expect(texts(app)).toContain("Plan: Solo");
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(polls()).toHaveLength(0);
  });

  it("reads plan=welcome even when Shopify appends plan_handle, shop, host and embedded, and shows the new plan when it arrives", async () => {
    const { app, calls, polls, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), ok({ state: "active", name: "Pro" }, PLAN_URL)] });
    await settle();
    expect(texts(app)).toContain("Confirming your plan");
    expect(link(app, "Choose a plan")).toBeUndefined();
    expect(polls().map((timer) => timer.ms)).toEqual([30_000]);
    await advance(29_999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
    expect(texts(app)).toContain("Plan: Pro");
    expect(polls()).toHaveLength(0);
  });

  it("keeps trying after failed reads, then shows Choose a plan ten minutes after load", async () => {
    const { app, calls, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), { status: 503, body: {} }, { status: 503, body: {} }] });
    await settle();
    await advance(60_000);
    expect(calls).toHaveLength(3);
    expect(texts(app)).toContain("Confirming your plan");
    await advance(540_000);
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
    // One read per 30 seconds within the window, and none after it: at most 21 in all.
    expect(calls.length).toBeLessThanOrEqual(21);
    await advance(120_000);
    expect(calls.length).toBeLessThanOrEqual(21);
  });

  it("ends the confirming state at the deadline even while a read hangs, and starts no second read meanwhile", async () => {
    const { app, calls, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), { hang: true }] });
    await settle();
    await advance(30_000);
    expect(calls).toHaveLength(2);
    await advance(569_999);
    expect(calls).toHaveLength(2);
    expect(texts(app)).toContain("Confirming your plan");
    await advance(1);
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
  });

  it("measures the ten minutes from load, not from the first good read", async () => {
    const { app, advance } = runClient({ search: WELCOME, answers: [{ status: 503, body: {} }, ok({ state: "none" }, PLAN_URL)] });
    await settle();
    expect(texts(app)).toContain("not reachable");
    await advance(720_000);
    button(app, "Try again").click();
    await settle();
    expect(texts(app)).toContain("Connected");
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
  });

  it("waits at least Retry-After after a 429", async () => {
    const { calls, polls, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), { status: 429, body: {}, headers: { "retry-after": "90" } }] });
    await settle();
    await advance(30_000);
    expect(calls).toHaveLength(2);
    expect(polls().map((timer) => timer.ms)).toEqual([90_000]);
  });

  it("stops polling and asks for a reload when the session cannot be renewed", async () => {
    const { app, calls, polls, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), { status: 401, body: {} }, { status: 401, body: {} }] });
    await settle();
    await advance(30_000);
    expect(calls).toHaveLength(3);
    expect(texts(app)).toContain("Your Shopify session expired");
    expect(button(app, "Reload")).toBeDefined();
    expect(polls()).toHaveLength(0);
    await advance(600_000);
    expect(calls).toHaveLength(3);
    expect(texts(app)).toContain("Your Shopify session expired");
  });

  it("updates only the plan block on a poll, without moving focus or redrawing an unchanged block", async () => {
    const { app, advance } = runClient({ search: WELCOME, answers: [ok({ state: "none" }, PLAN_URL), ok({ state: "none" }, PLAN_URL), ok({ state: "active", name: "Pro" }, PLAN_URL)] });
    await settle();
    const heading = app.all().find((node) => node.tag === "h1")!;
    const open = button(app, "Open ZS Hub");
    const plan = app.all().find((node) => node.attrs["data-testid"] === "plan-state")!;
    const confirming = plan.children[0];
    heading.focused = false;
    await advance(30_000);
    expect(plan.children[0]).toBe(confirming);
    await advance(30_000);
    expect(texts(app)).toContain("Plan: Pro");
    expect(button(app, "Open ZS Hub")).toBe(open);
    expect(app.all().find((node) => node.tag === "h1")).toBe(heading);
    expect(heading.focused).toBe(false);
  });

  it("skips reads while the tab is hidden", async () => {
    const { calls, polls, advance } = runClient({ search: WELCOME, hidden: true, answers: [ok({ state: "none" }, PLAN_URL)] });
    await settle();
    await advance(90_000);
    expect(calls).toHaveLength(1);
    expect(polls()).toHaveLength(1);
  });

  it("pauses polling while Open ZS Hub runs, then goes on and still reaches Choose a plan at the deadline", async () => {
    const { app, calls, advance } = runClient({ search: WELCOME, answers: [
      ok({ state: "none" }, PLAN_URL),
      { hang: true },
    ] });
    await settle();
    button(app, "Open ZS Hub").click();
    await advance(30_000);
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open", "/api/shopify/sign-in"]);
    expect(texts(app)).toContain("Confirming your plan");
    await advance(570_000);
    expect(texts(app)).not.toContain("Confirming your plan");
    expect(link(app, "Choose a plan")!.attrs.href).toBe(PLAN_URL);
  });

  it("goes on polling after Open ZS Hub finishes, and applies the plan when it arrives", async () => {
    const { app, calls, advance } = runClient({ search: WELCOME, answers: [
      ok({ state: "none" }, PLAN_URL),
      { status: 200, body: { outcome: "not_owner" } },
      ok({ state: "active", name: "Pro" }, PLAN_URL),
    ] });
    await settle();
    button(app, "Open ZS Hub").click();
    await settle();
    expect(texts(app)).toContain("Only the store owner can open the hub");
    await advance(30_000);
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open", "/api/shopify/sign-in", "/api/shopify/open"]);
    expect(texts(app)).toContain("Plan: Pro");
    expect(texts(app)).toContain("Only the store owner can open the hub");
  });
});

describe("recent orders on the page (C-30)", () => {
  const LINKED = { state: "linked", businessName: "Halden", connection: "active" };
  const opened = (link: unknown = LINKED) => ({ status: 200, body: { outcome: "ok", shop: SHOP, plan: { state: "active", name: "Solo" }, link } });
  const order = (name: string, over: Record<string, unknown> = {}) => ({ name, createdAt: "2026-11-05T14:30:00.000Z", displayFinancialStatus: "partially_refunded", displayFulfillmentStatus: "unfulfilled", total: { amount: "30.00", currency: "USD" }, ...over });
  const okOrders = (orders: unknown[], summary: unknown = { count: orders.length, total: { amount: "90.50", currency: "USD" } }) => ({ status: 200, body: { outcome: "ok", orders, summary } });
  const cells = (app: FakeNode) => app.all().filter((node) => node.tag === "td" || node.tag === "th").map((node) => node.text);

  it("reads orders after open for a linked store and shows the table and the summary line", async () => {
    const { app, calls, orderCalls } = runClient({ answers: [opened()], orders: [okOrders([order("#1002"), order("#1001", { displayFulfillmentStatus: "fulfilled", displayFinancialStatus: "paid", total: { amount: "60.50", currency: "USD" } })], { count: 2, total: { amount: "90.50", currency: "USD" } })] });
    await settle();
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open"]);
    expect(orderCalls.map((call) => call.url)).toEqual(["/api/shopify/orders"]);
    expect((orderCalls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(orderCalls[0]!.init.credentials).toBe("omit");
    expect(orderCalls[0]!.init.referrerPolicy).toBe("no-referrer");
    expect(texts(app)).toContain("Recent orders");
    expect(cells(app).slice(0, 5)).toEqual(["Order", "Date", "Payment", "Fulfillment", "Total"]);
    expect(cells(app).slice(5, 10)).toEqual(["#1002", "2026-11-05", "Partially refunded", "Unfulfilled", "$30.00"]);
    expect(cells(app).slice(10, 15)).toEqual(["#1001", "2026-11-05", "Paid", "Fulfilled", "$60.50"]);
    const summary = app.all().find((node) => node.attrs["data-testid"] === "orders-summary")!;
    expect(summary.text).toBe("2 orders in the last 60 days, total $90.50");
  });

  it("says one order and no single total when currencies differ", async () => {
    const one = runClient({ answers: [opened()], orders: [okOrders([order("#1")], { count: 1, total: { amount: "30.00", currency: "USD" } })] });
    await settle();
    expect(texts(one.app)).toContain("1 order in the last 60 days, total $30.00");
    const mixed = runClient({ answers: [opened()], orders: [okOrders([order("#1")], { count: 3, total: null })] });
    await settle();
    expect(texts(mixed.app)).toContain("3 orders in the last 60 days, total in more than one currency");
  });

  it("does not read orders for a store without a hub, and shows the reconnect state with orders for a reauthorize link", async () => {
    const none = runClient({ answers: [opened({ state: "none" })] });
    await settle();
    expect(none.calls.map((call) => call.url)).toEqual(["/api/shopify/open"]);
    expect(none.orderCalls).toHaveLength(0);
    expect(texts(none.app)).not.toContain("Recent orders");
    const reauth = runClient({ answers: [opened({ state: "linked", businessName: "Halden", connection: "reauthorize" })], orders: [okOrders([order("#7")])] });
    await settle();
    expect(texts(reauth.app)).toContain("Reconnect needed");
    expect(cells(reauth.app)).toContain("#7");
  });

  it("shows the empty state", async () => {
    const { app } = runClient({ answers: [opened()], orders: [okOrders([], { count: 0, total: null })] });
    await settle();
    expect(texts(app)).toContain("No orders in the last 60 days");
    expect(app.all().some((node) => node.tag === "table")).toBe(false);
  });

  it("shows the error state for any failure and keeps the rest of the page", async () => {
    for (const answer of [{ status: 503, body: {} }, { status: 429, body: {} }, { status: 200, body: { outcome: "unavailable" } }, { status: 200, body: { outcome: "not_linked" } }, { status: 401, body: {} }]) {
      const { app } = runClient({ answers: [opened()], orders: [answer, answer] });
      await settle();
      expect(texts(app), JSON.stringify(answer)).toContain("Orders are not available right now");
      expect(texts(app)).toContain("Connected");
      expect(button(app, "Open ZS Hub")).toBeDefined();
    }
  });

  it("renders an order name as text, never as markup", async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { app } = runClient({ answers: [opened()], orders: [okOrders([order(evil, { displayFinancialStatus: "<script>x</script>" })])] });
    await settle();
    expect(cells(app)).toContain(evil);
    expect(app.all().some((node) => node.tag === "img" || node.tag === "script")).toBe(false);
    expect(EMBEDDED_CLIENT_SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("formats a large amount exactly, without rounding it through a float", async () => {
    const big = { amount: "999999999999999.99", currency: "USD" };
    const { app } = runClient({ answers: [opened()], orders: [okOrders([order("#1", { total: big })], { count: 2, total: { amount: "1000000000000000.00", currency: "USD" } })] });
    await settle();
    expect(cells(app)).toContain("$999,999,999,999,999.99");
    expect(texts(app)).toContain("total $1,000,000,000,000,000.00");
  });

  it("keeps every decimal Shopify sent and never fewer than the currency's own", async () => {
    const { app } = runClient({ answers: [opened()], orders: [okOrders([
      order("#1", { total: { amount: "1.234567", currency: "USD" } }),
      order("#2", { total: { amount: "10.5", currency: "USD" } }),
      order("#3", { total: { amount: "1500", currency: "JPY" } }),
    ], { count: 3, total: { amount: "11.734567", currency: "USD" } })] });
    await settle();
    expect(cells(app)).toEqual(expect.arrayContaining(["$1.234567", "$10.50", "¥1,500"]));
    expect(texts(app)).toContain("total $11.734567");
  });

  it("gives up on a hung read at its 15 s deadline: the request is aborted and the slot says not available", async () => {
    const { app, orderCalls, advance } = runClient({ answers: [opened()], orders: [{ hang: true }] });
    await settle();
    expect(orderCalls[0]!.init.signal?.aborted).toBe(false);
    await advance(14_999);
    expect(texts(app)).toContain("Loading recent orders");
    await advance(1);
    expect(texts(app)).toContain("Orders are not available right now");
    expect(texts(app)).not.toContain("Loading recent orders");
    expect(orderCalls[0]!.init.signal?.aborted).toBe(true);
  });

  it("aborts the orders read when the page moves to another screen", async () => {
    const confirming = { status: 200, body: { outcome: "ok", shop: SHOP, plan: { state: "none" }, link: LINKED } };
    const unlinked = { status: 200, body: { outcome: "ok", shop: SHOP, plan: { state: "none" }, link: { state: "none" } } };
    const { app, orderCalls, advance } = runClient({ search: "?plan=welcome", answers: [confirming, unlinked], orders: [{ hang: true }] });
    await settle();
    expect(orderCalls[0]!.init.signal?.aborted).toBe(false);
    await advance(30_000);
    expect(texts(app)).toContain("Not linked to a ZS Hub yet");
    expect(orderCalls[0]!.init.signal?.aborted).toBe(true);
    expect(texts(app)).not.toContain("Orders are not available");
  });

  it("still shows the orders when Open ZS Hub is clicked while they are read (Open ZS Hub keeps the screen)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app } = runClient({ gate, answers: [opened(), { status: 200, body: { outcome: "ok", url: "https://hub.example.test/sign-in" } }], orders: [okOrders([order("#LATE")])] });
    await settle();
    expect(texts(app)).toContain("Loading recent orders");
    button(app, "Open ZS Hub").click();
    await settle();
    release();
    await settle();
    expect(cells(app)).toContain("#LATE");
    expect(texts(app)).not.toContain("Loading recent orders");
    expect(texts(app)).toContain("Your hub opened in a new tab.");
  });

  it("drops an orders answer that lands after the page moved to another screen", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const confirming = { status: 200, body: { outcome: "ok", shop: SHOP, plan: { state: "none" }, link: LINKED } };
    const unlinked = { status: 200, body: { outcome: "ok", shop: SHOP, plan: { state: "none" }, link: { state: "none" } } };
    const { app, advance } = runClient({ search: "?plan=welcome", gate, answers: [confirming, unlinked], orders: [okOrders([order("#LATE")])] });
    await settle();
    expect(texts(app)).toContain("Loading recent orders");
    await advance(30_000);
    expect(texts(app)).toContain("Not linked to a ZS Hub yet");
    release();
    await settle();
    expect(cells(app)).not.toContain("#LATE");
    expect(texts(app)).not.toContain("Recent orders");
  });

  it("loads the orders on the screen shown after the hub is made, once the read confirms the link", async () => {
    const { app, calls, orderCalls } = runClient({ answers: [
      opened({ state: "none" }),
      { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
      opened(),
    ], orders: [okOrders([order("#NEW")])] });
    await settle();
    expect(orderCalls).toHaveLength(0);
    button(app, "Create my ZS Hub").click();
    await settle();
    expect(calls.map((call) => call.url)).toEqual(["/api/shopify/open", "/api/shopify/create-hub", "/api/shopify/open"]);
    expect(orderCalls).toHaveLength(1);
    expect(texts(app)).toContain("Your hub is ready");
    expect(cells(app)).toContain("#NEW");
  });

  it("reads no orders after the hub is made when the read finds the store unlinked or fails", async () => {
    for (const third of [opened({ state: "none" }), { status: 503, body: {} }]) {
      const { app, calls, orderCalls } = runClient({ answers: [
        opened({ state: "none" }),
        { status: 200, body: { outcome: "created", businessName: "Halden & Rowe", ownerEmail: "owner@example.com" } },
        third,
      ] });
      await settle();
      button(app, "Create my ZS Hub").click();
      await settle();
      expect(calls, JSON.stringify(third)).toHaveLength(3);
      expect(orderCalls).toHaveLength(0);
      expect(texts(app)).not.toContain("Recent orders");
    }
  });
});

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

  it("drops a code answer that lands after the merchant chose Back", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app } = runClient({
      answers: [
        { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } },
        { status: 200, body: { outcome: "redeemed", businessName: "Halden & Rowe" }, wait: gate },
      ],
    });
    await settle();
    button(app, "I already have a hub").click();
    button(app, "Link this store").click();
    await settle();
    button(app, "Back").click();
    release();
    await settle();
    expect(texts(app)).toContain("Not linked to a ZS Hub yet");
    expect(texts(app)).not.toContain("Almost done");
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
    const expired = runClient({ answers: [{ status: 401, body: {} }, { status: 401, body: {} }] });
    await settle();
    expect(expired.calls).toHaveLength(2);
    expect(texts(expired.app)).toContain("Your Shopify session expired");
    button(expired.app, "Reload").click();
    expect(expired.win.location.reload).toHaveBeenCalled();
    const down = runClient({ answers: [{ status: 502, body: {} }] });
    await settle();
    expect(texts(down.app)).toContain("not reachable right now");
    expect(button(down.app, "Try again")).toBeDefined();
  });

  it("retries once with a fresh session token after a 401 and carries on when the retry works", async () => {
    const { app, calls } = runClient({ answers: [{ status: 401, body: {} }, { status: 200, body: { outcome: "ok", shop: SHOP, link: { state: "none" } } }] });
    await settle();
    expect(calls).toHaveLength(2);
    expect(texts(app)).not.toContain("session expired");
    expect(texts(app)).toContain("Halden & Rowe");
  });

  it("writes text only: markup in a store name is never parsed", async () => {
    const { app } = runClient({ answers: [{ status: 200, body: { outcome: "ok", shop: { domain: SHOP.domain, name: '<img src=x onerror="alert(1)">' }, link: { state: "none" } } }] });
    await settle();
    expect(app.all().some((node) => node.tag === "img")).toBe(false);
    expect(texts(app)).toContain('<img src=x onerror="alert(1)">');
  });
});
