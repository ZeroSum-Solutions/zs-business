// connections.md C-4, C-5: the dashboard binds a managed-tier connect flow to the browser that started it.
// The start keeps a random key and the API's attempt token in httpOnly cookies under /api/connections and
// sends the API only the key's hash; the callback hands the API the provider's answer, the attempt and the
// key, and keeps the grant it staged in a Strict cookie that only the owner's confirmation spends.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import {
  cancelPendingConnection,
  completeManagedConnect,
  confirmManagedConnect,
  managedConnectStatus,
  readPendingConnection,
  startManagedConnect,
} from "../src/lib/server/connections-connect";
import { ATTEMPT_COOKIE, BROWSER_COOKIE, GRANT_COOKIE } from "../src/lib/server/connections-cookies";
import { signOut } from "../src/lib/server/sign-in";
import { AUTH_COOKIE } from "../src/lib/server/supabase";
import { API_URL, createLiveHarness, Jar, ORIGIN, sameOrigin, setCookies, signInThroughLink, type LiveHarness, type UpstreamCall } from "./helpers/live";

const AUTHORIZE_URL = "https://connect.composio.test/link/lk_1";
const SHOP = "halden-rowe.myshopify.com";
const KEY = "k".repeat(43);
/** Tokens as the API signs them (made up: only their form matters here). */
const ATTEMPT = `zca1.${"a".repeat(100)}.${"t".repeat(43)}`;
const GRANT = `zcg1.${"g".repeat(120)}.${"t".repeat(43)}`;
const OTHER_GRANT = `zcg1.${"h".repeat(120)}.${"t".repeat(43)}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const sentBody = (call: UpstreamCall) => JSON.parse(new TextDecoder().decode(call.init.body as ArrayBuffer)) as Record<string, unknown>;
const sentHeaders = (call: UpstreamCall) => new Headers(call.init.headers);
const apiError = (status: number, code: string, headers: Record<string, string> = {}) =>
  Response.json({ error: { code, message: code, details: {} } }, { status, headers });
const redirectTo = (query: string, headers: Record<string, string> = {}) => async () =>
  new Response(null, { status: 303, headers: { Location: `https://app.haldenrowe.example/elsewhere?${query}`, ...headers } });

async function owner() {
  const harness = createLiveHarness();
  const jar = await signInThroughLink(harness);
  return { harness, jar };
}
const cookieHeader = (jar: Jar, extra: Record<string, string> = {}) =>
  [jar.header(), ...Object.entries(extra).map(([name, value]) => `${name}=${value}`)].filter(Boolean).join("; ");

