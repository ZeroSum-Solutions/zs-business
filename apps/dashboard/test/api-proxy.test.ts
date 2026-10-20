import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { liveSetupFromEnv } from "../src/lib/server/live-config";
import { AUTH_COOKIE, PILOT_COOKIE } from "../src/lib/server/supabase";
import { ANON_KEY, createLiveHarness, forwardedClaims, ORIGIN, setCookies, signInThroughLink, type LiveHarness } from "./helpers/live";
import { chunkedBody, chunks, manualTimer, settle } from "./helpers/streams";

const contacts = ["v1", "crm", "contacts"];

async function signedIn(options: Parameters<typeof createLiveHarness>[0] = {}) {
  const harness = createLiveHarness(options);
  const jar = await signInThroughLink(harness);
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/${path}`, { headers: { Cookie: jar.header(), ...headers } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/${path}`, { method: "POST", body: JSON.stringify(body), headers: { Cookie: jar.header(), "Content-Type": "application/json", ...headers } });
  return { harness, jar, get, post };
}

const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

describe("api proxy sign-in", () => {
  it("refuses a request with no session and never calls the API", async () => {
    const harness = createLiveHarness();
    const anonymous = new Request(`${ORIGIN}/api/v1/crm/contacts`);
    const response = await proxyApiRequest(anonymous, contacts, harness.setup);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("Unauthorized");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // A bearer token from the browser is no way in: the proxy ignores the caller's Authorization.
    const signedInElsewhere = await harness.gotrue.signIn(harness.owner);
    const bearer = new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers: { Authorization: `Bearer ${signedInElsewhere.accessToken}` } });
    expect((await proxyApiRequest(bearer, contacts, harness.setup)).status).toBe(401);
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("refuses the retired pilot cookie and expires it", async () => {
    const harness = createLiveHarness();
    const old = new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers: { Cookie: `${PILOT_COOKIE}=v1.9999999999.abc.def` } });
    const response = await proxyApiRequest(old, contacts, harness.setup);
    expect(response.status).toBe(401);
    expect(setCookies(response).get(PILOT_COOKIE)?.value).toBeNull();
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("sends the signed-in person's own access token, and nothing else of theirs", async () => {
    const { harness, get } = await signedIn();
    const response = await proxyApiRequest(get("v1/crm/contacts", { Authorization: "Bearer from-the-browser", "Sec-Fetch-Site": "same-origin" }), contacts, harness.setup);
    expect(response.status).toBe(200);
    expect(harness.apiCalls).toHaveLength(1);
    const call = harness.apiCalls[0]!;
    expect(call.url).toBe("http://api.internal:8787/v1/crm/contacts");
    const claims = forwardedClaims(call);
    expect(claims.sub).toBe(harness.owner.id);
    expect(harness.store.sessions.get(claims.session_id)).toBe(harness.owner.id);
    expect(new Headers(call.init.headers).get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refreshes an expiring session on the server and sends the new token", async () => {
    // A 60-second token is inside supabase-js's refresh margin from the start.
    const { harness, get } = await signedIn({ ttlSeconds: 60 });
    const first = await proxyApiRequest(get("v1/crm/contacts"), contacts, harness.setup);
    expect(first.status).toBe(200);
    const refreshed = setCookies(first);
    expect([...refreshed.keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
    for (const cookie of refreshed.values()) expect(cookie.header).toMatch(/HttpOnly/);
    expect(harness.gotrue.calls.filter((call) => call.path === "/auth/v1/token")).toHaveLength(1);
    // The refreshed token belongs to the same session.
    expect(harness.store.sessions.size).toBe(1);
    expect(forwardedClaims(harness.apiCalls[0]!).session_id).toBe([...harness.store.sessions.keys()][0]);
  });

  it("drops the session cookies when the API refuses the session", async () => {
    const { harness, get } = await signedIn();
    // Signed out on another device: the session row is gone, the access token still verifies.
    await harness.store.endSession([...harness.store.sessions.keys()][0]!);
    const response = await proxyApiRequest(get("v1/crm/contacts"), contacts, harness.setup);
    expect(response.status).toBe(401);
    const cleared = setCookies(response);
    expect(cleared.size).toBeGreaterThan(0);
    for (const cookie of cleared.values()) expect(cookie.value).toBeNull();
  });

  it("is refused when the session was revoked before a refresh", async () => {
    const { harness, get } = await signedIn({ ttlSeconds: 60 });
    await harness.store.endSession([...harness.store.sessions.keys()][0]!);
    // The refresh fails; supabase-js keeps the unexpired access token, and the API refuses it.
    const response = await proxyApiRequest(get("v1/crm/contacts"), contacts, harness.setup);
    expect(response.status).toBe(401);
    expect(harness.gotrue.calls.filter((call) => call.path === "/auth/v1/token")).toHaveLength(1);
    for (const cookie of setCookies(response).values()) expect(cookie.value).toBeNull();
  });
});

describe("api proxy", () => {
  it("passes the body, the Idempotency-Key and the API's status and error body through", async () => {
    const { harness, post } = await signedIn();
    const error = { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "overlap" } } };
    harness.api = async () => Response.json(error, { status: 409, headers: { "Set-Cookie": "upstream=1" } });
    const response = await proxyApiRequest(post("v1/booking/bookings", { resourceId: "r1" }, { "Idempotency-Key": "k-1", Origin: ORIGIN }), ["v1", "booking", "bookings"], harness.setup);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(error);
    expect(response.headers.get("set-cookie")).toBeNull();
    const sent = harness.apiCalls[0]!;
    expect(sent.init.method).toBe("POST");
    expect(new Headers(sent.init.headers).get("idempotency-key")).toBe("k-1");
    expect(JSON.parse(new TextDecoder().decode(sent.init.body as ArrayBuffer))).toEqual({ resourceId: "r1" });
  });

  it("refuses cross-site callers, so another page cannot spend the session", async () => {
    const { harness, get, post } = await signedIn();
    const cases = [
      post("v1/crm/contacts", {}, { Origin: "https://evil.example" }),
      post("v1/crm/contacts", {}, { "Sec-Fetch-Site": "cross-site" }),
      get("v1/crm/deals", { "Sec-Fetch-Site": "same-site" }),
    ];
    for (const request of cases) {
      const response = await proxyApiRequest(request, ["v1", "crm", request.method === "GET" ? "deals" : "contacts"], harness.setup);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("Forbidden");
    }
    const form = new Request(`${ORIGIN}/api/v1/crm/contacts`, { method: "POST", body: "email=a", headers: { Cookie: (await signInThroughLink(harness)).header(), "Content-Type": "text/plain" } });
    expect((await proxyApiRequest(form, contacts, harness.setup)).status).toBe(400);
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("judges the origin by the Host the browser used, and X-Forwarded-Host only behind a trusted proxy", async () => {
    const { harness, jar } = await signedIn();
    const request = (headers: Record<string, string>) => new Request("http://localhost:3218/api/v1/crm/contacts", {
      method: "POST", body: "{}", headers: { Cookie: jar.header(), "Content-Type": "application/json", ...headers },
    });
    expect((await proxyApiRequest(request({ Host: "127.0.0.1:3218", Origin: "http://127.0.0.1:3218", "Sec-Fetch-Site": "same-origin" }), contacts, harness.setup)).status).toBe(200);
    expect((await proxyApiRequest(request({ Host: "127.0.0.1:3218", Origin: "http://localhost:3218" }), contacts, harness.setup)).status).toBe(403);
    const behindProxy = { Host: "localhost:3000", "X-Forwarded-Host": "app.example.com", Origin: "https://app.example.com" };
    expect((await proxyApiRequest(request(behindProxy), contacts, harness.setup)).status).toBe(403);
    const trusted = { ok: true as const, config: { ...harness.config, trustProxy: true } };
    expect((await proxyApiRequest(request(behindProxy), contacts, trusted)).status).toBe(200);
  });

  it("forwards only the booking, CRM, intake, member, site and /me routes, with GET, POST and DELETE", async () => {
    const { harness, jar, get } = await signedIn();
    for (const path of [["healthz"], ["v1", "admin", "users"], ["v1", "crm"], ["v1", "crm", ".."], ["v2", "crm", "deals"], ["v1", "me", "x"]]) {
      expect((await proxyApiRequest(get(path.join("/")), path, harness.setup)).status, path.join("/")).toBe(404);
    }
    const put = new Request(`${ORIGIN}/api/v1/crm/deals`, { method: "PUT", headers: { Cookie: jar.header() } });
    expect((await proxyApiRequest(put, ["v1", "crm", "deals"], harness.setup)).status).toBe(404);
    expect(harness.apiCalls).toHaveLength(0);
    for (const path of [["v1", "me"], ["v1", "members"], ["v1", "sites"], ["v1", "sites", "s-1", "releases"]]) expect((await proxyApiRequest(get(path.join("/")), path, harness.setup)).status).toBe(200);
    const remove = new Request(`${ORIGIN}/api/v1/members/m-1`, { method: "DELETE", headers: { Cookie: jar.header(), "Idempotency-Key": "k" } });
    expect((await proxyApiRequest(remove, ["v1", "members", "m-1"], harness.setup)).status).toBe(200);
    expect(harness.apiCalls.at(-1)!.init.method).toBe("DELETE");
  });

  it("answers 503 in demo mode or without the Supabase settings, and 502 when the API is unreachable", async () => {
    const anonymous = new Request(`${ORIGIN}/api/v1/crm/deals`);
    expect((await proxyApiRequest(anonymous, ["v1", "crm", "deals"], null)).status).toBe(503);
    expect((await proxyApiRequest(anonymous, ["v1", "crm", "deals"], { ok: false, problem: "unset" })).status).toBe(503);
    const { harness, get } = await signedIn();
    harness.api = async () => { throw new TypeError("fetch failed"); };
    expect((await proxyApiRequest(get("v1/crm/deals"), ["v1", "crm", "deals"], harness.setup)).status).toBe(502);
  });
});

describe("api proxy body limits", () => {
  const streamed = (cookie: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/v1/crm/contacts`, { method: "POST", body, duplex: "half", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers } } as RequestInit);

  it("cancels an oversize chunked upload past 64 KiB and never calls the API", async () => {
    const { harness, jar } = await signedIn();
    // 64 chunks of 4 KiB, 256 KiB in all: the seventeenth takes it past 64 KiB.
    const { stream, state } = chunkedBody(chunks(64, 4096));
    const response = await proxyApiRequest(streamed(jar.header(), stream), contacts, harness.setup);
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("ValidationFailed");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.cancelled).toBe(true);
    expect(state.served).toBe(17);
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("refuses a declared Content-Length over 64 KiB unread, and forwards a body of exactly 64 KiB", async () => {
    const { harness, jar } = await signedIn();
    const big = chunkedBody(chunks(64, 4096));
    expect((await proxyApiRequest(streamed(jar.header(), big.stream, { "Content-Length": String(64 * 1024 + 1) }), contacts, harness.setup)).status).toBe(413);
    expect(big.state.pulls).toBe(0);
    const exact = chunkedBody(chunks(16, 4096));
    expect((await proxyApiRequest(streamed(jar.header(), exact.stream), contacts, harness.setup)).status).toBe(200);
    expect((harness.apiCalls[0]!.init.body as Uint8Array).byteLength).toBe(64 * 1024);
  });

  it("still writes refreshed session cookies on a refused body", async () => {
    // A 60-second token is refreshed on the way in; the 413 must carry the new cookies.
    const { harness, jar } = await signedIn({ ttlSeconds: 60 });
    const response = await proxyApiRequest(streamed(jar.header(), chunkedBody(chunks(64, 4096)).stream), contacts, harness.setup);
    expect(response.status).toBe(413);
    expect([...setCookies(response).keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
  });

  it("answers 408 to a stalled body and 400 to one that breaks off", async () => {
    const { harness, jar } = await signedIn();
    const slow = chunkedBody(chunks(1, 10), "stall");
    const { timer, start } = manualTimer();
    const pending = proxyApiRequest(streamed(jar.header(), slow.stream), contacts, harness.setup, { timer: start });
    // The session lookup comes first; wait until the body is being read.
    while (slow.state.pulls === 0) await settle();
    timer.fire();
    const late = await pending;
    expect(late.status).toBe(408);
    expect(await errorCode(late)).toBe("ValidationFailed");
    expect(timer.started).toEqual([15_000]);
    expect(slow.state.cancelled).toBe(true);
    const broken = await proxyApiRequest(streamed(jar.header(), chunkedBody(chunks(1, 10), "fail").stream), contacts, harness.setup);
    expect(broken.status).toBe(400);
    expect(harness.apiCalls).toHaveLength(0);
  });
});

describe("live settings", () => {
  const live = { ZS_API_URL: "http://localhost:8787/", SUPABASE_URL: "https://abcd.supabase.co/", SUPABASE_ANON_KEY: ANON_KEY };

  it("reads server-only env names, and is demo mode without ZS_API_URL", () => {
    expect(liveSetupFromEnv(live)).toEqual({
      ok: true, config: { apiUrl: "http://localhost:8787", supabaseUrl: "https://abcd.supabase.co", supabaseAnonKey: ANON_KEY, trustProxy: false },
    });
    expect(liveSetupFromEnv({ ...live, DASHBOARD_TRUST_PROXY: "1" })).toMatchObject({ ok: true, config: { trustProxy: true } });
    expect(liveSetupFromEnv({})).toBeNull();
    expect(liveSetupFromEnv({ NEXT_PUBLIC_API_URL: "http://localhost:8787", NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" })).toBeNull();
  });

  it("refuses live mode without a Supabase URL and anon key", () => {
    for (const env of [
      { ZS_API_URL: live.ZS_API_URL },
      { ...live, SUPABASE_URL: "" },
      { ...live, SUPABASE_URL: "ftp://abcd.supabase.co" },
      { ...live, SUPABASE_ANON_KEY: "short" },
    ]) {
      expect(liveSetupFromEnv(env), JSON.stringify(env)).toMatchObject({ ok: false });
    }
  });
});
