// The HTTP client reads and saves the business profile with the contract schemas (business-profile.md
// BP-5, BP-6, BP-10): an older API's 404 is a not_found error, a newer API's extra keys are dropped.
import { describe, expect, it } from "vitest";
import { isStaleRevision } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";

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
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const profile = {
  displayName: "Halden & Rowe", legalName: "Halden & Rowe Ltd", phoneE164: null, timeZone: "Europe/London", currency: "EUR",
  postalAddress: { line1: "12 Mill Lane", city: "Leeds", country: "GB" }, revision: 2, updatedAt: "2026-10-23T10:00:00.000Z",
};

describe("http client: business profile", () => {
  it("reads GET /v1/business and drops keys it does not know", async () => {
    const { api, calls } = client([json(200, { ...profile, taxId: "never shown" })]);
    const read = await api.getBusiness();
    expect(read).toEqual(profile);
    expect(calls[0]!.url.pathname).toBe("/api/v1/business");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("reports an API without the route as not_found", async () => {
    const { api } = client([json(404, { error: { code: "NotFound", message: "Not found", details: {} } })]);
    await expect(api.getBusiness()).rejects.toMatchObject({ kind: "not_found" });
  });

  it("saves with PUT, the idempotency key and the expected revision, and returns the profile", async () => {
    const { api, calls } = client([json(200, { actionId: ACTION, result: profile })]);
    const saved = await api.updateBusiness({ expectedRevision: 1, changes: { currency: "EUR" } }, { idempotencyKey: "key-1" });
    expect(saved).toEqual(profile);
    expect(calls[0]!.url.pathname).toBe("/api/v1/business");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(headers(calls[0])["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ expectedRevision: 1, changes: { currency: "EUR" } });
  });

  it("raises a stale save as a conflict with the stale_revision reason", async () => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "x", details: { reason: "stale_revision", currentRevision: 3 } } })]);
    const error = await api.updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, { idempotencyKey: "key-2" }).catch((caught: unknown) => caught);
    expect(isStaleRevision(error)).toBe(true);
  });
});
