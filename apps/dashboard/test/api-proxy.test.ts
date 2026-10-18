import { describe, expect, it } from "vitest";
import { proxyApiRequest, proxyConfigFromEnv, type ApiProxyConfig } from "../src/lib/server/api-proxy";

const ORIGIN = "http://localhost:3200";
const TOKEN = "server-only-token";

function recorder(status = 200, body: unknown = { items: [] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const config: ApiProxyConfig = {
    apiUrl: "http://api.internal:8787/",
    token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(body, { status, headers: { "Set-Cookie": "upstream=1" } });
    },
  };
  return { calls, config };
}

const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

describe("api proxy", () => {
  it("adds the server's token and forwards only the API headers", async () => {
    const { calls, config } = recorder();
    const response = await proxyApiRequest(
      get("v1/booking/slots?resourceId=r1&from=a", { Authorization: "Bearer from-the-browser", Cookie: "session=x", "Sec-Fetch-Site": "same-origin" }),
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
    const form = new Request(`${ORIGIN}/api/v1/crm/contacts`, { method: "POST", body: "email=a", headers: { "Content-Type": "text/plain" } });
    expect((await proxyApiRequest(form, ["v1", "crm", "contacts"], config)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("judges the origin by the Host the browser used, not the URL Next builds", async () => {
    // `next start --hostname 127.0.0.1` hands route handlers http://localhost:<port> URLs;
    // behind a reverse proxy the URL is the internal address and X-Forwarded-Host is public.
    const { calls, config } = recorder(201, {});
    const fromLoopback = new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3218", Origin: "http://127.0.0.1:3218", "Sec-Fetch-Site": "same-origin" },
    });
    const behindProxy = new Request("http://localhost:3000/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: { "Content-Type": "application/json", Host: "localhost:3000", "X-Forwarded-Host": "app.example.com", Origin: "https://app.example.com" },
    });
    for (const request of [fromLoopback, behindProxy]) {
      expect((await proxyApiRequest(request, ["v1", "crm", "contacts"], config)).status).toBe(201);
    }
    const spoofed = new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1:3218", Origin: "http://localhost:3218" },
    });
    expect((await proxyApiRequest(spoofed, ["v1", "crm", "contacts"], config)).status).toBe(403);
    expect(calls).toHaveLength(2);
  });

  it("only forwards the booking and CRM routes", async () => {
    const { calls, config } = recorder();
    for (const path of [["healthz"], ["v1", "admin", "users"], ["v1", "crm"], ["v1", "crm", ".."], ["v2", "crm", "deals"]]) {
      expect((await proxyApiRequest(get(path.join("/")), path, config)).status, path.join("/")).toBe(404);
    }
    const put = new Request(`${ORIGIN}/api/v1/crm/deals`, { method: "PUT" });
    expect((await proxyApiRequest(put, ["v1", "crm", "deals"], config)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("answers 503 when no API is configured and 502 when the API is unreachable", async () => {
    expect((await proxyApiRequest(get("v1/crm/deals"), ["v1", "crm", "deals"], null)).status).toBe(503);
    const down: ApiProxyConfig = { apiUrl: "http://api.internal", token: TOKEN, fetch: async () => { throw new TypeError("fetch failed"); } };
    expect((await proxyApiRequest(get("v1/crm/deals"), ["v1", "crm", "deals"], down)).status).toBe(502);
  });

  it("reads its settings from server-only env names", () => {
    expect(proxyConfigFromEnv({ ZS_API_URL: "http://localhost:8787", ZS_API_TOKEN: "t" })).toEqual({ apiUrl: "http://localhost:8787", token: "t" });
    expect(proxyConfigFromEnv({ ZS_API_URL: "http://localhost:8787" })).toBeNull();
    expect(proxyConfigFromEnv({ NEXT_PUBLIC_API_URL: "http://localhost:8787", NEXT_PUBLIC_API_TOKEN: "t" })).toBeNull();
  });
});
