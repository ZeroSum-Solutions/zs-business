import { describe, expect, it } from "vitest";
import { proxyApiRequest, proxyConfigFromEnv, type ApiProxyConfig } from "../src/lib/server/api-proxy";
import { DEFAULT_SESSION_TTL_SECONDS, issueSessionValue, pilotGateFromEnv, SESSION_COOKIE, type PilotGateConfig } from "../src/lib/server/pilot-gate";
import { GATE, sessionCookieHeader } from "./helpers/gate";

const ORIGIN = "http://localhost:3200";
const TOKEN = "server-only-token";

function recorder(status = 200, body: unknown = { items: [] }, gate: PilotGateConfig = GATE) {
  const calls: { url: string; init: RequestInit }[] = [];
  const config: ApiProxyConfig = {
    apiUrl: "http://api.internal:8787/",
    token: TOKEN,
    gate: { ok: true, config: gate },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(body, { status, headers: { "Set-Cookie": "upstream=1" } });
    },
  };
  return { calls, config };
}

// Every request carries a valid pilot session unless a test says otherwise.
const signedIn = (headers: Record<string, string>) => ({ Cookie: sessionCookieHeader(), ...headers });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/${path}`, { headers: signedIn(headers) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/${path}`, { method: "POST", body: JSON.stringify(body), headers: signedIn({ "Content-Type": "application/json", ...headers }) });

