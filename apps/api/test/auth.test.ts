import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { apiErrorBodySchema } from "@zs/contracts";
import { createHs256Verifier } from "../src/auth.js";
import { signDevToken } from "../src/dev-token.js";
import { call, clock, createApiHarness, NOW, ORIGIN, SECRET, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

const expect401 = (response: { status: number; body: unknown }) => {
  expect(response.status).toBe(401);
  expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Unauthorized");
};

describe("authentication", () => {
  it("serves /healthz without a token", async () => {
    expect(await call(h.app, "GET", "/healthz")).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("rejects a missing token", async () => {
    const response = await call(h.app, "GET", "/v1/crm/contacts");
    expect401(response);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("rejects a malformed Authorization header", async () => {
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { headers: { Authorization: `Basic ${h.a.token}` } }));
  });

  it("rejects an expired token", async () => {
    const past = { now: () => new Date("2026-10-18T06:00:00.000Z") };
    const token = await signDevToken(SECRET, h.a, past, 3600);
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signDevToken("another-secret-that-is-32-chars-long!!", h.a,
      { now: () => new Date("2026-10-19T07:59:00.000Z") });
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects a valid signature without a tenant claim", async () => {
    const token = await new SignJWT({ role: "authenticated", session_id: h.a.sessionId })
      .setProtectedHeader({ alg: "HS256" }).setSubject(h.a.actorId).setAudience("authenticated")
      .setIssuedAt(Math.floor(Date.parse(NOW) / 1000))
      .setExpirationTime(Math.floor(Date.parse("2026-10-19T09:00:00.000Z") / 1000))
      .sign(new TextEncoder().encode(SECRET));
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects a valid signature without a session_id claim", async () => {
    const token = await new SignJWT({ role: "authenticated", app_metadata: { tenant_id: h.a.tenantId } })
      .setProtectedHeader({ alg: "HS256" }).setSubject(h.a.actorId).setAudience("authenticated")
      .setIssuedAt(Math.floor(Date.parse(NOW) / 1000))
      .setExpirationTime(Math.floor(Date.parse("2026-10-19T09:00:00.000Z") / 1000))
      .sign(new TextEncoder().encode(SECRET));
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects an unsigned (alg none) token", async () => {
    const [, payload] = h.a.token.split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token: `${header}.${payload}.` }));
  });
});

const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
/** A correctly signed token for tenant A; each test overrides one claim. */
function token(claims: Record<string, unknown>, { iat = nowSeconds as number | null, exp = nowSeconds + 600 } = {}) {
  const jwt = new SignJWT({ role: "authenticated", session_id: h.a.sessionId, app_metadata: { tenant_id: h.a.tenantId }, ...claims })
    .setProtectedHeader({ alg: "HS256" }).setSubject(h.a.actorId).setAudience("authenticated").setExpirationTime(exp);
  if (iat !== null) jwt.setIssuedAt(iat);
  return jwt.sign(new TextEncoder().encode(SECRET));
}

describe("token claims", () => {
  it("accepts the role authenticated and refuses any other role or none", async () => {
    expect((await call(h.app, "GET", "/v1/crm/contacts", { token: await token({}) })).status).toBe(200);
    for (const role of ["service_role", "anon", undefined])
      expect401(await call(h.app, "GET", "/v1/crm/contacts", { token: await token({ role }) }));
  });

  it("checks iss when an issuer is configured", async () => {
    const issuer = "https://example.supabase.co/auth/v1";
    const verifier = createHs256Verifier(SECRET, { clock, issuer });
    await expect(verifier.verify(await token({ iss: issuer }))).resolves.toMatchObject({ tenantId: h.a.tenantId });
    await expect(verifier.verify(await token({ iss: "https://evil.example/auth/v1" }))).rejects.toThrow("Invalid or missing");
    await expect(verifier.verify(await token({}))).rejects.toThrow("Invalid or missing");
  });

  // The accepted cases: iat is required, may lie up to the skew (default 60 s) ahead of the
  // clock, and exp - iat may be at most the maximum lifetime (default one hour).
  const status = async (times: { iat?: number | null; exp?: number }) =>
    (await call(h.app, "GET", "/v1/crm/contacts", { token: await token({}, times) })).status;

  it("accepts a full-lifetime token whose iat is a second ahead of the clock", async () => {
    expect(await status({ iat: nowSeconds + 1, exp: nowSeconds + 1 + 3600 })).toBe(200);
    expect(await status({ iat: nowSeconds + 60, exp: nowSeconds + 60 + 3600 })).toBe(200);
  });

  it("refuses an iat beyond the skew", async () => {
    expect(await status({ iat: nowSeconds + 61, exp: nowSeconds + 61 + 600 })).toBe(401);
    expect(await status({ iat: nowSeconds + 120, exp: nowSeconds + 120 + 600 })).toBe(401);
  });

  it("refuses a token without iat", async () => {
    expect(await status({ iat: null, exp: nowSeconds + 600 })).toBe(401);
  });

  it("refuses a lifetime exp - iat above the maximum", async () => {
    expect(await status({ exp: nowSeconds + 3600 })).toBe(200);
    expect(await status({ exp: nowSeconds + 3601 })).toBe(401);
    expect(await status({ iat: nowSeconds - 3000, exp: nowSeconds + 601 })).toBe(401);
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token: await signDevToken(SECRET, h.a, clock) }));
  });

  it("applies a configured skew", async () => {
    const strict = createHs256Verifier(SECRET, { clock, clockSkewSeconds: 0 });
    await expect(strict.verify(await token({}, { iat: nowSeconds }))).resolves.toMatchObject({ tenantId: h.a.tenantId });
    await expect(strict.verify(await token({}, { iat: nowSeconds + 1, exp: nowSeconds + 600 }))).rejects.toThrow(/future/);
    expect(() => createHs256Verifier(SECRET, { clock, clockSkewSeconds: -1 })).toThrow(/skew/);
  });

  it("accepts the 7-day dev token when local config raises the limit", async () => {
    const verifier = createHs256Verifier(SECRET, { clock, maxLifetimeSeconds: 7 * 24 * 3600 });
    await expect(verifier.verify(await signDevToken(SECRET, h.a, clock)))
      .resolves.toEqual({ tenantId: h.a.tenantId, actorId: h.a.actorId, sessionId: h.a.sessionId });
    expect(() => createHs256Verifier(SECRET, { clock, maxLifetimeSeconds: 0 })).toThrow(/positive/);
  });
});

describe("CORS", () => {
  it("allows only configured origins", async () => {
    const allowed = await call(h.app, "OPTIONS", "/v1/crm/contacts", {
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const denied = await call(h.app, "OPTIONS", "/v1/crm/contacts", {
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
