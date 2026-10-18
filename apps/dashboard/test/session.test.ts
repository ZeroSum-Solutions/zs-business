import { describe, expect, it } from "vitest";
import { readSession, sessionForRequest, sessionResponse } from "../src/lib/server/session";
import { SESSION_COOKIE } from "../src/lib/server/pilot-gate";
import { GATE, sessionCookieHeader } from "./helpers/gate";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const jwt = (claims: object) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const claims = { sub: "user-1", exp: NOW.getTime() / 1000 + 60, app_metadata: { tenant_id: "tenant-1" } };

describe("readSession", () => {
  it("names the tenant and user of the server's token", async () => {
    const result = readSession(jwt(claims), NOW);
    expect(result).toEqual({ status: "signed_in", identity: { tenantId: "tenant-1", userId: "user-1" } });
    const response = sessionResponse(result);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ tenantId: "tenant-1", userId: "user-1" });
  });

  it("is signed out for an expired, tenantless or garbled token", () => {
    expect(readSession(jwt({ ...claims, exp: NOW.getTime() / 1000 }), NOW)).toEqual({ status: "signed_out" });
    expect(readSession(jwt({ sub: "user-1" }), NOW)).toEqual({ status: "signed_out" });
    expect(readSession("not-a-jwt", NOW)).toEqual({ status: "signed_out" });
    expect(sessionResponse({ status: "signed_out" }).status).toBe(401);
  });

  it("is unconfigured with no token, so demo builds never claim a live tenant", () => {
    expect(readSession(undefined, NOW)).toEqual({ status: "unconfigured" });
    expect(readSession("  ", NOW)).toEqual({ status: "unconfigured" });
    expect(sessionResponse({ status: "unconfigured" }).status).toBe(503);
  });
});

describe("GET /api/session", () => {
  const live = { ZS_API_URL: "http://localhost:8787", ZS_API_TOKEN: jwt(claims), DASHBOARD_ACCESS_CODE: GATE.accessCode, DASHBOARD_SESSION_SECRET: GATE.sessionSecret };
  const request = (cookie?: string) => new Request("http://127.0.0.1:3218/api/session", { headers: cookie ? { Cookie: cookie } : {} });

  it("names the tenant only to a caller with a valid pilot session", async () => {
    const response = sessionForRequest(request(sessionCookieHeader(GATE, NOW)), live, NOW);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: "tenant-1", userId: "user-1" });
  });

  it("is signed out with no cookie, and expired with a stale or forged one", async () => {
    const none = sessionForRequest(request(), live, NOW);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: "signed_out" });
    const stale = sessionForRequest(request(sessionCookieHeader(GATE, new Date(NOW.getTime() - (GATE.ttlSeconds + 1) * 1000))), live, NOW);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: "expired" });
    const forged = sessionForRequest(request(`${SESSION_COOKIE}=v1.9999999999.abc.def`), live, NOW);
    expect(forged.status).toBe(401);
  });

  it("refuses to serve live mode without the gate's settings, and is unconfigured in demo mode", async () => {
    const unset = sessionForRequest(request(sessionCookieHeader(GATE, NOW)), { ZS_API_URL: live.ZS_API_URL, ZS_API_TOKEN: live.ZS_API_TOKEN }, NOW);
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "misconfigured" });
    expect(sessionForRequest(request(), {}, NOW).status).toBe(503);
  });
});
