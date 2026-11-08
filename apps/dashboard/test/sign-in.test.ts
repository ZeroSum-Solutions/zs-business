import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { proxyApiRequest } from "../src/lib/server/api-proxy";
import { attemptLimitsFromEnv, clientAddress, createSharedSignInLimiter, DIRECT_ADDRESS } from "../src/lib/server/rate-limit";
import { confirmSignIn, requestSignInLink, signOut } from "../src/lib/server/sign-in";
import { AUTH_COOKIE, PILOT_COOKIE } from "../src/lib/server/supabase";
import { createLiveHarness, Jar, linkRequest, ORIGIN, sameOrigin, setCookies, signInThroughLink } from "./helpers/live";
import { LIMITER_SECRET, sharedLimiterStore } from "./helpers/shared-limiter";
import { chunkedBody, chunks, manualTimer, settle } from "./helpers/streams";

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { perAddress: 5, global: 30, perEmail: 5 };
/** A fresh limiter on its own store; the address and global limits are the defaults, email is loose unless a test sets it. */
const fresh = (limits: Partial<typeof LIMITS> = {}) => sharedLimiterStore().limiter(limits);
const ask = (email: string, headers: Record<string, string> = {}, limiter = fresh(), harness = createLiveHarness()) =>
  requestSignInLink(linkRequest(email, undefined, headers), harness.setup, limiter);
const open = (harness: ReturnType<typeof createLiveHarness>, url: string, cookie = "") =>
  confirmSignIn(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }), harness.setup);

