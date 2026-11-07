// The HTTP client reads and writes the managed-tier connection routes with the contract schemas
// (connections.md C-4, C-5, C-13). The connect flow goes to the dashboard's own routes under
// /api/connections; the list and the disconnect go through the generic proxy.
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const CONNECTION = "b7d9f1a3-5c7e-4a9b-8d1f-000000000001";
const GRANT_ID = "g".repeat(43);
const AUTHORIZE_URL = "https://connect.composio.test/link/lk_1";

interface Call { url: URL; init: RequestInit }

function client(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "/api",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { error: { code, message: "x", details } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const key = (n: number) => ({ idempotencyKey: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });

const connection = {
  id: CONNECTION, toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com", status: "active",
  reauthorizeReason: null, revokeFailed: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z",
};
const pending = { grantId: GRANT_ID, toolkit: "shopify", shopDomain: "halden-rowe.myshopify.com", accountLabel: "Halden Rowe", expiresAt: "2026-11-06T12:10:00.000Z", tokensWithAccess: 2 };

describe("http client: managed connections", () => {
  it("lists from GET /v1/connections and refuses a connection that is not in contract shape", async () => {
    const { api, calls } = client([json(200, { items: [connection] }), json(200, { items: [{ ...connection, status: "paused" }] }), json(200, { items: [{ ...connection, composioAccountId: "ca_1" }] })]);
    expect(await api.listManagedConnections()).toEqual([connection]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/connections");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.cache).toBe("no-store");
    await expect(api.listManagedConnections()).rejects.toMatchObject({ kind: "invalid_response" });
    // A provider ID is never part of what an owner sees.
    await expect(api.listManagedConnections()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("starts a connect at the dashboard's own route with only the shop domain, no key, and answers the address alone", async () => {
    const { api, calls } = client([json(200, { authorizeUrl: AUTHORIZE_URL })]);
    expect(await api.startManagedConnect("shopify", "halden-rowe.myshopify.com")).toEqual({ authorizeUrl: AUTHORIZE_URL });
    expect(calls[0]!.url.pathname).toBe("/api/connections/shopify/connect");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBeUndefined();
    expect(body(calls[0])).toEqual({ shopDomain: "halden-rowe.myshopify.com" });
  });

  it("passes on no settings (404), a staff member (403), a connected store (409) and too many tries (429)", async () => {
    const { api } = client([apiError(404, "NotFound"), apiError(403, "Forbidden"), apiError(409, "Conflict", { reason: "already_connected" }), apiError(429, "RateLimited")]);
    await expect(api.startManagedConnect("shopify", "a.myshopify.com")).rejects.toMatchObject({ kind: "not_found", status: 404 });
    await expect(api.startManagedConnect("shopify", "a.myshopify.com")).rejects.toMatchObject({ kind: "forbidden", status: 403 });
    await expect(api.startManagedConnect("shopify", "a.myshopify.com")).rejects.toMatchObject({ kind: "conflict", reason: "already_connected" });
    await expect(api.startManagedConnect("shopify", "a.myshopify.com")).rejects.toMatchObject({ kind: "rate_limited", status: 429 });
  });

  it("refuses an address that is not https, and one that carries extra keys", async () => {
    const { api } = client([json(200, { authorizeUrl: "javascript:alert(1)" }), json(200, { authorizeUrl: "http://insecure.test/x" }), json(200, { authorizeUrl: AUTHORIZE_URL, attempt: "zca1.x.y" })]);
    for (let n = 0; n < 3; n += 1) await expect(api.startManagedConnect("shopify", "a.myshopify.com")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reads the waiting grant from /api/connections/pending, and answers null when none waits", async () => {
    const { api, calls } = client([json(200, pending), apiError(404, "NotFound"), apiError(403, "Forbidden"), json(200, { ...pending, shopDomain: "not-a-shop.example.com" })]);
    expect(await api.getPendingManagedConnect()).toEqual(pending);
    expect(calls[0]!.url.pathname).toBe("/api/connections/pending");
    expect(calls[0]!.init.method).toBe("GET");
    expect(await api.getPendingManagedConnect()).toBeNull();
    await expect(api.getPendingManagedConnect()).rejects.toMatchObject({ kind: "forbidden" });
    await expect(api.getPendingManagedConnect()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("confirms with only the grant ID and no key of its own, answering the connection", async () => {
    const { api, calls } = client([json(200, connection), apiError(409, "Conflict", { reason: "grant_changed" }), apiError(404, "NotFound")]);
    expect(await api.confirmManagedConnect(GRANT_ID)).toEqual(connection);
    expect(calls[0]!.url.pathname).toBe("/api/connections/confirm");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBeUndefined();
    expect(body(calls[0])).toEqual({ grantId: GRANT_ID });
    await expect(api.confirmManagedConnect(GRANT_ID)).rejects.toMatchObject({ kind: "conflict", reason: "grant_changed" });
    await expect(api.confirmManagedConnect(GRANT_ID)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("cancels with DELETE /api/connections/pending, which answers 204", async () => {
    const { api, calls } = client([new Response(null, { status: 204 })]);
    await expect(api.cancelManagedConnect()).resolves.toBeUndefined();
    expect(calls[0]!.url.pathname).toBe("/api/connections/pending");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("asks the status route how a pending connect ended, and refuses an outcome it does not know", async () => {
    const { api, calls } = client([json(200, { connection: "pending" }), json(200, { connection: "error", reason: "expired" }), json(200, { connection: "connected" }), json(200, { connection: "done" })]);
    expect(await api.checkManagedConnectStatus()).toEqual({ connection: "pending" });
    expect(calls[0]!.url.pathname).toBe("/api/connections/callback/status");
    expect(calls[0]!.init.method).toBe("GET");
    expect(await api.checkManagedConnectStatus()).toEqual({ connection: "error", reason: "expired" });
    expect(await api.checkManagedConnectStatus()).toEqual({ connection: "connected" });
    await expect(api.checkManagedConnectStatus()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("disconnects with POST /v1/connections/:id/disconnect, the caller's key and an empty body, answering the connection", async () => {
    const disconnecting = { ...connection, status: "disconnecting", revokeFailed: true };
    const { api, calls } = client([json(200, { actionId: ACTION, result: disconnecting })]);
    expect(await api.disconnectManagedConnection(CONNECTION, key(1))).toEqual(disconnecting);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/connections/${CONNECTION}/disconnect`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBe(key(1).idempotencyKey);
    expect(body(calls[0])).toEqual({});
  });
});
