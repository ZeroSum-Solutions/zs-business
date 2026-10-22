import { describe, expect, it } from "vitest";
import { sessionForRequest } from "../src/lib/server/session";
import { PILOT_COOKIE } from "../src/lib/server/supabase";
import { createLiveHarness, forwardedClaims, LIVE_BUSINESS, ORIGIN, setCookies, signInThroughLink } from "./helpers/live";

const request = (cookie?: string) => new Request(`${ORIGIN}/api/session`, { headers: cookie ? { Cookie: cookie } : {} });

describe("GET /api/session", () => {
  it("names the business, person and role the API's /v1/me reports for the person's own token", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    const response = await sessionForRequest(request(jar.header()), harness.setup);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      tenantId: harness.tenantId, userId: harness.owner.id, role: "owner", businessName: LIVE_BUSINESS, email: harness.owner.email,
    });
    expect(harness.apiCalls.map((call) => call.url)).toEqual(["http://api.internal:8787/v1/me"]);
    expect(forwardedClaims(harness.apiCalls[0]!).sub).toBe(harness.owner.id);
  });

  it("works with an older API that does not name the business or the email", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    const live = harness.api;
    harness.api = async (call) => {
      const answer = await live(call);
      const { businessName: _name, email: _email, ...older } = await answer.json();
      return Response.json(older, { status: answer.status });
    };
    const response = await sessionForRequest(request(jar.header()), harness.setup);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: harness.tenantId, userId: harness.owner.id, role: "owner" });
  });

  it("ignores keys a newer API adds", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    const live = harness.api;
    harness.api = async (call) => Response.json({ ...(await (await live(call)).json()), timeZone: "UTC" });
    const response = await sessionForRequest(request(jar.header()), harness.setup);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenantId: harness.tenantId, userId: harness.owner.id, role: "owner", businessName: LIVE_BUSINESS, email: harness.owner.email,
    });
  });

  it("is signed out with no cookie, and expired with the retired pilot cookie, which it expires", async () => {
    const harness = createLiveHarness();
    const none = await sessionForRequest(request(), harness.setup);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "signed_out" });
    const pilot = await sessionForRequest(request(`${PILOT_COOKIE}=v1.9999999999.abc.def`), harness.setup);
    expect(pilot.status).toBe(401);
    expect(await pilot.json()).toEqual({ error: "expired" });
    expect(setCookies(pilot).get(PILOT_COOKIE)?.value).toBeNull();
    expect(harness.apiCalls).toHaveLength(0);
  });

  it("is expired, and drops the cookies, once the session was signed out elsewhere", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    await harness.store.endSession([...harness.store.sessions.keys()][0]!);
    const response = await sessionForRequest(request(jar.header()), harness.setup);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "expired" });
    expect([...setCookies(response).values()].every((cookie) => cookie.value === null)).toBe(true);
  });

  it("says no_access for a signed-in person who is not a member", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    harness.api = async () => Response.json({ error: { code: "Forbidden", message: "Forbidden", details: {} } }, { status: 403 });
    const response = await sessionForRequest(request(jar.header()), harness.setup);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_access" });
  });

  it("is unavailable when the API is down or answers nonsense", async () => {
    const harness = createLiveHarness();
    const jar = await signInThroughLink(harness);
    harness.api = async () => { throw new TypeError("fetch failed"); };
    expect((await sessionForRequest(request(jar.header()), harness.setup)).status).toBe(502);
    harness.api = async () => Response.json({ tenantId: "x" });
    expect((await sessionForRequest(request(jar.header()), harness.setup)).status).toBe(502);
  });

  it("is unconfigured in demo mode and misconfigured without the Supabase settings", async () => {
    const demo = await sessionForRequest(request(), null);
    expect(demo.status).toBe(503);
    expect(await demo.json()).toEqual({ error: "unconfigured" });
    const unset = await sessionForRequest(request(), { ok: false, problem: "no Supabase URL" });
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "misconfigured" });
  });
});