function startRequest(jar: Jar, body: unknown, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/connections/shopify/connect`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { Cookie: cookieHeader(jar, extra), "Content-Type": "application/json", "Idempotency-Key": "k-1", Origin: ORIGIN, ...headers },
  });
}

describe("starting a connection", () => {
  const accept = (harness: LiveHarness) => {
    harness.api = async () => Response.json({ authorizeUrl: AUTHORIZE_URL }, { headers: { "x-zs-connect-attempt": ATTEMPT } });
  };

  it("keeps the key and the attempt in httpOnly Lax cookies under /api/connections and sends the API only the key's hash", async () => {
    const { harness, jar } = await owner();
    accept(harness);
    const response = await startManagedConnect(startRequest(jar, { shopDomain: SHOP, browserBinding: "chosen-by-the-page" }), harness.setup, "shopify");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizeUrl: AUTHORIZE_URL });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookies = setCookies(response);
    for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE]) {
      const cookie = cookies.get(name)!;
      expect(cookie.header, name).toMatch(/; Path=\/api\/connections(;|$)/);
      expect(cookie.header, name).toMatch(/; Max-Age=600(;|$)/);
      expect(cookie.header, name).toMatch(/; HttpOnly/);
      // Lax: the provider's redirect back is a cross-site top-level navigation, which Strict would not carry.
      expect(cookie.header, name).toMatch(/; SameSite=Lax/);
      expect(cookie.header, name).not.toMatch(/; Secure/);
    }
    expect(cookies.get(ATTEMPT_COOKIE)!.value).toBe(ATTEMPT);
    const key = cookies.get(BROWSER_COOKIE)!.value!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A new flow ends any grant an earlier one staged (C-5); the body above is the address alone, so it carries no token.
    expect(cookies.get(GRANT_COOKIE)!.value).toBeNull();
    expect(cookies.get(GRANT_COOKIE)!.header).toMatch(/; Path=\/api\/connections(;|$)/);

    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/v1/connections/shopify/connect`);
    expect(sentHeaders(sent).get("idempotency-key")).toBe("k-1");
    expect(sentBody(sent)).toEqual({ shopDomain: SHOP, browserBinding: sha256(key) });
    expect(JSON.stringify(sent.init)).not.toContain(key);

    // A second start in this browser keeps its key, so a flow in another tab stays valid.
    jar.apply(response);
    const again = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
    expect(setCookies(again).get(BROWSER_COOKIE)!.value).toBe(key);
    expect(sentBody(harness.apiCalls.at(-1)!).browserBinding).toBe(sha256(key));
    // Another browser gets another key.
    const elsewhere = await startManagedConnect(startRequest(await signInThroughLink(harness), { shopDomain: SHOP }), harness.setup, "shopify");
    expect(setCookies(elsewhere).get(BROWSER_COOKIE)!.value).not.toBe(key);
  });

  it("replaces a malformed key and marks the cookies Secure over https", async () => {
    const { harness, jar } = await owner();
    accept(harness);
    const bad = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }, { [BROWSER_COOKIE]: "short" }), harness.setup, "shopify");
    const fresh = setCookies(bad).get(BROWSER_COOKIE)!.value!;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sentBody(harness.apiCalls.at(-1)!).browserBinding).toBe(sha256(fresh));

    const https = { ok: true as const, config: { ...harness.config, trustProxy: true } };
    const secure = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }, {}, { "X-Forwarded-Proto": "https" }), https, "shopify");
    for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE]) expect(setCookies(secure).get(name)!.header, name).toMatch(/; Secure/);
  });

  it("sets no cookie unless the API answered 200 with a well-formed attempt and address", async () => {
    const { harness, jar } = await owner();
    for (const [status, code] of [[400, "ValidationFailed"], [403, "Forbidden"], [404, "NotFound"], [409, "Conflict"], [503, "Internal"]] as const) {
      harness.api = async () => apiError(status, code);
      const refused = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
      expect(refused.status).toBe(status);
      expect(setCookies(refused).has(BROWSER_COOKIE), String(status)).toBe(false);
      expect(setCookies(refused).has(ATTEMPT_COOKIE), String(status)).toBe(false);
      // A refused start leaves the grant of the flow that is still open.
      expect(setCookies(refused).has(GRANT_COOKIE), String(status)).toBe(false);
    }
    // The refusal passes its Retry-After on, still with no cookie.
    harness.api = async () => apiError(429, "RateLimited", { "Retry-After": "120" });
    const limited = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    expect(setCookies(limited).size).toBe(0);

    // A 200 the page cannot trust: no attempt, a malformed one, or an address that is not https.
    for (const [attempt, authorizeUrl] of [[null, AUTHORIZE_URL], ["zca1.short", AUTHORIZE_URL], [ATTEMPT, "http://insecure.test/x"], [ATTEMPT, "javascript:alert(1)"]] as const) {
      harness.api = async () => Response.json({ authorizeUrl }, { headers: attempt === null ? {} : { "x-zs-connect-attempt": attempt } });
      const odd = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
      expect(odd.status, String(attempt) + authorizeUrl).toBe(502);
      expect(setCookies(odd).has(ATTEMPT_COOKIE)).toBe(false);
    }
    harness.api = async () => { throw new Error("down"); };
    const down = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
    expect(down.status).toBe(502);
    expect(setCookies(down).has(ATTEMPT_COOKIE)).toBe(false);
  });

  it("refuses what is not a same-origin, signed-in POST of a JSON object, without calling the API", async () => {
    const { harness, jar } = await owner();
    accept(harness);
    const before = harness.apiCalls.length;
    for (const body of ["[]", "null", "\"x\"", "{"]) {
      const response = await startManagedConnect(startRequest(jar, body), harness.setup, "shopify");
      expect(response.status, body).toBe(400);
      expect(setCookies(response).has(ATTEMPT_COOKIE)).toBe(false);
    }
    const form = await startManagedConnect(startRequest(jar, "shopDomain=x", {}, { "Content-Type": "application/x-www-form-urlencoded" }), harness.setup, "shopify");
    expect(form.status).toBe(400);
    const crossSite = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }, {}, { Origin: "https://evil.example" }), harness.setup, "shopify");
    expect(crossSite.status).toBe(403);
    const signedOut = await startManagedConnect(new Request(`${ORIGIN}/api/connections/shopify/connect`, {
      method: "POST", body: JSON.stringify({ shopDomain: SHOP }), headers: { "Content-Type": "application/json", Origin: ORIGIN },
    }), harness.setup, "shopify");
    expect(signedOut.status).toBe(401);
    const get = await startManagedConnect(new Request(`${ORIGIN}/api/connections/shopify/connect`, { headers: { Cookie: jar.header() } }), harness.setup, "shopify");
    expect(get.status).toBe(405);
    const badToolkit = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "../x");
    expect(badToolkit.status).toBe(404);
    const demo = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), null, "shopify");
    expect(demo.status).toBe(404);
    expect(harness.apiCalls.length).toBe(before);
  });

  it("drops every connect cookie when the API refuses the session", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => apiError(401, "Unauthorized");
    const refused = await startManagedConnect(startRequest(jar, { shopDomain: SHOP }), harness.setup, "shopify");
    expect(refused.status).toBe(401);
    for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE, GRANT_COOKIE]) {
      const cookie = setCookies(refused).get(name)!;
      expect(cookie.value, name).toBeNull();
      // Expired at the path it was set on, or the browser keeps it.
      expect(cookie.header, name).toMatch(/; Path=\/api\/connections(;|$)/);
    }
    expect([...setCookies(refused).keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
  });
});