describe("email sign-in link", () => {
  it("asks Supabase for a link back to /auth/confirm, never creating an account", async () => {
    const harness = createLiveHarness();
    const response = await requestSignInLink(linkRequest(" Owner@Example.com ", "/customers"), harness.setup, fresh());
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/);
    const link = new URL(harness.gotrue.lastLink("owner@example.com")!);
    expect(`${link.origin}${link.pathname}`).toBe(`${ORIGIN}/auth/confirm`);
    expect(link.searchParams.get("next")).toBe("/customers");
  });

  it("answers an address with no account exactly like one with an account", async () => {
    const harness = createLiveHarness();
    const unknown = await requestSignInLink(linkRequest("nobody@example.com"), harness.setup, fresh());
    expect(unknown.status).toBe(204);
    expect(await unknown.text()).toBe("");
    expect(harness.gotrue.lastLink("nobody@example.com")).toBeNull();
    // supabase-js sent create_user: false, so the fake refused instead of creating one.
    expect(harness.gotrue.calls.filter((call) => call.path === "/auth/v1/otp")).toHaveLength(1);
  });

  it("signs in when the link is opened, with httpOnly SameSite=Strict cookies, and sends the browser to next", async () => {
    const harness = createLiveHarness();
    await requestSignInLink(linkRequest("owner@example.com", "/customers?tab=pipeline"), harness.setup, fresh());
    // Opened on another device: no cookie from the browser that asked.
    const opened = await open(harness, harness.gotrue.lastLink("owner@example.com")!);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe("/customers?tab=pipeline");
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = setCookies(opened);
    const session = [...cookies].filter(([name, cookie]) => name.startsWith(AUTH_COOKIE) && cookie.value);
    expect(session.length).toBeGreaterThan(0);
    for (const [, cookie] of session) {
      expect(cookie.header).toMatch(/HttpOnly/);
      expect(cookie.header).toMatch(/SameSite=Strict/);
      expect(cookie.header).toMatch(/Path=\//);
      // Plain http on loopback: a Secure cookie would never come back.
      expect(cookie.header).not.toMatch(/Secure/);
    }
    expect(harness.store.sessions.size).toBe(1);
  });

  it("marks the cookies Secure over https, and trusts X-Forwarded-Proto only behind a trusted proxy", async () => {
    const secure = async (trustProxy: boolean, url: string, headers: Record<string, string> = {}) => {
      const harness = createLiveHarness({ trustProxy });
      await requestSignInLink(linkRequest("owner@example.com"), harness.setup, fresh());
      const link = new URL(harness.gotrue.lastLink("owner@example.com")!);
      const opened = await confirmSignIn(new Request(`${url}${link.search}`, { headers }), harness.setup);
      return [...setCookies(opened).values()].every((cookie) => /Secure/.test(cookie.header));
    };
    expect(await secure(false, "https://app.example.com/auth/confirm")).toBe(true);
    expect(await secure(false, `${ORIGIN}/auth/confirm`, { "X-Forwarded-Proto": "https" })).toBe(false);
    expect(await secure(true, `${ORIGIN}/auth/confirm`, { "X-Forwarded-Proto": "https" })).toBe(true);
  });

  it("builds the link from the host the browser used, behind a trusted proxy from X-Forwarded-Host", async () => {
    const harness = createLiveHarness({ trustProxy: true });
    const headers = { Host: "localhost:3000", "X-Forwarded-Host": "app.example.com", "X-Forwarded-Proto": "https", Origin: "https://app.example.com" };
    expect((await requestSignInLink(linkRequest("owner@example.com", "/", headers), harness.setup, fresh())).status).toBe(204);
    expect(harness.gotrue.lastLink("owner@example.com")).toMatch(/^https:\/\/app\.example\.com\/auth\/confirm\?/);
  });

  it("refuses a used, unknown or malformed link and sends the browser back to sign in", async () => {
    const harness = createLiveHarness();
    await requestSignInLink(linkRequest("owner@example.com", "/calendar"), harness.setup, fresh());
    const link = harness.gotrue.lastLink("owner@example.com")!;
    expect((await open(harness, link)).status).toBe(303);
    const reused = await open(harness, link);
    expect(reused.headers.get("location")).toBe("/sign-in?error=link&next=%2Fcalendar");
    expect(setCookies(reused).size).toBe(0);
    for (const query of ["token_hash=nope&type=email", "type=email", "token_hash=abc&type=signup", "token_hash=abc"]) {
      expect((await open(harness, `${ORIGIN}/auth/confirm?${query}`)).headers.get("location"), query).toBe("/sign-in?error=link");
    }
    expect(harness.store.sessions.size).toBe(1);
  });

  it("only ever sends the browser to a page on this site", async () => {
    const harness = createLiveHarness();
    for (const next of ["//evil.example/", "/\t/evil.example/", "https://evil.example/", "/.//evil.example/", "/%2e//evil.example/", "javascript:alert(1)"]) {
      await requestSignInLink(linkRequest("owner@example.com", next), harness.setup, fresh());
      const location = (await open(harness, harness.gotrue.lastLink("owner@example.com")!)).headers.get("location")!;
      expect(location, next).toMatch(/^\/(?![/\\])/);
      // A tampered link's next is checked again on the way in.
      const tampered = new URL(harness.gotrue.lastLink("owner@example.com")!);
      tampered.searchParams.set("next", next);
      expect((await open(harness, tampered.href)).headers.get("location"), next).toMatch(/^\/sign-in\?error=link(&next=%2F(?!%2F))?/);
    }
  });

  it("refuses bad requests before calling Supabase", async () => {
    const harness = createLiveHarness();
    const limiter = fresh({ perAddress: 100 });
    expect((await ask("owner@example.com", { Origin: "https://evil.example" }, limiter, harness)).status).toBe(403);
    expect((await ask("owner@example.com", { "Sec-Fetch-Site": "cross-site" }, limiter, harness)).status).toBe(403);
    expect((await ask("owner@example.com", { "Content-Type": "text/plain" }, limiter, harness)).status).toBe(415);
    expect((await ask("not-an-email", {}, limiter, harness)).status).toBe(400);
    const get = new Request(`${ORIGIN}/api/sign-in`, { headers: sameOrigin() });
    expect((await requestSignInLink(get, harness.setup, limiter)).status).toBe(405);
    expect(harness.gotrue.calls).toHaveLength(0);
  });

  it("says Supabase is unavailable, and passes its rate limit on", async () => {
    const harness = createLiveHarness();
    const store = sharedLimiterStore();
    const limiter = store.limiter({ perAddress: 3 });
    harness.config.fetch = async () => { throw new TypeError("fetch failed"); };
    expect((await ask("owner@example.com", {}, limiter, harness)).status).toBe(502);
    // Nothing was sent, but the attempt stays charged: the shared limiter has no refund.
    harness.config.fetch = async () => Response.json({ code: 429, error_code: "over_email_send_rate_limit", msg: "slow down" }, { status: 429 });
    const limited = await ask("owner@example.com", {}, limiter, harness);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(store.calls.filter((call) => (call.body as { scope: string }).scope === "address")).toHaveLength(2);
  });

  it("has nothing to sign in to in demo mode and refuses when live mode is not set up", async () => {
    expect((await requestSignInLink(linkRequest("owner@example.com"), null, fresh())).status).toBe(404);
    const unset = await requestSignInLink(linkRequest("owner@example.com"), { ok: false, problem: "no key" }, fresh());
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "misconfigured" });
    expect((await confirmSignIn(new Request(`${ORIGIN}/auth/confirm?token_hash=x&type=email`), null)).headers.get("location")).toBe("/");
  });
});

