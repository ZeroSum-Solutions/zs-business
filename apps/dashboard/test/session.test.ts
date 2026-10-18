import { describe, expect, it } from "vitest";
import { readSession, sessionResponse } from "../src/lib/server/session";

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
