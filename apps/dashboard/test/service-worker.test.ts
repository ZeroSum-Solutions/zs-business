import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.join(import.meta.dirname, "../public/sw.js"), "utf8");
const ORIGIN = "https://dash.example";

type Listener = (event: unknown) => void;
type Reply = { body?: string; type?: string; status?: number; responseType?: ResponseType; headers?: Record<string, string> };

/** A response as the browser would hand it to the worker, including its `type`. */
function reply({ body = "", type = "text/html", status = 200, responseType = "basic", headers = {} }: Reply, url: string): Response {
  const response = new Response(body, { status, headers: { "content-type": type, ...headers } });
  Object.defineProperty(response, "type", { value: responseType });
  Object.defineProperty(response, "url", { value: url });
  // A real clone would drop the overridden `type`, so build an identical reply instead.
  Object.defineProperty(response, "clone", { value: () => reply({ body, type, status, responseType, headers }, url) });
  return response;
}

/** Load sw.js into a fake worker scope with in-memory caches and a scripted network. */
function loadWorker(routes: Record<string, Reply>, existingCaches: string[] = []) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, Response>>(existingCaches.map((name) => [name, new Map()]));
  const fetched: string[] = [];
  const keyOf = (input: Request | string) => new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      async put(input: Request | string, response: Response) { store.set(keyOf(input), response); },
      async match(input: Request | string) { return store.get(keyOf(input))?.clone(); },
      async keys() { return [...store.keys()]; },
    };
  };
  const scope = {
    location: new URL(`${ORIGIN}/sw.js?v=build-42`),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Set,
    Promise,
    Error,
    caches: {
      open: async (name: string) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: async (input: Request | string) => {
      const url = keyOf(input);
      fetched.push(url);
      const route = routes[new URL(url).pathname];
      if (!route) throw new TypeError("network down");
      return reply(route, url);
    },
  });
  vm.runInContext(SOURCE, context);

  async function dispatch(type: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    listeners.get(type)!({ ...extra, waitUntil: (promise: Promise<unknown>) => waits.push(promise), respondWith: (promise: Promise<Response>) => { responded = promise; } });
    await Promise.all(waits);
    return responded as Promise<Response> | null;
  }
  const cached = (name = "zs-shell-build-42") => [...(stores.get(name)?.keys() ?? [])].map((url) => new URL(url).pathname).sort();
  const request = (pathname: string, { mode, ...init }: RequestInit & { mode?: RequestMode } = {}) => {
    // Scripts cannot construct a "navigate" request, so set the mode after the fact.
    const value = new Request(new URL(pathname, ORIGIN), init);
    if (mode) Object.defineProperty(value, "mode", { value: mode });
    return value;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { dispatch, cached, stores, fetched, request, settle };
}

const PAGE = '<link rel="stylesheet" href="/_next/static/css/app.css"><script src="/_next/static/chunks/main.js"></script><link rel="preload" href="/_next/static/media/font.woff2"><img src="/_next/static/media/logo.png">';
const SHELL: Record<string, Reply> = {
  "/": { body: PAGE },
  "/calendar": { body: PAGE },
  "/_next/static/css/app.css": { type: "text/css; charset=utf-8", body: "@font-face{src:url(/_next/static/media/font.woff2)} .a{background:url(/_next/static/chunks/extra.js)}" },
  "/_next/static/chunks/main.js": { type: "application/javascript; charset=utf-8" },
  "/_next/static/chunks/extra.js": { type: "text/javascript" },
  "/_next/static/media/font.woff2": { type: "font/woff2" },
  "/_next/static/media/logo.png": { type: "image/png" },
};

describe("service worker", () => {
  it("names its cache after the build and deletes older shell caches on activate", async () => {
    const worker = loadWorker(SHELL, ["zs-shell-build-41", "zs-shell-dev", "someone-elses-cache"]);
    await worker.dispatch("install");
    await worker.dispatch("activate");
    expect([...worker.stores.keys()].sort()).toEqual(["someone-elses-cache", "zs-shell-build-42"]);
  });

  it("precaches only HTML, JavaScript and CSS, never fonts or images", async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch("install");
    expect(worker.cached()).toEqual(["/", "/_next/static/chunks/extra.js", "/_next/static/chunks/main.js", "/_next/static/css/app.css", "/calendar"]);
    expect(worker.fetched.map((url) => new URL(url).pathname)).not.toContain("/_next/static/media/logo.png");
  });

  it("refuses responses that are not basic, not OK, the wrong type, or marked no-store or private", async () => {
    const worker = loadWorker({
      ...SHELL,
      "/inbox": { body: PAGE, responseType: "cors" },
      "/site": { body: PAGE, status: 500 },
      "/agents": { body: "{}", type: "application/json" },
      "/account/plan": { body: PAGE, headers: { "cache-control": "no-store" } },
      "/account/settings": { body: PAGE, headers: { "cache-control": "private, max-age=60" } },
    });
    await worker.dispatch("install");
    for (const pathname of ["/inbox", "/site", "/agents", "/account/plan", "/account/settings"]) expect(worker.cached()).not.toContain(pathname);
    expect(worker.cached()).toContain("/");
  });

  it("leaves /api, /v1, authorized, non-GET and cross-origin requests to the network", async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch("install");
    const passThrough = [
      worker.request("/api/v1/booking/resources"),
      worker.request("/api/session"),
      worker.request("/v1/crm/contacts"),
      worker.request("/_next/static/chunks/main.js", { headers: { Authorization: "Bearer x" } }),
      worker.request("/calendar", { method: "POST", body: "{}" }),
      new Request("https://cdn.example/_next/static/chunks/main.js"),
    ];
    for (const request of passThrough) expect(await worker.dispatch("fetch", { request }), request.url).toBeNull();
  });

  it("does not store a JSON or no-store answer to a page navigation", async () => {
    const worker = loadWorker({ ...SHELL, "/customers": { body: "{}", type: "application/json" }, "/inbox": { body: PAGE, headers: { "cache-control": "no-store" } } });
    await worker.dispatch("install");
    for (const pathname of ["/customers", "/inbox"]) {
      const response = await worker.dispatch("fetch", { request: worker.request(pathname, { mode: "navigate" }) });
      expect((await response!).status).toBe(200);
    }
    await worker.settle();
    expect(worker.cached()).not.toContain("/customers");
    expect(worker.cached()).not.toContain("/inbox");
  });

  it("serves cached build files first and the cached shell when a page is offline", async () => {
    const worker = loadWorker(SHELL);
    await worker.dispatch("install");
    const before = worker.fetched.length;
    const script = await worker.dispatch("fetch", { request: worker.request("/_next/static/chunks/main.js") });
    expect((await script!).headers.get("content-type")).toContain("javascript");
    expect(worker.fetched.length).toBe(before);

    const offline = await worker.dispatch("fetch", { request: worker.request("/not-cached", { mode: "navigate" }) });
    expect(await (await offline!).text()).toBe(PAGE);
  });
});
