// The HTTP client reads and writes the Google Calendar routes with the contract schemas
// (google-calendar.md G-1, G-5).
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const RESOURCE = "3c1e5a7b-9d2f-4e6a-8b1c-000000000001";
const CONNECTION = "b7d9f1a3-5c7e-4a9b-8d1f-000000000001";

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
  id: CONNECTION, provider: "google", resourceId: RESOURCE, calendarId: "primary", accountEmail: "owner@haldenrowe.example",
  status: "active", lastSyncedAt: "2026-10-20T12:00:00.000Z", lastError: null, createdAt: "2026-10-19T12:00:00.000Z",
};
const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y";

describe("http client: Google Calendar", () => {
  it("lists connections from GET /v1/calendar/connections, and refuses one that is not in contract shape", async () => {
    const { api, calls } = client([json(200, { items: [connection] }), json(200, { items: [{ ...connection, status: "paused" }] })]);
    expect(await api.listCalendarConnections()).toEqual([connection]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/calendar/connections");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.cache).toBe("no-store");
    await expect(api.listCalendarConnections()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("starts a connect with POST, the caller's key and only the resource, and answers the consent URL", async () => {
    const { api, calls } = client([json(200, { authorizeUrl })]);
    expect(await api.startGoogleConnect(RESOURCE, key(1))).toEqual({ authorizeUrl });
    expect(calls[0]!.url.pathname).toBe("/api/v1/calendar/google/connect");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBe(key(1).idempotencyKey);
    expect(body(calls[0])).toEqual({ resourceId: RESOURCE });
  });

  it("passes on no Google settings (404), a staff member (403) and a reused key (409)", async () => {
    const { api } = client([apiError(404, "NotFound"), apiError(403, "Forbidden"), apiError(409, "Conflict", { reason: "idempotency_key_reused" })]);
    await expect(api.startGoogleConnect(RESOURCE, key(2))).rejects.toMatchObject({ kind: "not_found", status: 404 });
    await expect(api.startGoogleConnect(RESOURCE, key(3))).rejects.toMatchObject({ kind: "forbidden", status: 403 });
    await expect(api.startGoogleConnect(RESOURCE, key(4))).rejects.toMatchObject({ kind: "conflict", reason: "idempotency_key_reused" });
  });

  it("refuses a consent URL that is not http(s)", async () => {
    const { api } = client([json(200, { authorizeUrl: "javascript:alert(1)" })]);
    await expect(api.startGoogleConnect(RESOURCE, key(5))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("disconnects with POST /connections/:id/disconnect and an empty body, answering the connection", async () => {
    const disconnecting = { ...connection, status: "disconnecting" };
    const { api, calls } = client([json(200, { actionId: ACTION, result: disconnecting })]);
    expect(await api.disconnectCalendar(CONNECTION, key(6))).toEqual(disconnecting);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/calendar/connections/${CONNECTION}/disconnect`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBe(key(6).idempotencyKey);
    expect(body(calls[0])).toEqual({});
  });

  it("refuses a write without a caller-owned key and sends nothing", async () => {
    const { api, calls } = client([]);
    await expect(api.startGoogleConnect(RESOURCE, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(api.disconnectCalendar(CONNECTION, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});