describe("api proxy pilot gate", () => {
  const anonymous = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers });

  it("refuses a request with no session cookie and never sends the token", async () => {
    const { calls, config } = recorder();
    // No Cookie, Authorization or Origin: the request Sol's review used to read 12 contacts.
    const response = await proxyApiRequest(anonymous(), ["v1", "crm", "contacts"], config);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("Unauthorized");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // A bearer token from the browser is no substitute for the cookie.
    expect((await proxyApiRequest(anonymous({ Authorization: `Bearer ${TOKEN}` }), ["v1", "crm", "contacts"], config)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a cookie with a bad signature", async () => {
    const { calls, config } = recorder();
    const good = issueSessionValue(GATE).value;
    const parts = good.split(".");
    const cases = [
      `${parts.slice(0, 3).join(".")}.${"A".repeat(43)}`,
      // Signed with another secret.
      issueSessionValue({ ...GATE, sessionSecret: "z".repeat(40) }).value,
      // Signed under another access code.
      issueSessionValue({ ...GATE, accessCode: "another-code-0123456789" }).value,
      // A later expiry pasted onto a real signature.
      [parts[0], String(Number(parts[1]) + 3600), parts[2], parts[3]].join("."),
      "v1.garbage",
      "",
    ];
    for (const value of cases) {
      const response = await proxyApiRequest(anonymous({ Cookie: `${SESSION_COOKIE}=${value}` }), ["v1", "crm", "contacts"], config);
      expect(response.status, value).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an expired cookie", async () => {
    const { calls, config } = recorder();
    const issued = new Date(Date.now() - (GATE.ttlSeconds + 1) * 1000);
    const response = await proxyApiRequest(anonymous({ Cookie: sessionCookieHeader(GATE, issued) }), ["v1", "crm", "contacts"], config);
    expect(response.status).toBe(401);
    // A cookie signed under a longer TTL than the server now allows is expired too.
    const longer = sessionCookieHeader({ ...GATE, ttlSeconds: GATE.ttlSeconds * 2 });
    expect((await proxyApiRequest(anonymous({ Cookie: longer }), ["v1", "crm", "contacts"], config)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("passes a valid cookie, and only the token goes upstream", async () => {
    const { calls, config } = recorder();
    const response = await proxyApiRequest(anonymous({ Cookie: `other=1; ${sessionCookieHeader()}` }), ["v1", "crm", "contacts"], config);
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("cookie")).toBeNull();
  });

  it("refuses to serve live mode without a long enough access code and session secret", async () => {
    const live = { ZS_API_URL: "http://localhost:8787", ZS_API_TOKEN: "t" };
    const strong = { DASHBOARD_ACCESS_CODE: GATE.accessCode, DASHBOARD_SESSION_SECRET: GATE.sessionSecret };
    expect(pilotGateFromEnv({ ...live, ...strong })).toEqual({ ok: true, config: { ...GATE, ttlSeconds: DEFAULT_SESSION_TTL_SECONDS } });
    expect(pilotGateFromEnv({ ...strong, DASHBOARD_SESSION_TTL_SECONDS: "3600", DASHBOARD_TRUST_PROXY: "1" }))
      .toEqual({ ok: true, config: { ...GATE, ttlSeconds: 3600, trustProxy: true } });
    for (const env of [
      { DASHBOARD_SESSION_SECRET: GATE.sessionSecret },
      { ...strong, DASHBOARD_ACCESS_CODE: "x".repeat(15) },
      { ...strong, DASHBOARD_SESSION_SECRET: "y".repeat(31) },
      { ...strong, DASHBOARD_SESSION_TTL_SECONDS: "12h" },
      { ...strong, DASHBOARD_SESSION_TTL_SECONDS: "0" },
    ]) {
      const setup = pilotGateFromEnv(env);
      expect(setup.ok, JSON.stringify(env)).toBe(false);
    }
    expect(pilotGateFromEnv({})).toEqual({ ok: false, problem: expect.stringMatching(/DASHBOARD_ACCESS_CODE of at least 16/) });

    const { calls } = recorder();
    const config = { ...proxyConfigFromEnv(live)!, fetch: async () => { calls.push({ url: "", init: {} }); return Response.json({}); } };
    expect(config.gate.ok).toBe(false);
    const response = await proxyApiRequest(get("v1/crm/contacts"), ["v1", "crm", "contacts"], config);
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("api proxy", () => {
  it("adds the server's token and forwards only the API headers", async () => {
    const { calls, config } = recorder();
    const response = await proxyApiRequest(
      get("v1/booking/slots?resourceId=r1&from=a", { Authorization: "Bearer from-the-browser", Cookie: `session=x; ${sessionCookieHeader()}`, "Sec-Fetch-Site": "same-origin" }),
      ["v1", "booking", "slots"], config,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.internal:8787/v1/booking/slots?resourceId=r1&from=a");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("cookie")).toBeNull();
  });

  it("passes the body, the Idempotency-Key and the API's status and error body through", async () => {
    const error = { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "overlap" } } };
    const { calls, config } = recorder(409, error);
    const response = await proxyApiRequest(
      post("v1/booking/bookings", { resourceId: "r1", startsAt: "2026-10-20T14:00:00.000Z" }, { "Idempotency-Key": "k-1", Origin: ORIGIN }),
      ["v1", "booking", "bookings"], config,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(error);
    const sent = calls[0]!;
    expect(sent.init.method).toBe("POST");
    expect(new Headers(sent.init.headers).get("idempotency-key")).toBe("k-1");
    expect(JSON.parse(new TextDecoder().decode(sent.init.body as ArrayBuffer))).toEqual({ resourceId: "r1", startsAt: "2026-10-20T14:00:00.000Z" });
  });

  it("refuses cross-site callers, so another page cannot spend the token", async () => {
    const { calls, config } = recorder();
    const cases = [
      post("v1/crm/contacts", {}, { Origin: "https://evil.example" }),
      post("v1/crm/contacts", {}, { "Sec-Fetch-Site": "cross-site" }),
      get("v1/crm/deals", { "Sec-Fetch-Site": "same-site" }),
    ];
    for (const request of cases) {
      const response = await proxyApiRequest(request, ["v1", "crm", request.method === "GET" ? "deals" : "contacts"], config);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("Forbidden");
    }
    // A form post can only send simple content types.
    const form = new Request(`${ORIGIN}/api/v1/crm/contacts`, { method: "POST", body: "email=a", headers: signedIn({ "Content-Type": "text/plain" }) });
    expect((await proxyApiRequest(form, ["v1", "crm", "contacts"], config)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("judges the origin by the Host the browser used, not the URL Next builds", async () => {
    // `next start --hostname 127.0.0.1` hands route handlers http://localhost:<port> URLs.
    const { calls, config } = recorder(201, {});
    const fromLoopback = new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: signedIn({ "Content-Type": "application/json", Host: "127.0.0.1:3218", Origin: "http://127.0.0.1:3218", "Sec-Fetch-Site": "same-origin" }),
    });
    expect((await proxyApiRequest(fromLoopback, ["v1", "crm", "contacts"], config)).status).toBe(201);
    const spoofed = new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: signedIn({ "Content-Type": "application/json", Host: "127.0.0.1:3218", Origin: "http://localhost:3218" }),
    });
    expect((await proxyApiRequest(spoofed, ["v1", "crm", "contacts"], config)).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("honours X-Forwarded-Host only behind a trusted proxy", async () => {
    // Behind a reverse proxy the URL and Host are internal and X-Forwarded-Host is public.
    const behindProxy = () => new Request("http://localhost:3000/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: signedIn({ "Content-Type": "application/json", Host: "localhost:3000", "X-Forwarded-Host": "app.example.com", Origin: "https://app.example.com" }),
    });
    // Without DASHBOARD_TRUST_PROXY=1 anyone can send X-Forwarded-Host, so Host decides.
    const forged = () => new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: signedIn({ "Content-Type": "application/json", Host: "127.0.0.1:3218", "X-Forwarded-Host": "evil.example", Origin: "https://evil.example" }),
    });
    const direct = recorder(201, {});
    expect((await proxyApiRequest(forged(), ["v1", "crm", "contacts"], direct.config)).status).toBe(403);
    expect((await proxyApiRequest(behindProxy(), ["v1", "crm", "contacts"], direct.config)).status).toBe(403);
    expect(direct.calls).toHaveLength(0);

    const trusted = recorder(201, {}, { ...GATE, trustProxy: true });
    expect((await proxyApiRequest(behindProxy(), ["v1", "crm", "contacts"], trusted.config)).status).toBe(201);
    expect(trusted.calls).toHaveLength(1);
  });

  it("refuses any Sec-Fetch-Site but same-origin, with or without an Origin", async () => {
    const { calls, config } = recorder();
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await proxyApiRequest(get("v1/crm/deals", { "Sec-Fetch-Site": site }), ["v1", "crm", "deals"], config)).status, site).toBe(403);
      expect((await proxyApiRequest(post("v1/crm/contacts", {}, { "Sec-Fetch-Site": site, Origin: ORIGIN }), ["v1", "crm", "contacts"], config)).status, site).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect((await proxyApiRequest(get("v1/crm/deals", { "Sec-Fetch-Site": "same-origin" }), ["v1", "crm", "deals"], config)).status).toBe(200);
  });

  it("only forwards the booking and CRM routes", async () => {
    const { calls, config } = recorder();
    for (const path of [["healthz"], ["v1", "admin", "users"], ["v1", "crm"], ["v1", "crm", ".."], ["v2", "crm", "deals"]]) {
      expect((await proxyApiRequest(get(path.join("/")), path, config)).status, path.join("/")).toBe(404);
    }
    const put = new Request(`${ORIGIN}/api/v1/crm/deals`, { method: "PUT", headers: signedIn({}) });
    expect((await proxyApiRequest(put, ["v1", "crm", "deals"], config)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when no API is configured and 502 when the API is unreachable", async () => {
    expect((await proxyApiRequest(get("v1/crm/deals"), ["v1", "crm", "deals"], null)).status).toBe(503);
    const down: ApiProxyConfig = { apiUrl: "http://api.internal", token: TOKEN, gate: { ok: true, config: GATE }, fetch: async () => { throw new TypeError("fetch failed"); } };
    expect((await proxyApiRequest(get("v1/crm/deals"), ["v1", "crm", "deals"], down)).status).toBe(502);
  });

  it("reads its settings from server-only env names", () => {
    const env = { ZS_API_URL: "http://localhost:8787", ZS_API_TOKEN: "t", DASHBOARD_ACCESS_CODE: GATE.accessCode, DASHBOARD_SESSION_SECRET: GATE.sessionSecret };
    expect(proxyConfigFromEnv(env)).toEqual({ apiUrl: "http://localhost:8787", token: "t", gate: { ok: true, config: GATE } });
    expect(proxyConfigFromEnv({ ZS_API_URL: "http://localhost:8787" })).toBeNull();
    expect(proxyConfigFromEnv({ NEXT_PUBLIC_API_URL: "http://localhost:8787", NEXT_PUBLIC_API_TOKEN: "t" })).toBeNull();
  });
});
