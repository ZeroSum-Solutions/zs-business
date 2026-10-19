import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostingModeGuard, hostingModeProblem } from "../src/lib/server/hosting-mode";
import { config as proxyConfig, proxy } from "../src/proxy";

const LIVE = { ZS_API_URL: "https://api.example.test", ZS_API_TOKEN: "t" };

describe("hosting mode guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes when build and server agree", () => {
    expect(hostingModeProblem("live", LIVE)).toBeNull();
    expect(hostingModeProblem("demo", {})).toBeNull();
    expect(hostingModeProblem("demo", { ZS_API_URL: "  " })).toBeNull();
    expect(hostingModeGuard("demo", {}, () => undefined)).toBeNull();
  });

  it("refuses a demo build started with live settings, with a 500 and one log line", async () => {
    const log = vi.fn();
    const response = hostingModeGuard("demo", LIVE, log)!;
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toMatch(/built for demo mode .* server has ZS_API_URL set/);
    hostingModeGuard("demo", LIVE, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/Hosting mode mismatch/);
  });

  it("refuses a live build started without ZS_API_URL", async () => {
    const response = hostingModeGuard("live", {}, () => undefined)!;
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/built for live mode .* server has no ZS_API_URL/);
    // An unset baked value is a demo build.
    expect(hostingModeProblem(undefined, LIVE)).toMatch(/built for demo mode/);
  });

  it("never puts the API URL or token in the reply", async () => {
    const text = await hostingModeGuard("demo", LIVE, () => undefined)!.text();
    expect(text).not.toContain(LIVE.ZS_API_URL);
    expect(text).not.toContain("api.example.test");
  });

  it("the proxy refuses in both directions and passes otherwise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "demo");
    vi.stubEnv("ZS_API_URL", LIVE.ZS_API_URL);
    expect(proxy().status).toBe(500);
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "live");
    vi.stubEnv("ZS_API_URL", "");
    expect(proxy().status).toBe(500);
    vi.stubEnv("ZS_API_URL", LIVE.ZS_API_URL);
    const next = proxy();
    expect(next.status).toBe(200);
    expect(next.headers.get("x-middleware-next")).toBe("1");
  });

  it("the proxy skips /api, so Next does not buffer request bodies before the routes' own limits", () => {
    // Next anchors each matcher at both ends.
    const matchers = proxyConfig.matcher.map((source) => new RegExp(`^${source}$`));
    const proxied = (path: string) => matchers.some((matcher) => matcher.test(path));
    for (const path of ["/", "/inbox", "/sign-in", "/auth/confirm", "/sw.js"]) expect(proxied(path), path).toBe(true);
    for (const path of ["/api/sign-in", "/api/sign-out", "/api/session", "/api/v1/crm/contacts", "/_next/static/chunk.js"])
      expect(proxied(path), path).toBe(false);
  });

  it("every /api route runs the guard itself, in both directions, before its handler", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const routes = {
      session: await import("../src/app/api/session/route"),
      signIn: await import("../src/app/api/sign-in/route"),
      signOut: await import("../src/app/api/sign-out/route"),
      proxy: await import("../src/app/api/[...path]/route"),
    };
    const context = { params: Promise.resolve({ path: ["v1", "crm", "contacts"] }) };
    const post = (path: string) => new Request(`http://127.0.0.1${path}`, { method: "POST", body: "{}" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const [built, url] of [["demo", LIVE.ZS_API_URL], ["live", ""]] as const) {
      vi.stubEnv("NEXT_PUBLIC_API_MODE", built);
      vi.stubEnv("ZS_API_URL", url);
      const answers = await Promise.all([
        routes.session.GET(new Request("http://127.0.0.1/api/session")),
        routes.signIn.POST(post("/api/sign-in")),
        routes.signOut.POST(post("/api/sign-out")),
        routes.proxy.GET(new Request("http://127.0.0.1/api/v1/crm/contacts"), context),
        routes.proxy.POST(post("/api/v1/crm/contacts"), context),
        routes.proxy.DELETE(new Request("http://127.0.0.1/api/v1/crm/contacts", { method: "DELETE" }), context),
      ]);
      for (const answer of answers) {
        expect(answer.status).toBe(500);
        expect(await answer.text()).toMatch(/Dashboard misconfigured/);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no /api route file escapes the guard: every handler it exports refuses a mismatch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_PUBLIC_API_MODE", "demo");
    vi.stubEnv("ZS_API_URL", LIVE.ZS_API_URL);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const apiDir = new URL("../src/app/api/", import.meta.url);
    const files = readdirSync(apiDir, { recursive: true, encoding: "utf8" }).filter((file) => /(^|\/)route\.ts$/.test(file));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const context = { params: Promise.resolve({ path: ["v1", "me"] }) };
    let handlers = 0;
    for (const file of files) {
      const route = (await import(new URL(file, apiDir).href)) as Record<string, unknown>;
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const handler = route[method];
        if (typeof handler !== "function") continue;
        handlers += 1;
        const body = method === "GET" || method === "HEAD" ? null : "{}";
        const answer = await (handler as (request: Request, context: unknown) => Promise<Response>)(
          new Request("http://127.0.0.1/api/x", { method, body }), context);
        expect(answer.status, `${method} ${file}`).toBe(500);
      }
    }
    expect(handlers).toBeGreaterThanOrEqual(6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
