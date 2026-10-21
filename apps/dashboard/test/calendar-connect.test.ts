// google-calendar.md G-1, G-2: the dashboard binds a connect flow to the browser that started it.
// The start goes through the proxy, which keeps a random key in an httpOnly cookie and sends the API
// only its SHA-256; the callback route hands the API Google's answer and that cookie's key, and
// keeps the grant the API staged in a Strict cookie that only the owner's confirmation spends.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { CONNECT_COOKIE, GRANT_COOKIE, completeGoogleConnect, discardPendingGrant } from "../src/lib/server/calendar-connect";
import { signOut } from "../src/lib/server/sign-in";
import { AUTH_COOKIE } from "../src/lib/server/supabase";
import { API_URL, createLiveHarness, ORIGIN, sameOrigin, setCookies, signInThroughLink, type UpstreamCall } from "./helpers/live";

const CONNECT = ["v1", "calendar", "google", "connect"];
const RESOURCE = "6f1d2b6e-8a4b-4c1e-9d55-0d6c1f2a3b4c";
const AUTHORIZE_URL = "https://accounts.google.test/o/oauth2/v2/auth?state=s";
/** A staged grant as the API signs it (made up: only its form matters here). */
const GRANT = `zgg1.${"g".repeat(120)}.${"t".repeat(43)}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const sentBody = (call: UpstreamCall) => JSON.parse(new TextDecoder().decode(call.init.body as ArrayBuffer)) as Record<string, unknown>;

async function owner() {
  const harness = createLiveHarness();
  const jar = await signInThroughLink(harness);
  const start = (body: unknown, cookie = jar.header()) => proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/google/connect`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": "k-1", Origin: ORIGIN },
  }), CONNECT, harness.setup);
  harness.api = async () => Response.json({ authorizeUrl: AUTHORIZE_URL });
  return { harness, jar, start };
}

