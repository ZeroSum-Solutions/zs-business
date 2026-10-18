import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { apiErrorBodySchema } from "@zs/contracts";
import { signDevToken } from "../src/dev-token.js";
import { call, createApiHarness, ORIGIN, SECRET, type ApiHarness } from "./helpers.js";

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
    const token = await signDevToken(SECRET, { tenantId: h.a.tenantId, actorId: h.a.actorId }, past, 3600);
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects a token signed with another secret", async () => {
    const token = await signDevToken("another-secret-that-is-32-chars-long!!", { tenantId: h.a.tenantId, actorId: h.a.actorId },
      { now: () => new Date("2026-10-19T07:59:00.000Z") });
    expect401(await call(h.app, "GET", "/v1/crm/contacts", { token }));
  });

  it("rejects a valid signature without a tenant claim", async () => {
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(h.a.actorId).setAudience("authenticated")
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
