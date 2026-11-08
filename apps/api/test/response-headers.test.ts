import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, createHs256Verifier } from "../src/app.js";
import { isPrivateApiPath, responseHeaders } from "../src/response-headers.js";
import { call, clock, createApiHarness, ORIGIN, SECRET, type ApiHarness } from "./helpers.js";

// Every API answer says nosniff; every private (signed-in, worker, automation) answer is no-store
// unless its route chose a Cache-Control on purpose.

describe("responseHeaders on the real app", () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await createApiHarness({ publicIntake: {} });
  });
  afterAll(async () => {
    await h?.close();
  });

  it("marks an authenticated /v1 answer nosniff and no-store", async () => {
    const reply = await call(h.app, "GET", "/v1/me", { token: h.a.token });
    expect(reply.status).toBe(200);
    expect(reply.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(reply.headers.get("Content-Type")).toContain("application/json");
  });

  it("marks /v1 error answers too: 401, 404 behind auth, 400 from a handler", async () => {
    const missing = await call(h.app, "GET", "/v1/me");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(missing.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(missing.headers.get("Cache-Control")).toBe("no-store");

    const unknown = await call(h.app, "GET", "/v1/no-such-route", { token: h.a.token });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(unknown.headers.get("Cache-Control")).toBe("no-store");

    const invalid = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: randomUUID(), body: { nope: true } });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(invalid.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the CORS preflight nosniff and leaves its allow headers alone", async () => {
    const response = await h.app.request("/v1/me", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" },
    });
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("marks a public JSON answer nosniff and does not make it no-store", async () => {
    const health = await call(h.app, "GET", "/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(health.headers.get("Cache-Control")).toBeNull();

    const notFound = await call(h.app, "GET", "/no-such-route");
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(notFound.headers.get("Cache-Control")).toBeNull();
  });

  it("keeps the cache headers a public route chose on purpose", async () => {
    const script = await h.app.request("/booker.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(script.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(script.headers.get("Content-Type")).toContain("javascript");
  });
});

describe("responseHeaders without a database", () => {
  const app = createApp({
    verifier: createHs256Verifier(SECRET, { clock }),
    sessionCheck: { isLive: () => Promise.reject(new Error("unused")) },
    clock,
    db: { tenant: () => Promise.reject(new Error("unused")), withoutTenant: () => Promise.reject(new Error("unused")) },
    generateId: randomUUID,
    config: { allowedOrigins: [] },
    ready: () => Promise.resolve(false),
    onError: () => undefined,
  });
  app.get("/test/boom", () => {
    throw new Error("internal detail");
  });

  it("marks an unexpected 500 and keeps the detail out of the body", async () => {
    const response = await app.request("/test/boom");
    expect(response.status).toBe(500);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).not.toContain("internal detail");
  });

  it("marks the readiness 503 and keeps its own no-store and Retry-After", async () => {
    const response = await app.request("/readyz");
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});

describe("responseHeaders rules", () => {
  const app = new Hono();
  app.use("*", responseHeaders);
  app.get("/v1/plain", (c) => c.json({ ok: true }));
  app.get("/v1/own", (c) => c.json({ ok: true }, 200, { "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" }));
  app.get("/mcp", (c) => c.json({ ok: true }));
  app.get("/public/page", (c) => c.json({ ok: true }, 200, { "Cache-Control": "public, max-age=300" }));

  it("fills no-store only where the route set no Cache-Control", async () => {
    expect((await app.request("/v1/plain")).headers.get("Cache-Control")).toBe("no-store");
    expect((await app.request("/v1/own")).headers.get("Cache-Control")).toBe("private, max-age=60");
    expect((await app.request("/mcp")).headers.get("Cache-Control")).toBe("no-store");
    expect((await app.request("/public/page")).headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("matches whole path segments", () => {
    expect(isPrivateApiPath("/v1")).toBe(true);
    expect(isPrivateApiPath("/v1/crm/contacts")).toBe(true);
    expect(isPrivateApiPath("/mcp")).toBe(true);
    expect(isPrivateApiPath("/cron/billing")).toBe(true);
    expect(isPrivateApiPath("/v10/x")).toBe(false);
    expect(isPrivateApiPath("/mcpx")).toBe(false);
    expect(isPrivateApiPath("/public/v1/book")).toBe(false);
    expect(isPrivateApiPath("/healthz")).toBe(false);
  });
});