describe("the callback route", () => {
  const callbackRequest = (search: string, cookie: string | null = `${ATTEMPT_COOKIE}=${ATTEMPT}; ${BROWSER_COOKIE}=${KEY}`) =>
    new Request(`${ORIGIN}/api/connections/callback${search}`, { headers: cookie === null ? {} : { Cookie: cookie } });
  const landsOn = (response: Response) => {
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const location = response.headers.get("location")!;
    // Always this dashboard's own page, whatever address the API redirected to.
    expect(location.startsWith("/account/connections?")).toBe(true);
    return Object.fromEntries(new URLSearchParams(location.slice(location.indexOf("?") + 1)));
  };

  it("forwards a session_uri-only callback (the real redirect) unchanged", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=confirm");
    await completeManagedConnect(callbackRequest("?session_uri=su_1&state=y"), harness.setup);
    expect(Object.fromEntries(new URL(harness.apiCalls.at(-1)!.url).searchParams)).toEqual({ session_uri: "su_1" });
  });

  it("forwards only the two ids with the attempt and the key as headers, and lands on the Connections page", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=connected");
    const response = await completeManagedConnect(callbackRequest("?connected_account_id=ca_1&session_uri=su_1&status=success&code=x&state=y"), harness.setup);
    expect(landsOn(response)).toEqual({ connection: "connected" });
    const sent = harness.apiCalls.at(-1)!;
    const url = new URL(sent.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API_URL}/oauth/connections/callback`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ connected_account_id: "ca_1", session_uri: "su_1" });
    const headers = sentHeaders(sent);
    expect(headers.get("x-zs-connect-attempt")).toBe(ATTEMPT);
    expect(headers.get("x-zs-browser-key")).toBe(KEY);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(sent.init.redirect).toBe("manual");
    // Needs no session: the provider's redirect arrives with only the connect cookies. A finished flow drops the attempt.
    expect(setCookies(response).get(ATTEMPT_COOKIE)?.value).toBeNull();
    expect(setCookies(response).get(ATTEMPT_COOKIE)?.header).toMatch(/; Path=\/api\/connections(;|$)/);
    // The flow is done, so a grant left from an earlier one goes too.
    expect(setCookies(response).get(GRANT_COOKIE)?.value).toBeNull();
  });

  it("caps an overlong id, sends no key without a well-formed cookie, and never calls the API without an attempt", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=connected");
    await completeManagedConnect(callbackRequest(`?session_uri=${"s".repeat(5000)}`, `${ATTEMPT_COOKIE}=${ATTEMPT}; ${BROWSER_COOKIE}=short`), harness.setup);
    const sent = harness.apiCalls.at(-1)!;
    expect(new URL(sent.url).searchParams.get("session_uri")).toHaveLength(2048);
    expect(sentHeaders(sent).get("x-zs-browser-key")).toBeNull();

    const before = harness.apiCalls.length;
    for (const cookie of [null, `${BROWSER_COOKIE}=${KEY}`, `${ATTEMPT_COOKIE}=zca1.short`]) {
      const response = await completeManagedConnect(callbackRequest("?session_uri=s", cookie), harness.setup);
      expect(landsOn(response)).toEqual({ connection: "error", reason: "invalid_attempt" });
    }
    expect(harness.apiCalls.length).toBe(before);
  });

  it("a callback without a usable attempt cookie also expires a grant cookie left from an earlier flow (D-4)", async () => {
    const harness = createLiveHarness();
    const before = harness.apiCalls.length;
    for (const cookie of [`${GRANT_COOKIE}=${GRANT}; ${BROWSER_COOKIE}=${KEY}`, `${GRANT_COOKIE}=${GRANT}; ${ATTEMPT_COOKIE}=zca1.short; ${BROWSER_COOKIE}=${KEY}`]) {
      const response = await completeManagedConnect(callbackRequest("?session_uri=s", cookie), harness.setup);
      expect(landsOn(response)).toEqual({ connection: "error", reason: "invalid_attempt" });
      expect(setCookies(response).get(GRANT_COOKIE)?.value, cookie).toBeNull();
    }
    expect(harness.apiCalls.length).toBe(before);
  });

  it("stages a grant in a Strict httpOnly cookie, never in the address, and keeps the attempt for a cancel", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=confirm", { "x-zs-connect-grant": GRANT });
    const response = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
    expect(landsOn(response)).toEqual({ connection: "confirm" });
    expect(response.headers.get("location")).not.toContain(GRANT);
    const cookie = setCookies(response).get(GRANT_COOKIE)!;
    expect(cookie.value).toBe(GRANT);
    expect(cookie.header).toMatch(/; SameSite=Strict/);
    expect(cookie.header).toMatch(/; HttpOnly/);
    expect(cookie.header).toMatch(/; Path=\/api\/connections(;|$)/);
    expect(cookie.header).toMatch(/; Max-Age=600(;|$)/);
    expect(cookie.header).not.toMatch(/; Secure/);
    expect(setCookies(response).has(ATTEMPT_COOKIE)).toBe(false);

    const https = { ok: true as const, config: { ...harness.config, trustProxy: true } };
    const secure = await completeManagedConnect(new Request(`${ORIGIN}/api/connections/callback?session_uri=s`, {
      headers: { Cookie: `${ATTEMPT_COOKIE}=${ATTEMPT}`, "X-Forwarded-Proto": "https" },
    }), https);
    expect(setCookies(secure).get(GRANT_COOKIE)!.header).toMatch(/; Secure/);

    // A confirm outcome with no usable grant is an error, not a half-staged flow.
    for (const grant of [undefined, "zcg1.short", "nope"]) {
      harness.api = redirectTo("connection=confirm", grant === undefined ? {} : { "x-zs-connect-grant": grant });
      const odd = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
      expect(landsOn(odd)).toEqual({ connection: "error", reason: "unavailable" });
      expect(setCookies(odd).has(GRANT_COOKIE)).toBe(false);
    }
  });

  it("answers pending without dropping the attempt, which the status call still needs", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=pending");
    const response = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
    expect(landsOn(response)).toEqual({ connection: "pending" });
    expect(setCookies(response).size).toBe(0);
  });

  it("drops the attempt on an outcome that ends the flow, and keeps it on attempt_changed and on a transient failure (C-5)", async () => {
    const harness = createLiveHarness();
    // The flow is over for this attempt: the attempt cookie goes.
    for (const reason of ["invalid_attempt", "browser_mismatch", "forbidden", "not_connected", "expired", "conflict"]) {
      harness.api = redirectTo(`connection=error&reason=${reason}`);
      const response = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
      expect(setCookies(response).get(ATTEMPT_COOKIE)?.value, reason).toBeNull();
    }
    harness.api = async () => apiError(400, "ValidationFailed");
    expect(setCookies(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup)).get(ATTEMPT_COOKIE)?.value).toBeNull();
    harness.api = redirectTo("connection=connected");
    expect(setCookies(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup)).get(ATTEMPT_COOKIE)?.value).toBeNull();

    // The cookie holds a newer attempt (attempt_changed), or the answer says nothing about this one: it stays.
    const keeps: Array<[string, () => Promise<Response>]> = [
      ["attempt_changed", redirectTo("connection=error&reason=attempt_changed")],
      ["rate_limited", redirectTo("connection=error&reason=rate_limited")],
      ["provider_unavailable", redirectTo("connection=error&reason=provider_unavailable")],
      ["pending", redirectTo("connection=pending")],
      ["a 404", async () => apiError(404, "NotFound")],
      ["a 5xx", async () => apiError(503, "Internal")],
      ["an odd answer", redirectTo("connection=whatever")],
      ["a network failure", async () => { throw new Error("down"); }],
    ];
    for (const [name, respond] of keeps) {
      harness.api = respond;
      const response = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
      expect(setCookies(response).has(ATTEMPT_COOKIE), name).toBe(false);
      expect(setCookies(response).has(GRANT_COOKIE), name).toBe(false);
    }
  });

  it("expires a stale grant when the flow connects or ends, and stages the new one when it confirms (C-5)", async () => {
    const harness = createLiveHarness();
    const withGrant = `${ATTEMPT_COOKIE}=${ATTEMPT}; ${BROWSER_COOKIE}=${KEY}; ${GRANT_COOKIE}=${OTHER_GRANT}`;
    harness.api = redirectTo("connection=connected");
    const connected = await completeManagedConnect(callbackRequest("?session_uri=s", withGrant), harness.setup);
    expect(setCookies(connected).get(GRANT_COOKIE)?.value).toBeNull();
    expect(setCookies(connected).get(GRANT_COOKIE)?.header).toMatch(/; Path=\/api\/connections(;|$)/);
    harness.api = redirectTo("connection=error&reason=expired");
    expect(setCookies(await completeManagedConnect(callbackRequest("?session_uri=s", withGrant), harness.setup)).get(GRANT_COOKIE)?.value).toBeNull();
    harness.api = redirectTo("connection=confirm", { "x-zs-connect-grant": GRANT });
    expect(setCookies(await completeManagedConnect(callbackRequest("?session_uri=s", withGrant), harness.setup)).get(GRANT_COOKIE)?.value).toBe(GRANT);
  });

  it("relays only a reason it knows, maps 400 to invalid_attempt and treats anything else as unavailable", async () => {
    const harness = createLiveHarness();
    for (const reason of ["invalid_attempt", "browser_mismatch", "attempt_changed", "forbidden", "rate_limited", "conflict", "not_connected", "expired", "provider_unavailable"]) {
      harness.api = redirectTo(`connection=error&reason=${reason}`);
      const response = await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup);
      expect(landsOn(response), reason).toEqual({ connection: "error", reason });
    }
    harness.api = redirectTo("connection=error&reason=%3Cscript%3E");
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "unavailable" });
    harness.api = redirectTo("connection=error");
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "unavailable" });
    harness.api = redirectTo("connection=whatever");
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "unavailable" });
    harness.api = async () => apiError(400, "ValidationFailed");
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "invalid_attempt" });
    harness.api = async () => apiError(404, "NotFound");
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "unavailable" });
    harness.api = async () => { throw new Error("down"); };
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), harness.setup))).toEqual({ connection: "error", reason: "unavailable" });
    expect(landsOn(await completeManagedConnect(callbackRequest("?session_uri=s"), { ok: false, problem: "unset" }))).toEqual({ connection: "error", reason: "unavailable" });
    const demo = await completeManagedConnect(callbackRequest("?session_uri=s"), null);
    expect(demo.status).toBe(404);
  });
});

describe("the status route", () => {
  const statusRequest = (jar: Jar, headers: Record<string, string> = {}, cookie = `${ATTEMPT_COOKIE}=${ATTEMPT}; ${BROWSER_COOKIE}=${KEY}`) =>
    new Request(`${ORIGIN}/api/connections/callback/status`, { headers: { Cookie: cookieHeader(jar, Object.fromEntries(cookie.split("; ").filter(Boolean).map((pair) => pair.split("=") as [string, string]))), ...sameOrigin(), ...headers } });

  it("asks the API's status route with the attempt and key, and answers JSON", async () => {
    const { harness, jar } = await owner();
    harness.api = redirectTo("connection=pending");
    const pending = await managedConnectStatus(statusRequest(jar), harness.setup);
    expect(await pending.json()).toEqual({ connection: "pending" });
    expect(pending.headers.get("cache-control")).toBe("no-store");
    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/oauth/connections/callback/status?`);
    expect(sentHeaders(sent).get("x-zs-connect-attempt")).toBe(ATTEMPT);
    expect(sentHeaders(sent).get("x-zs-browser-key")).toBe(KEY);
    expect(sentHeaders(sent).get("authorization")).toBeNull();
    expect(setCookies(pending).has(ATTEMPT_COOKIE)).toBe(false);
    expect(setCookies(pending).has(GRANT_COOKIE)).toBe(false);

    harness.api = redirectTo("connection=connected");
    const connected = await managedConnectStatus(statusRequest(jar), harness.setup);
    expect(await connected.json()).toEqual({ connection: "connected" });
    expect(setCookies(connected).get(ATTEMPT_COOKIE)?.value).toBeNull();
    expect(setCookies(connected).get(GRANT_COOKIE)?.value).toBeNull();

    harness.api = redirectTo("connection=error&reason=expired");
    const expired = await managedConnectStatus(statusRequest(jar), harness.setup);
    expect(await expired.json()).toEqual({ connection: "error", reason: "expired" });
    expect(setCookies(expired).get(ATTEMPT_COOKIE)?.value).toBeNull();
    expect(setCookies(expired).get(GRANT_COOKIE)?.value).toBeNull();
  });

  it("keeps the attempt on attempt_changed and on a transient failure, as the callback does", async () => {
    const { harness, jar } = await owner();
    for (const respond of [
      redirectTo("connection=error&reason=attempt_changed"),
      redirectTo("connection=error&reason=rate_limited"),
      redirectTo("connection=error&reason=provider_unavailable"),
      async () => apiError(503, "Internal"),
      async (): Promise<Response> => { throw new Error("down"); },
    ]) {
      harness.api = respond;
      const response = await managedConnectStatus(statusRequest(jar), harness.setup);
      expect((await response.json() as { connection: string }).connection).toBe("error");
      expect(setCookies(response).has(ATTEMPT_COOKIE)).toBe(false);
      expect(setCookies(response).has(GRANT_COOKIE)).toBe(false);
    }
    harness.api = redirectTo("connection=error&reason=forbidden");
    expect(setCookies(await managedConnectStatus(statusRequest(jar), harness.setup)).get(ATTEMPT_COOKIE)?.value).toBeNull();
  });

  it("stages a grant the way the callback does, without putting it in the body", async () => {
    const { harness, jar } = await owner();
    harness.api = redirectTo("connection=confirm", { "x-zs-connect-grant": GRANT });
    const response = await managedConnectStatus(statusRequest(jar), harness.setup);
    expect(await response.json()).toEqual({ connection: "confirm" });
    expect(setCookies(response).get(GRANT_COOKIE)!.value).toBe(GRANT);
    expect(setCookies(response).get(GRANT_COOKIE)!.header).toMatch(/; SameSite=Strict/);
  });

  it("needs the dashboard session like the other routes: signed out is 401, and the API is not asked", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("connection=pending");
    const response = await managedConnectStatus(statusRequest(new Jar()), harness.setup);
    expect(response.status).toBe(401);
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("refuses a cross-site call, a missing attempt and a wrong method without bothering the API", async () => {
    const { harness, jar } = await owner();
    harness.api = redirectTo("connection=pending");
    const cross = await managedConnectStatus(statusRequest(jar, { "Sec-Fetch-Site": "cross-site" }), harness.setup);
    expect(cross.status).toBe(403);
    const none = await managedConnectStatus(statusRequest(jar, {}, ""), harness.setup);
    expect(await none.json()).toEqual({ connection: "error", reason: "invalid_attempt" });
    const post = await managedConnectStatus(new Request(`${ORIGIN}/api/connections/callback/status`, { method: "POST", headers: { Cookie: cookieHeader(jar), ...sameOrigin() } }), harness.setup);
    expect(post.status).toBe(405);
    expect(harness.apiCalls).toHaveLength(0);
    expect((await managedConnectStatus(statusRequest(jar), null)).status).toBe(404);
  });
});