describe("sign-out", () => {
  const signOutRequest = (cookie: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/sign-out`, { method: "POST", headers: { Cookie: cookie, ...sameOrigin(headers) } });

  it("revokes the session in Supabase and clears the cookies, so a replayed cookie gets 401", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    const stolen = jar.header();
    const response = await signOut(signOutRequest(stolen), harness.setup);
    expect(response.status).toBe(204);
    expect(harness.store.sessions.size).toBe(0);
    jar.apply(response);
    expect(jar.values.size).toBe(0);
    // The old cookies still hold an unexpired access token; the API refuses its session.
    const replay = await proxyApiRequest(new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers: { Cookie: stolen } }), ["v1", "crm", "contacts"], harness.setup);
    expect(replay.status).toBe(401);
  });

  it("ends only this device's session: the same person signed in elsewhere stays signed in", async () => {
    const harness = createLiveHarness();
    const phone = await signInThroughLink(harness);
    const laptop = await signInThroughLink(harness);
    expect(harness.store.sessions.size).toBe(2);
    expect((await signOut(signOutRequest(phone.header()), harness.setup)).status).toBe(204);
    expect(harness.store.sessions.size).toBe(1);
    const contacts = (jar: Jar) =>
      proxyApiRequest(new Request(`${ORIGIN}/api/v1/crm/contacts`, { headers: { Cookie: jar.header() } }), ["v1", "crm", "contacts"], harness.setup);
    expect((await contacts(phone)).status).toBe(401);
    expect((await contacts(laptop)).status).toBe(200);
  });

  it("keeps the cookies when Supabase cannot be reached and says so, so a retry can still revoke the session", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    const fetchOk = harness.config.fetch!;
    harness.config.fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes("/logout")) throw new TypeError("fetch failed");
      return fetchOk(input, init);
    };
    const failed = await signOut(signOutRequest(jar.header()), harness.setup);
    expect(failed.status).toBe(502);
    // Every session cookie the browser held is still there.
    const held = [...jar.values.keys()].sort();
    jar.apply(failed);
    expect(held.length).toBeGreaterThan(0);
    expect([...jar.values.keys()].sort()).toEqual(held);
    expect(harness.store.sessions.size).toBe(1);

    harness.config.fetch = fetchOk;
    const retried = await signOut(signOutRequest(jar.header()), harness.setup);
    expect(retried.status).toBe(204);
    expect(harness.store.sessions.size).toBe(0);
    jar.apply(retried);
    expect(jar.values.size).toBe(0);
  });

  it("clears the retired pilot cookie, works without a session or settings, and refuses other sites", async () => {
    const harness = createLiveHarness();
    const pilot = await signOut(signOutRequest(`${PILOT_COOKIE}=v1.1.a.b`), harness.setup);
    expect(pilot.status).toBe(204);
    expect(setCookies(pilot).get(PILOT_COOKIE)?.value).toBeNull();
    // Without settings nothing can revoke a session: a session cookie gets 503 and is kept.
    const unset = await signOut(signOutRequest(`${AUTH_COOKIE}.0=x; ${PILOT_COOKIE}=y`), { ok: false, problem: "unset" });
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "sign_out_unavailable" });
    expect(setCookies(unset).size).toBe(0);
    expect((await signOut(signOutRequest(`${AUTH_COOKIE}=x`), null)).status).toBe(503);
    const pilotOnly = await signOut(signOutRequest(`${PILOT_COOKIE}=y`), { ok: false, problem: "unset" });
    expect(pilotOnly.status).toBe(204);
    // The connect cookies sit under /api/connections, which sign-out is never sent, so all three expire too.
    expect([...setCookies(pilotOnly).keys()].sort()).toEqual([PILOT_COOKIE, "zs-connect-attempt", "zs-connect-browser", "zs-connect-grant"].sort());
    expect((await signOut(signOutRequest("", {}), null)).status).toBe(204);
    expect((await signOut(signOutRequest("", { Origin: "https://evil.example" }), harness.setup)).status).toBe(403);
  });
});

describe("sign-in rate limits", () => {
  /** Behind a trusted proxy, so X-Forwarded-For names the caller. */
  const proxied = () => createLiveHarness({ trustProxy: true });

  it("trips the per-address limit, then the window passes", async () => {
    const harness = proxied();
    const store = sharedLimiterStore();
    const limiter = store.limiter();
    const from = (address: string) =>
      requestSignInLink(linkRequest("owner@example.com", "/", { "X-Forwarded-For": address }), harness.setup, limiter).then((response) => response.status);
    for (let index = 0; index < LIMITS.perAddress; index += 1) expect(await from("203.0.113.7")).toBe(204);
    const limited = await requestSignInLink(linkRequest("owner@example.com", "/", { "X-Forwarded-For": "203.0.113.7" }), harness.setup, limiter);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBe(15 * 60);
    expect(await from("198.51.100.4")).toBe(204);
    store.now += WINDOW_MS + 1000;
    expect(await from("203.0.113.7")).toBe(204);
  });

  it("trips the global limit across many addresses", async () => {
    const harness = proxied();
    const limiter = fresh();
    for (let index = 0; index < LIMITS.global; index += 1) {
      expect((await requestSignInLink(linkRequest(`x${index}@example.com`, "/", { "X-Forwarded-For": `192.0.2.${index}` }), harness.setup, limiter)).status).toBe(204);
    }
    expect((await requestSignInLink(linkRequest("owner@example.com", "/", { "X-Forwarded-For": "192.0.2.250" }), harness.setup, limiter)).status).toBe(429);
  });

  it("counts a malformed body, and lets at most the limit past when requests arrive together", async () => {
    const harness = createLiveHarness();
    const limiter = fresh({ perAddress: 2 });
    const garbled = new Request(`${ORIGIN}/api/sign-in`, { method: "POST", body: "{", headers: { "Content-Type": "application/json", ...sameOrigin() } });
    expect((await requestSignInLink(garbled, harness.setup, limiter)).status).toBe(400);
    expect((await ask("owner@example.com", {}, limiter, harness)).status).toBe(204);
    expect((await ask("owner@example.com", {}, limiter, harness)).status).toBe(429);

    const together = fresh();
    const statuses = await Promise.all(Array.from({ length: 40 }, () => ask("owner@example.com", {}, together, harness).then((response) => response.status)));
    expect(statuses.filter((status) => status !== 429)).toHaveLength(LIMITS.perAddress);
  });

  it("holds the limits across two dashboard instances that share the limiter store", async () => {
    const harness = proxied();
    const store = sharedLimiterStore();
    const instances = [store.limiter(), store.limiter()];
    const from = (index: number, address: string, email = "owner@example.com") =>
      requestSignInLink(linkRequest(email, "/", { "X-Forwarded-For": address }), harness.setup, instances[index % 2]!).then((response) => response.status);
    const statuses = [];
    for (let index = 0; index < LIMITS.perAddress + 2; index += 1) statuses.push(await from(index, "203.0.113.50", `p${index}@example.com`));
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429, 429]);
    // The per-email limit holds across them too, for any address.
    const emailLimited = sharedLimiterStore();
    const pair = [emailLimited.limiter({ perEmail: 2 }), emailLimited.limiter({ perEmail: 2 })];
    const viaPair = (index: number) => requestSignInLink(linkRequest("owner@example.com", "/", { "X-Forwarded-For": `198.51.100.${index + 1}` }), harness.setup, pair[index % 2]!).then((response) => response.status);
    expect([await viaPair(0), await viaPair(1), await viaPair(2), await viaPair(3)]).toEqual([204, 204, 429, 429]);
  });

  it("limits one email address however many addresses ask, answering 429 with Retry-After, and still answers 204 for an unknown one", async () => {
    const harness = proxied();
    const store = sharedLimiterStore();
    const limiter = store.limiter({ perEmail: 2 });
    const ask429 = (email: string, index: number) =>
      requestSignInLink(linkRequest(email, "/", { "X-Forwarded-For": `192.0.2.${index + 1}` }), harness.setup, limiter);
    expect((await ask429("nobody@example.com", 0)).status).toBe(204);
    expect((await ask429("NoBody@example.com ", 1)).status).toBe(204);
    const limited = await ask429("nobody@example.com", 2);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBe(15 * 60);
    // Another email address is untouched, known or not.
    expect((await ask429("owner@example.com", 3)).status).toBe(204);
    // Only the hash of the lowercased address reaches the limiter.
    const emailCalls = store.calls.filter((call) => (call.body as { scope: string }).scope === "email");
    expect(emailCalls.map((call) => call.body)).toContainEqual({ scope: "email", emailHash: createHash("sha256").update("nobody@example.com").digest("hex"), perEmail: 2 });
    expect(JSON.stringify(store.calls.map((call) => call.body))).not.toMatch(/example\.com/);
  });

  it("fails closed: sends no link and answers 502 when the limiter is down, unreachable, unconfigured or refuses the secret", async () => {
    const harness = proxied();
    const store = sharedLimiterStore();
    const attempt = (limiter: ReturnType<typeof store.limiter>) => requestSignInLink(linkRequest("owner@example.com"), harness.setup, limiter);
    store.outage = "down";
    expect((await attempt(store.limiter())).status).toBe(502);
    store.outage = "unreachable";
    expect((await attempt(store.limiter())).status).toBe(502);
    store.outage = null;
    const unconfigured = await attempt(store.limiter({}, null));
    expect(unconfigured.status).toBe(502);
    expect(await unconfigured.json()).toEqual({ error: "unavailable" });
    expect((await attempt(createSharedSignInLimiter({ apiUrl: "http://api.internal:8787", secret: "w".repeat(40), limits: LIMITS, fetch: store.fetch }))).status).toBe(502);
    expect(harness.gotrue.calls).toHaveLength(0);
    expect((await attempt(store.limiter())).status).toBe(204);
    expect(LIMITER_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("ignores X-Forwarded-For without a trusted proxy and keys on its right-most entry behind one", () => {
    const request = (value: string) => linkRequest("a@example.com", "/", { "X-Forwarded-For": value });
    expect(clientAddress(request("1.2.3.4, 203.0.113.9"), true)).toBe("203.0.113.9");
    expect(clientAddress(request("1.2.3.4, 203.0.113.9"), false)).toBe(DIRECT_ADDRESS);
    expect(clientAddress(request(""), true)).toBe(DIRECT_ADDRESS);
  });

  it("reads its limits from env, falling back on bad values", () => {
    expect(attemptLimitsFromEnv({})).toEqual(LIMITS);
    expect(attemptLimitsFromEnv({ DASHBOARD_SIGN_IN_PER_ADDRESS: "50", DASHBOARD_SIGN_IN_GLOBAL: "200", DASHBOARD_SIGN_IN_PER_EMAIL: "9" })).toEqual({ perAddress: 50, global: 200, perEmail: 9 });
    expect(attemptLimitsFromEnv({ DASHBOARD_SIGN_IN_PER_ADDRESS: "0", DASHBOARD_SIGN_IN_GLOBAL: "lots", DASHBOARD_SIGN_IN_PER_EMAIL: "-1" })).toEqual(LIMITS);
  });
});

describe("sign-in body limits", () => {
  /** A sign-in request whose body is a stream: chunked, with no Content-Length unless given. */
  const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/api/sign-in`, { method: "POST", body, duplex: "half", headers: { "Content-Type": "application/json", ...sameOrigin(), ...headers } } as RequestInit);

  it("cancels an oversize chunked upload past 2 KiB, and the attempt still counts", async () => {
    const harness = createLiveHarness();
    const limiter = fresh({ perAddress: 1 });
    // 64 chunks of 512 bytes, 32 KiB in all: the fifth takes it past 2048.
    const { stream, state } = chunkedBody(chunks(64, 512));
    const response = await requestSignInLink(streamed(stream), harness.setup, limiter);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(state.served).toBe(5);
    expect(harness.gotrue.calls).toHaveLength(0);
    expect((await ask("owner@example.com", {}, limiter, harness)).status).toBe(429);
  });

  it("refuses a declared Content-Length over 2 KiB without reading the body", async () => {
    const harness = createLiveHarness();
    const { stream, state } = chunkedBody(chunks(64, 512));
    const response = await requestSignInLink(streamed(stream, { "Content-Length": "32768" }), harness.setup, fresh());
    expect(response.status).toBe(413);
    expect(state.pulls).toBe(0);
  });

  it("reserves the attempt before reading, so parallel oversize uploads are all charged", async () => {
    const harness = createLiveHarness();
    const limiter = fresh({ perAddress: 3 });
    const stalled = Array.from({ length: 5 }, () => chunkedBody([], "stall"));
    const timers = stalled.map(() => manualTimer());
    const pending = stalled.map(({ stream }, index) => requestSignInLink(streamed(stream), harness.setup, limiter, { timer: timers[index]!.start }));
    await settle();
    // Three wait for their bodies; the other two were refused before anything was read.
    expect(stalled.map(({ state }) => state.pulls > 0)).toEqual([true, true, true, false, false]);
    for (const { timer } of timers) timer.fire();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([408, 408, 408, 429, 429]);
    expect(stalled.slice(0, 3).every(({ state }) => state.cancelled)).toBe(true);
  });

  it("answers 408 to a body that misses its deadline and 400 to one that breaks off", async () => {
    const harness = createLiveHarness();
    const limiter = fresh({ perAddress: 100 });
    const slow = chunkedBody(chunks(1, 10), "stall");
    const { timer, start } = manualTimer();
    const pending = requestSignInLink(streamed(slow.stream), harness.setup, limiter, { timer: start });
    await settle();
    timer.fire();
    const late = await pending;
    expect(late.status).toBe(408);
    expect(await late.json()).toEqual({ error: "timeout" });
    expect(timer.started).toEqual([10_000]);
    const broken = await requestSignInLink(streamed(chunkedBody(chunks(1, 10), "fail").stream), harness.setup, limiter);
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: "bad_request" });
    expect(harness.gotrue.calls).toHaveLength(0);
  });
});