describe("starting a connection (proxy)", () => {
  it("keeps a random key in an httpOnly Lax cookie under /api and sends the API only its hash, replacing the page's binding", async () => {
    const { harness, jar, start } = await owner();
    const response = await start({ resourceId: RESOURCE, browserBinding: "chosen-by-the-page" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizeUrl: AUTHORIZE_URL });
    const cookie = setCookies(response).get(CONNECT_COOKIE)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.header).toMatch(/; Path=\/api(;|$)/);
    expect(cookie.header).toMatch(/; Max-Age=600(;|$)/);
    expect(cookie.header).toMatch(/; HttpOnly/);
    // Lax: Google's redirect back is a cross-site top-level navigation, which Strict would not carry.
    expect(cookie.header).toMatch(/; SameSite=Lax/);
    expect(cookie.header).not.toMatch(/; Secure/);
    const sent = harness.apiCalls.at(-1)!;
    expect(sent.url).toBe(`${API_URL}/v1/calendar/google/connect`);
    expect(new Headers(sent.init.headers).get("idempotency-key")).toBe("k-1");
    expect(sentBody(sent)).toEqual({ resourceId: RESOURCE, browserBinding: sha256(cookie.value!) });
    expect(JSON.stringify(sent.init)).not.toContain(cookie.value!);

    // A second start in this browser keeps its key, so a flow in another tab stays valid.
    jar.apply(response);
    const again = await start({ resourceId: RESOURCE });
    expect(setCookies(again).get(CONNECT_COOKIE)!.value).toBe(cookie.value);
    expect(sentBody(harness.apiCalls.at(-1)!).browserBinding).toBe(sha256(cookie.value!));
    // Another browser gets another key.
    const elsewhere = await start({ resourceId: RESOURCE }, (await signInThroughLink(harness)).header());
    expect(setCookies(elsewhere).get(CONNECT_COOKIE)!.value).not.toBe(cookie.value);
  });

  it("replaces a malformed key, marks the cookie Secure over https, and sets none when the API refuses", async () => {
    const { harness, jar, start } = await owner();
    const bad = await start({ resourceId: RESOURCE }, `${jar.header()}; ${CONNECT_COOKIE}=short`);
    const fresh = setCookies(bad).get(CONNECT_COOKIE)!.value!;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sentBody(harness.apiCalls.at(-1)!).browserBinding).toBe(sha256(fresh));

    const https = { ok: true as const, config: { ...harness.config, trustProxy: true } };
    const secure = await proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/google/connect`, {
      method: "POST", body: JSON.stringify({ resourceId: RESOURCE }),
      headers: { Cookie: jar.header(), "Content-Type": "application/json", "Idempotency-Key": "k-2", "X-Forwarded-Proto": "https" },
    }), CONNECT, https);
    expect(setCookies(secure).get(CONNECT_COOKIE)!.header).toMatch(/; Secure/);

    for (const [status, code] of [[403, "Forbidden"], [404, "NotFound"], [409, "Conflict"]] as const) {
      harness.api = async () => Response.json({ error: { code, message: code, details: {} } }, { status });
      const refused = await start({ resourceId: RESOURCE });
      expect(refused.status).toBe(status);
      expect(setCookies(refused).has(CONNECT_COOKIE)).toBe(false);
    }
  });

  it("refuses a body that is not a JSON object without calling the API, and binds nothing on other routes", async () => {
    const { harness, jar, start } = await owner();
    for (const body of ["[]", "null", "\"x\"", "{"]) {
      const response = await start(body);
      expect(response.status, body).toBe(400);
      expect(setCookies(response).has(CONNECT_COOKIE)).toBe(false);
    }
    expect(harness.apiCalls.filter((call) => call.url.includes("/calendar/"))).toHaveLength(0);
    harness.api = async () => Response.json({ actionId: RESOURCE, result: {} });
    const disconnect = await proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/connections/${RESOURCE}/disconnect`, {
      method: "POST", body: "{}", headers: { Cookie: jar.header(), "Content-Type": "application/json", "Idempotency-Key": "k-3", Origin: ORIGIN },
    }), ["v1", "calendar", "connections", RESOURCE, "disconnect"], harness.setup);
    expect(disconnect.status).toBe(200);
    expect(sentBody(harness.apiCalls.at(-1)!)).toEqual({});
    expect(setCookies(disconnect).has(CONNECT_COOKIE)).toBe(false);
    const list = await proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/connections`, { headers: { Cookie: jar.header() } }),
      ["v1", "calendar", "connections"], harness.setup);
    expect(list.status).toBe(200);
    expect(harness.apiCalls.at(-1)!.url).toBe(`${API_URL}/v1/calendar/connections`);
  });
});

describe("the callback route", () => {
  const KEY = "k".repeat(43);
  const callbackRequest = (search: string, cookie: string | null = `${CONNECT_COOKIE}=${KEY}`) =>
    new Request(`${ORIGIN}/api/calendar/google/callback${search}`, { headers: cookie === null ? {} : { Cookie: cookie } });
  const redirectTo = (query: string) => async () =>
    new Response(null, { status: 303, headers: { Location: `https://app.haldenrowe.example/elsewhere?${query}` } });
  const landsOn = (response: Response) => {
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const location = response.headers.get("location")!;
    // Always this dashboard's own page, whatever address the API redirected to.
    expect(location.startsWith("/account/connections?")).toBe(true);
    return Object.fromEntries(new URLSearchParams(location.slice(location.indexOf("?") + 1)));
  };

  it("forwards only the state, code and error with the cookie's key, and lands on the Connections page", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("calendar=connected");
    const response = await completeGoogleConnect(callbackRequest("?state=zgs1.a.b&code=4%2Fc&scope=x&iss=y&error=z"), harness.setup);
    expect(landsOn(response)).toEqual({ calendar: "connected" });
    const sent = harness.apiCalls.at(-1)!;
    const url = new URL(sent.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${API_URL}/oauth/google/callback`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: "zgs1.a.b", code: "4/c", error: "z" });
    const headers = new Headers(sent.init.headers);
    expect(headers.get("x-zs-browser-key")).toBe(KEY);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(sent.init.redirect).toBe("manual");
  });

  it("sends no key without a well-formed cookie, and relays the API's reason", async () => {
    const harness = createLiveHarness();
    harness.api = redirectTo("calendar=error&reason=browser_mismatch");
    for (const cookie of [null, `${CONNECT_COOKIE}=short`, `other=${KEY}`]) {
      expect(landsOn(await completeGoogleConnect(callbackRequest("?state=s&code=c", cookie), harness.setup)))
        .toEqual({ calendar: "error", reason: "browser_mismatch" });
      expect(new Headers(harness.apiCalls.at(-1)!.init.headers).has("x-zs-browser-key")).toBe(false);
    }
  });

  it("reads a refused state as invalid_state, and anything else it cannot use as unavailable", async () => {
    const harness = createLiveHarness();
    harness.api = async () => Response.json({ error: { code: "ValidationFailed", message: "Invalid OAuth state", details: {} } }, { status: 400 });
    expect(landsOn(await completeGoogleConnect(callbackRequest("?state=s"), harness.setup))).toEqual({ calendar: "error", reason: "invalid_state" });
    for (const api of [
      async () => Response.json({ error: { code: "NotFound" } }, { status: 404 }),
      async () => new Response("down", { status: 503 }),
      async () => { throw new TypeError("fetch failed"); },
      redirectTo("calendar=error&reason=Not%20A%20Reason"),
      redirectTo("calendar=maybe"),
      async () => new Response(null, { status: 303 }),
    ]) {
      harness.api = api;
      expect(landsOn(await completeGoogleConnect(callbackRequest("?state=s"), harness.setup))).toEqual({ calendar: "error", reason: "unavailable" });
    }
    expect(landsOn(await completeGoogleConnect(callbackRequest("?state=s"), { ok: false, problem: "unset" }))).toEqual({ calendar: "error", reason: "unavailable" });
  });

  it("is not found in demo mode", async () => {
    expect((await completeGoogleConnect(callbackRequest("?state=s"), null)).status).toBe(404);
  });

  it("keeps a staged grant in a Strict httpOnly cookie under /api, never in the address, and asks the page to confirm", async () => {
    const harness = createLiveHarness();
    harness.api = async () => new Response(null, { status: 303, headers: { Location: "https://app.test/x?calendar=confirm", "x-zs-pending-grant": GRANT } });
    const response = await completeGoogleConnect(callbackRequest("?state=s&code=c"), harness.setup);
    expect(landsOn(response)).toEqual({ calendar: "confirm" });
    const cookie = setCookies(response).get(GRANT_COOKIE)!;
    expect(cookie.value).toBe(GRANT);
    expect(cookie.header).toMatch(/; Path=\/api(;|$)/);
    expect(cookie.header).toMatch(/; Max-Age=600(;|$)/);
    expect(cookie.header).toMatch(/; HttpOnly/);
    expect(cookie.header).toMatch(/; SameSite=Strict/);
    expect(response.headers.get("location")).not.toContain("zgg1");
    // A confirm without a well-formed grant is nothing this page can use.
    for (const grant of [null, "zgg1.x", `zgs1.${"g".repeat(10)}.${"t".repeat(43)}`]) {
      harness.api = async () => new Response(null, { status: 303, headers: { Location: "https://app.test/x?calendar=confirm", ...(grant === null ? {} : { "x-zs-pending-grant": grant }) } });
      const refused = await completeGoogleConnect(callbackRequest("?state=s&code=c"), harness.setup);
      expect(landsOn(refused), String(grant)).toEqual({ calendar: "error", reason: "unavailable" });
      expect(setCookies(refused).has(GRANT_COOKIE)).toBe(false);
    }
  });
});

describe("the staged grant (proxy, discard, sign-out)", () => {
  const PENDING = ["v1", "calendar", "google", "pending"];
  const CONFIRM = ["v1", "calendar", "google", "confirm"];
  async function withGrant() {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    jar.values.set(GRANT_COOKIE, GRANT);
    jar.values.set(CONNECT_COOKIE, "k".repeat(43));
    const pending = (cookie = jar.header(), headers: Record<string, string> = {}) =>
      proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/google/pending`, { headers: { Cookie: cookie, ...headers } }), PENDING, harness.setup);
    const confirm = (cookie = jar.header(), grantId = sha256(GRANT)) => proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/google/confirm`, {
      method: "POST", body: JSON.stringify({ grantId }), headers: { Cookie: cookie, "Content-Type": "application/json", Origin: ORIGIN },
    }), CONFIRM, harness.setup);
    return { harness, jar, pending, confirm };
  }
  const sentGrant = (call: UpstreamCall) => new Headers(call.init.headers).get("x-zs-pending-grant");

  it("sends the API the grant from this browser's cookie only, never one the caller sent", async () => {
    const { harness, jar, pending } = await withGrant();
    harness.api = async () => Response.json({ resourceId: RESOURCE, accountEmail: "owner@calendar.test", expiresAt: "2026-10-20T09:10:00.000Z" });
    const shown = await pending();
    expect(shown.status).toBe(200);
    expect(harness.apiCalls.at(-1)!.url).toBe(`${API_URL}/v1/calendar/google/pending`);
    expect(sentGrant(harness.apiCalls.at(-1)!)).toBe(GRANT);
    expect(setCookies(shown).has(GRANT_COOKIE)).toBe(false);
    jar.values.delete(GRANT_COOKIE);
    await pending(jar.header(), { "x-zs-pending-grant": GRANT });
    expect(sentGrant(harness.apiCalls.at(-1)!)).toBeNull();
    // Nor on any other route.
    jar.values.set(GRANT_COOKIE, GRANT);
    await proxyApiRequest(new Request(`${ORIGIN}/api/v1/calendar/connections`, { headers: { Cookie: jar.header() } }), ["v1", "calendar", "connections"], harness.setup);
    expect(sentGrant(harness.apiCalls.at(-1)!)).toBeNull();
  });

  it("drops the cookie once the API connected it or says it is gone, foreign or stale, and keeps it through an outage", async () => {
    const { harness, confirm, pending } = await withGrant();
    for (const [status, spent] of [[200, true], [404, true], [409, true], [403, true], [502, false], [503, false]] as const) {
      harness.api = async () => (status === 200
        ? Response.json({ id: RESOURCE })
        : Response.json({ error: { code: "X", message: "x", details: {} } }, { status }));
      const answer = await confirm();
      expect(answer.status).toBe(status);
      expect(sentGrant(harness.apiCalls.at(-1)!)).toBe(GRANT);
      expect(setCookies(answer).get(GRANT_COOKIE)?.value, String(status)).toBe(spent ? null : undefined);
    }
    harness.api = async () => { throw new TypeError("fetch failed"); };
    expect(setCookies(await confirm()).has(GRANT_COOKIE)).toBe(false);
    // A confirm of a grant this one replaced: the API refuses it, and this grant stays for the page.
    harness.api = async () => Response.json({ error: { code: "Conflict", message: "x", details: { reason: "grant_changed" } } }, { status: 409 });
    const replaced = await confirm(undefined, sha256("an older grant"));
    expect(replaced.status).toBe(409);
    expect(setCookies(replaced).has(GRANT_COOKIE)).toBe(false);
    expect(sentBody(harness.apiCalls.at(-1)!)).toEqual({ grantId: sha256("an older grant") });
    // Reading a grant the API no longer knows drops it too; a 200 read keeps it.
    harness.api = async () => Response.json({ error: { code: "NotFound", message: "x", details: {} } }, { status: 404 });
    expect(setCookies(await pending()).get(GRANT_COOKIE)?.value).toBeNull();
  });

  it("discards on a same-origin DELETE, and refuses other sites, other methods and demo mode", async () => {
    const { harness, jar } = await withGrant();
    const discard = (init: RequestInit, setup: Parameters<typeof discardPendingGrant>[1] = harness.setup) =>
      discardPendingGrant(new Request(`${ORIGIN}/api/calendar/google/pending`, init), setup);
    const done = discard({ method: "DELETE", headers: { Cookie: jar.header(), ...sameOrigin() } });
    expect(done.status).toBe(204);
    expect(done.headers.get("cache-control")).toBe("no-store");
    const cookie = setCookies(done).get(GRANT_COOKIE)!;
    expect(cookie.value).toBeNull();
    expect(cookie.header).toMatch(/; Path=\/api(;|$)/);
    // Repeating it, or with no grant at all, answers the same.
    expect(discard({ method: "DELETE", headers: sameOrigin() }).status).toBe(204);
    expect(discard({ method: "DELETE", headers: sameOrigin() }, { ok: false, problem: "unset" }).status).toBe(204);
    expect(discard({ method: "DELETE", headers: { Cookie: jar.header(), ...sameOrigin({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }) } }).status).toBe(403);
    expect(discard({ method: "GET", headers: sameOrigin() }).status).toBe(405);
    expect(discard({ method: "DELETE", headers: sameOrigin() }, null).status).toBe(404);
  });

  it("drops both calendar cookies on sign-out and when the API refuses the session", async () => {
    const { harness, jar } = await withGrant();
    const out = await signOut(new Request(`${ORIGIN}/api/sign-out`, { method: "POST", headers: { Cookie: jar.header(), ...sameOrigin() } }), harness.setup);
    expect(out.status).toBe(204);
    for (const name of [GRANT_COOKIE, CONNECT_COOKIE]) {
      const cookie = setCookies(out).get(name)!;
      expect(cookie.value, name).toBeNull();
      // Expired at the path it was set on, or the browser keeps it.
      expect(cookie.header).toMatch(/; Path=\/api(;|$)/);
    }
    // Without live settings, a browser with no session still loses them.
    const unset = await signOut(new Request(`${ORIGIN}/api/sign-out`, {
      method: "POST", headers: { Cookie: `${GRANT_COOKIE}=${GRANT}; ${CONNECT_COOKIE}=${"k".repeat(43)}`, ...sameOrigin() },
    }), { ok: false, problem: "unset" });
    expect(unset.status).toBe(204);
    expect([...setCookies(unset).keys()].sort()).toEqual([CONNECT_COOKIE, GRANT_COOKIE].sort());

    const again = await withGrant();
    again.harness.api = async () => Response.json({ error: { code: "Unauthorized", message: "x", details: {} } }, { status: 401 });
    const refused = await again.pending();
    expect(refused.status).toBe(401);
    expect(setCookies(refused).get(GRANT_COOKIE)?.value).toBeNull();
    expect(setCookies(refused).get(CONNECT_COOKIE)?.value).toBeNull();
    expect([...setCookies(refused).keys()].some((name) => name.startsWith(AUTH_COOKIE))).toBe(true);
  });
});