describe("the staged grant", () => {
  const PENDING = { grantId: sha256(GRANT), toolkit: "shopify", shopDomain: SHOP, accountLabel: "Halden Rowe", expiresAt: "2026-11-06T12:10:00.000Z", tokensWithAccess: 2 };
  const pendingRequest = (jar: Jar, method = "GET", headers: Record<string, string> = {}, extra: Record<string, string> = { [GRANT_COOKIE]: GRANT, [ATTEMPT_COOKIE]: ATTEMPT }) =>
    new Request(`${ORIGIN}/api/connections/pending`, { method, headers: { Cookie: cookieHeader(jar, extra), ...sameOrigin(), ...headers } });
  const confirmRequest = (jar: Jar, body: unknown, extra: Record<string, string> = { [GRANT_COOKIE]: GRANT, [ATTEMPT_COOKIE]: ATTEMPT }) =>
    new Request(`${ORIGIN}/api/connections/confirm`, {
      method: "POST", body: JSON.stringify(body),
      headers: { Cookie: cookieHeader(jar, extra), "Content-Type": "application/json", "Idempotency-Key": "c-1", ...sameOrigin() },
    });

  it("reads what the grant names with the grant from this browser's cookie, never from the caller's header", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json(PENDING);
    const response = await readPendingConnection(pendingRequest(jar, "GET", { "x-zs-connect-grant": OTHER_GRANT }), harness.setup);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PENDING);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/v1/connections/pending`);
    expect(sentHeaders(sent).get("x-zs-connect-grant")).toBe(GRANT);
    expect(sentHeaders(sent).get("authorization")).toMatch(/^Bearer /);
    expect(sentHeaders(sent).get("cookie")).toBeNull();
    // A read that finds the grant keeps it for the confirm.
    expect(setCookies(response).has(GRANT_COOKIE)).toBe(false);
  });

  it("drops the grant when the API says there is none, and keeps it on an outage", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => apiError(404, "NotFound");
    const gone = await readPendingConnection(pendingRequest(jar), harness.setup);
    expect(gone.status).toBe(404);
    expect(setCookies(gone).get(GRANT_COOKIE)?.value).toBeNull();
    expect(setCookies(gone).get(GRANT_COOKIE)?.header).toMatch(/; Path=\/api\/connections(;|$)/);
    for (const respond of [async () => apiError(503, "Internal"), async () => { throw new Error("down"); }]) {
      harness.api = respond;
      const outage = await readPendingConnection(pendingRequest(jar), harness.setup);
      expect([502, 503]).toContain(outage.status);
      expect(setCookies(outage).has(GRANT_COOKIE)).toBe(false);
    }
    // No cookie, no question for the API.
    const before = harness.apiCalls.length;
    const none = await readPendingConnection(pendingRequest(jar, "GET", {}, {}), harness.setup);
    expect(none.status).toBe(404);
    expect(harness.apiCalls.length).toBe(before);
    const cross = await readPendingConnection(pendingRequest(jar, "GET", { "Sec-Fetch-Site": "cross-site" }), harness.setup);
    expect(cross.status).toBe(403);
  });

  it("confirms with the cookie's grant and spends the grant, not the attempt, once the API connected it", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ actionId: "a-1", result: {} });
    const response = await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(GRANT) }), harness.setup);
    expect(response.status).toBe(200);
    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/v1/connections/confirm`);
    expect(sentHeaders(sent).get("x-zs-connect-grant")).toBe(GRANT);
    expect(sentHeaders(sent).get("idempotency-key")).toBe("c-1");
    expect(sentBody(sent)).toEqual({ grantId: sha256(GRANT) });
    expect(setCookies(response).get(GRANT_COOKIE)?.value).toBeNull();
    // The attempt stays, so a reload of the callback still answers "connected" (C-5).
    expect(setCookies(response).has(ATTEMPT_COOKIE)).toBe(false);
  });

  it("spends the grant on 403, 404 and 409, keeps it on an outage or a grant it has replaced, and never on a 5xx", async () => {
    const { harness, jar } = await owner();
    for (const [status, code] of [[403, "Forbidden"], [404, "NotFound"], [409, "Conflict"]] as const) {
      harness.api = async () => apiError(status, code);
      const response = await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(GRANT) }), harness.setup);
      expect(response.status).toBe(status);
      expect(setCookies(response).get(GRANT_COOKIE)?.value, String(status)).toBeNull();
      // The attempt stays: only a connection ends the flow.
      expect(setCookies(response).has(ATTEMPT_COOKIE), String(status)).toBe(false);
    }
    for (const respond of [async () => apiError(500, "Internal"), async () => apiError(503, "Internal"), async () => apiError(429, "RateLimited"), async () => { throw new Error("down"); }]) {
      harness.api = respond;
      const response = await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(GRANT) }), harness.setup);
      expect(setCookies(response).has(GRANT_COOKIE)).toBe(false);
    }
    // A confirm of a grant the browser has since replaced: the API refuses it, and this grant stays for the page.
    harness.api = async () => apiError(409, "Conflict");
    const replaced = await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(OTHER_GRANT) }), harness.setup);
    expect(replaced.status).toBe(409);
    expect(setCookies(replaced).has(GRANT_COOKIE)).toBe(false);
    harness.api = async () => Response.json({ actionId: "a-1", result: {} });
    const foreign = await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(OTHER_GRANT) }), harness.setup);
    expect(setCookies(foreign).has(GRANT_COOKIE)).toBe(false);
  });

  it("refuses a confirm without a grant cookie or a JSON body, and from another site, without calling the API", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ actionId: "a-1", result: {} });
    const before = harness.apiCalls.length;
    expect((await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(GRANT) }, {}), harness.setup)).status).toBe(404);
    const form = new Request(`${ORIGIN}/api/connections/confirm`, {
      method: "POST", body: "grantId=x", headers: { Cookie: cookieHeader(jar, { [GRANT_COOKIE]: GRANT }), "Content-Type": "application/x-www-form-urlencoded", ...sameOrigin() },
    });
    expect((await confirmManagedConnect(form, harness.setup)).status).toBe(400);
    const cross = new Request(`${ORIGIN}/api/connections/confirm`, {
      method: "POST", body: "{}", headers: { Cookie: cookieHeader(jar, { [GRANT_COOKIE]: GRANT }), "Content-Type": "application/json", ...sameOrigin({ "Sec-Fetch-Site": "cross-site" }) },
    });
    expect((await confirmManagedConnect(cross, harness.setup)).status).toBe(403);
    expect(harness.apiCalls.length).toBe(before);
  });

  it("drops every connect cookie when the API refuses the session on a read or a confirm", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => apiError(401, "Unauthorized");
    for (const response of [
      await readPendingConnection(pendingRequest(jar), harness.setup),
      await confirmManagedConnect(confirmRequest(jar, { grantId: sha256(GRANT) }), harness.setup),
    ]) {
      expect(response.status).toBe(401);
      for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE, GRANT_COOKIE]) expect(setCookies(response).get(name)?.value, name).toBeNull();
      expect([...setCookies(response).keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
    }
  });

  it("cancels with the grant and the attempt both, answers the API's body and drops both cookies on a 2xx", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ cancelled: true, revokeFailed: false });
    const response = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true, revokeFailed: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(setCookies(response).get(GRANT_COOKIE)?.value).toBeNull();
    expect(setCookies(response).get(ATTEMPT_COOKIE)?.value).toBeNull();
    expect(setCookies(response).get(GRANT_COOKIE)?.header).toMatch(/; Path=\/api\/connections(;|$)/);
    expect(setCookies(response).get(ATTEMPT_COOKIE)?.header).toMatch(/; Path=\/api\/connections(;|$)/);
    // The browser key is not part of a cancel.
    expect(setCookies(response).has(BROWSER_COOKIE)).toBe(false);
    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/v1/connections/pending`);
    expect(sent.init.method).toBe("DELETE");
    expect(sentHeaders(sent).get("x-zs-connect-attempt")).toBe(ATTEMPT);
    expect(sentHeaders(sent).get("x-zs-connect-grant")).toBe(GRANT);
    expect(sentHeaders(sent).get("authorization")).toMatch(/^Bearer /);
    expect(sentHeaders(sent).get("cookie")).toBeNull();

    // The revoke failed: the page is told, so it can send the owner to Shopify admin.
    harness.api = async () => Response.json({ cancelled: true, revokeFailed: true });
    const revoke = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
    expect(await revoke.json()).toEqual({ cancelled: true, revokeFailed: true });
    expect(setCookies(revoke).get(GRANT_COOKIE)?.value).toBeNull();
  });

  it("sends what it has: the grant alone, or the attempt alone", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ cancelled: true, revokeFailed: false });
    await cancelPendingConnection(pendingRequest(jar, "DELETE", {}, { [GRANT_COOKIE]: GRANT }), harness.setup);
    expect(sentHeaders(harness.apiCalls.at(-1)!).get("x-zs-connect-grant")).toBe(GRANT);
    expect(sentHeaders(harness.apiCalls.at(-1)!).get("x-zs-connect-attempt")).toBeNull();
    await cancelPendingConnection(pendingRequest(jar, "DELETE", {}, { [ATTEMPT_COOKIE]: ATTEMPT }), harness.setup);
    expect(sentHeaders(harness.apiCalls.at(-1)!).get("x-zs-connect-attempt")).toBe(ATTEMPT);
    expect(sentHeaders(harness.apiCalls.at(-1)!).get("x-zs-connect-grant")).toBeNull();
  });

  it("surfaces an API refusal and keeps both cookies, so the owner can retry", async () => {
    const { harness, jar } = await owner();
    for (const [status, code, extra] of [
      [429, "RateLimited", { "Retry-After": "30" }], [409, "Conflict", {}], [403, "Forbidden", {}], [500, "Internal", {}], [503, "Unavailable", {}],
    ] as const) {
      harness.api = async () => apiError(status, code, extra);
      const response = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
      expect(response.status, String(status)).toBe(status);
      expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
      if (status === 429) expect(response.headers.get("retry-after")).toBe("30");
      expect(setCookies(response).has(GRANT_COOKIE), String(status)).toBe(false);
      expect(setCookies(response).has(ATTEMPT_COOKIE), String(status)).toBe(false);
    }
    // A lost answer is a 502, not a silent success, and the cookies stay.
    harness.api = async () => { throw new Error("down"); };
    const down = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
    expect(down.status).toBe(502);
    expect(setCookies(down).has(GRANT_COOKIE)).toBe(false);
    expect(setCookies(down).has(ATTEMPT_COOKIE)).toBe(false);
  });

  it("drops both cookies when the API has nothing to cancel (404), since the goal is reached", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => apiError(404, "NotFound");
    const response = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
    expect(response.status).toBe(404);
    expect(setCookies(response).get(GRANT_COOKIE)?.value).toBeNull();
    expect(setCookies(response).get(ATTEMPT_COOKIE)?.value).toBeNull();
  });

  it("answers 204 and calls nobody when there is no grant and no attempt; invalid live settings are a 503 that keeps the cookies", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ cancelled: true, revokeFailed: false });
    const before = harness.apiCalls.length;
    const bare = await cancelPendingConnection(pendingRequest(jar, "DELETE", {}, {}), harness.setup);
    expect(bare.status).toBe(204);
    expect(harness.apiCalls.length).toBe(before);
    // D-2: invalid live settings are an error, and the cookies stay for a retry once the settings are fixed.
    const unset = await cancelPendingConnection(pendingRequest(jar, "DELETE"), { ok: false, problem: "unset" });
    expect(unset.status).toBe(503);
    expect(unset.headers.get("set-cookie")).toBeNull();
    expect(harness.apiCalls.length).toBe(before);
  });

  it("refuses a cancel from another site, with another method, or signed out, and drops everything when the API refuses the session", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ cancelled: true, revokeFailed: false });
    const cross = await cancelPendingConnection(pendingRequest(jar, "DELETE", { "Sec-Fetch-Site": "cross-site" }), harness.setup);
    expect(cross.status).toBe(403);
    expect(setCookies(cross).size).toBe(0);
    expect((await cancelPendingConnection(pendingRequest(jar, "POST"), harness.setup)).status).toBe(405);
    expect((await cancelPendingConnection(pendingRequest(jar, "DELETE"), null)).status).toBe(404);
    const before = harness.apiCalls.length;
    const signedOut = await cancelPendingConnection(pendingRequest(new Jar(), "DELETE"), harness.setup);
    expect(signedOut.status).toBe(401);
    expect(setCookies(signedOut).has(GRANT_COOKIE)).toBe(false);
    expect(harness.apiCalls.length).toBe(before);
    harness.api = async () => apiError(401, "Unauthorized");
    const refused = await cancelPendingConnection(pendingRequest(jar, "DELETE"), harness.setup);
    expect(refused.status).toBe(401);
    for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE, GRANT_COOKIE]) expect(setCookies(refused).get(name)?.value, name).toBeNull();
    expect([...setCookies(refused).keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
  });
});

describe("sign-out", () => {
  it("expires all three connect cookies at /api/connections, though the browser does not send them to /api/sign-out", async () => {
    const { harness, jar } = await owner();
    const out = await signOut(new Request(`${ORIGIN}/api/sign-out`, { method: "POST", headers: { Cookie: jar.header(), ...sameOrigin() } }), harness.setup);
    expect(out.status).toBe(204);
    for (const name of [BROWSER_COOKIE, ATTEMPT_COOKIE, GRANT_COOKIE]) {
      const cookie = setCookies(out).get(name)!;
      expect(cookie.value, name).toBeNull();
      expect(cookie.header, name).toMatch(/; Path=\/api\/connections(;|$)/);
      expect(cookie.header, name).toMatch(/; HttpOnly/);
    }
    expect(setCookies(out).get(GRANT_COOKIE)!.header).toMatch(/; SameSite=Strict/);
  });
});

describe("the generic proxy", () => {
  const call = (harness: LiveHarness, jar: Jar, method: string, path: string[], body?: unknown) => proxyApiRequest(new Request(`${ORIGIN}/api/${path.join("/")}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { Cookie: cookieHeader(jar, { [GRANT_COOKIE]: GRANT, [ATTEMPT_COOKIE]: ATTEMPT, [BROWSER_COOKIE]: KEY }), "Content-Type": "application/json", "Idempotency-Key": "d-1", Origin: ORIGIN },
  }), path, harness.setup);
  const ID = "6f1d2b6e-8a4b-4c1e-9d55-0d6c1f2a3b4c";

  it("forwards the list and a disconnect, and nothing of the connect flow", async () => {
    const { harness, jar } = await owner();
    harness.api = async () => Response.json({ items: [] });
    const list = await call(harness, jar, "GET", ["v1", "connections"]);
    expect(list.status).toBe(200);
    expect(harness.apiCalls.at(-1)!.url).toBe(`${API_URL}/v1/connections`);
    // The connect cookies sit under another path in a real browser; even if sent, they are never forwarded.
    const forwarded = sentHeaders(harness.apiCalls.at(-1)!);
    expect(forwarded.get("x-zs-connect-grant")).toBeNull();
    expect(forwarded.get("x-zs-connect-attempt")).toBeNull();
    expect(forwarded.get("cookie")).toBeNull();

    harness.api = async () => Response.json({ actionId: ID, result: { revokeFailed: false } });
    const disconnect = await call(harness, jar, "POST", ["v1", "connections", ID, "disconnect"], {});
    expect(disconnect.status).toBe(200);
    expect(harness.apiCalls.at(-1)!.url).toBe(`${API_URL}/v1/connections/${ID}/disconnect`);
    expect(sentHeaders(harness.apiCalls.at(-1)!).get("idempotency-key")).toBe("d-1");
    expect(setCookies(disconnect).has(GRANT_COOKIE)).toBe(false);

    const before = harness.apiCalls.length;
    for (const [method, path, body] of [
      ["GET", ["v1", "connections", "pending"], undefined],
      ["DELETE", ["v1", "connections", "pending"], undefined],
      ["POST", ["v1", "connections", "confirm"], { grantId: sha256(GRANT) }],
      ["POST", ["v1", "connections", "shopify", "connect"], { shopDomain: SHOP }],
      ["POST", ["v1", "connections"], {}],
      ["PUT", ["v1", "connections"], {}],
      ["DELETE", ["v1", "connections", ID], undefined],
      ["GET", ["v1", "connections", ID, "disconnect"], undefined],
      ["POST", ["v1", "connections", ID, "disconnect", "x"], {}],
      ["GET", ["oauth", "connections", "callback"], undefined],
    ] as const) {
      const response = await call(harness, jar, method, [...path], body);
      expect(response.status, `${method} ${path.join("/")}`).toBe(404);
    }
    expect(harness.apiCalls.length).toBe(before);
  });
});
