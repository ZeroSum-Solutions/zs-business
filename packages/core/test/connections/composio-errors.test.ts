// Connections C-10: the Composio client keeps a bounded non-2xx body on its error and classifies it
// (`provider_refused`, `transient`, `unknown`) from structured fields only. Provider text never reaches a
// message or a log line.
import { describe, expect, it, vi } from "vitest";
import { COMPOSIO_MAX_ERROR_BODY_BYTES, ComposioError, classifyHttpError, createComposioClient } from "../../src/index.js";

const SECRET_WORDS = "PROVIDER-WORDS-do-not-leak";
const envelope = (status: number, extra: Record<string, unknown> = {}) => ({
  error: { message: SECRET_WORDS, status, request_id: "req_abc123def456", suggested_fix: "fix it", ...extra },
});
const answer = (status: number, body: BodyInit | null, headers: Record<string, string> = {}): typeof fetch =>
  async () => new Response(body, { status, headers });
const client = (fetchImpl: typeof fetch, extra: { maxErrorBodyBytes?: number; timeoutMs?: number } = {}) =>
  createComposioClient({ apiKey: "k", baseUrl: "https://composio.test/api/v3.1", fetch: fetchImpl, ...extra });
const link = async (fetchImpl: typeof fetch, extra: { maxErrorBodyBytes?: number; timeoutMs?: number } = {}): Promise<ComposioError> => {
  try {
    await client(fetchImpl, extra).link({ authConfigId: "ac_1", userId: "u", callbackUrl: "https://app.test/cb" });
  } catch (error) {
    if (error instanceof ComposioError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
};
const json = (status: number, body: unknown) => answer(status, JSON.stringify(body));

describe("Composio error classes (C-10)", () => {
  it("classifies a 400, 404 or 422 with Composio's error envelope as provider_refused and keeps the parsed body", async () => {
    for (const status of [400, 404, 422]) {
      const error = await link(json(status, envelope(status)));
      expect(error).toBeInstanceOf(ComposioError);
      expect(error.errorClass).toBe("provider_refused");
      expect(error.status).toBe(status);
      expect(error.requestId).toBe("req_abc123def456");
      expect(error.namedAccountId).toBeUndefined();
      expect((error.body as { error: { status: number } }).error.status).toBe(status);
    }
  });

  it("keeps the existing kinds for current callers", async () => {
    const kinds: Record<number, string> = { 400: "bad_request", 404: "not_found", 401: "key_refused", 429: "rate_limited", 503: "unavailable" };
    for (const [status, kind] of Object.entries(kinds)) {
      const error = await link(json(Number(status), envelope(Number(status))));
      expect(error.kind).toBe(kind);
    }
  });

  it("classifies 429, 402, 408 and every 5xx as transient, with or without a body", async () => {
    for (const status of [429, 402, 408, 500, 502, 503, 504]) {
      expect((await link(json(status, envelope(status)))).errorClass).toBe("transient");
      expect((await link(answer(status, "<html>gateway</html>"))).errorClass).toBe("transient");
    }
  });

  it("classifies a network failure and a timeout as transient", async () => {
    const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    const error = await link(down);
    expect(error).toMatchObject({ kind: "unavailable", detail: "network", errorClass: "transient" });
    const hang: typeof fetch = (_url, init) => new Promise((_, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))); });
    const slow = await link(hang, { timeoutMs: 20 });
    expect(slow).toMatchObject({ detail: "timeout", errorClass: "transient" });
  });

  it("classifies 401, 403, 410 and 409 as unknown even with a well-formed envelope (our key, or a possible side effect)", async () => {
    for (const status of [401, 403, 410, 409, 405, 413]) {
      const error = await link(json(status, envelope(status)));
      expect(error.errorClass).toBe("unknown");
    }
  });

  it("classifies an unparseable, empty or foreign 4xx body as unknown", async () => {
    for (const body of ["<html>bad gateway</html>", "", "not json", "[1,2]", "null", '"text"', "{}", JSON.stringify({ message: SECRET_WORDS })]) {
      const error = await link(answer(400, body));
      expect(error.errorClass, body).toBe("unknown");
    }
  });

  it("classifies an envelope whose status, message or request id does not fit as unknown", async () => {
    const bad = [
      envelope(422, {}), // status below differs from HTTP status 400
      { error: { message: "", status: 400, request_id: "req_1" } },
      { error: { status: 400, request_id: "req_1" } },
      { error: { message: "x", status: 400 } },
      { error: { message: "x", status: "400", request_id: "req_1" } },
      { error: { message: "x", status: 400, request_id: "has space" } },
      { error: { message: "x", status: 400, request_id: "r".repeat(201) } },
      { error: "plain string" },
    ];
    for (const body of bad) expect((await link(json(400, body))).errorClass).toBe("unknown");
  });

  it("is strict: any extra key at any depth, a nested value or an account id anywhere makes the answer unknown", async () => {
    const base = envelope(400);
    const bodies: unknown[] = [
      { ...base, data: { connected_account_id: "ca_x" } },
      { ...base, extra: 1 },
      { error: { ...base.error, details: { connected_account_id: "ca_x" } } },
      { error: { ...base.error, details: [] } },
      { error: { ...base.error, code: 10401 } },
      { error: { ...base.error, suggested_fix: { how: "x" } } },
      { error: { ...base.error, request_id: { id: "ca_deep" } } },
      { error: { ...base.error, message: { text: "x" } } },
      { error: [base.error] },
      [base],
    ];
    for (const body of bodies) expect((await link(json(400, body))).errorClass, JSON.stringify(body)).toBe("unknown");
    // suggested_fix as a string is part of the envelope; absent is fine too.
    expect((await link(json(400, base))).errorClass).toBe("provider_refused");
    const { suggested_fix: _omit, ...without } = base.error;
    expect((await link(json(400, { error: without }))).errorClass).toBe("provider_refused");
  });

  it("keeps an account id found anywhere in the body as namedAccountId, with bounded work", async () => {
    for (const [body, id] of [
      [{ ...envelope(400), data: { connected_account_id: "ca_a" } }, "ca_a"],
      [{ error: { ...envelope(400).error, details: { connectedAccountId: "ca_b" } } }, "ca_b"],
      [{ error: { ...envelope(400).error, details: [{ nested: { id: "ca_c" } }] } }, "ca_c"],
    ] as const) {
      const error = await link(json(400, body));
      expect(error.namedAccountId).toBe(id);
      expect(error.errorClass).toBe("unknown");
      expect(error.accountId).toBeUndefined();
    }
    // A very deep body is cut off by the scan (depth 6), not walked.
    let deep: unknown = { id: "ca_deep" };
    for (let i = 0; i < 50; i++) deep = { n: deep };
    expect(classifyHttpError(400, { error: {}, deep }).namedAccountId).toBeUndefined();
  });

  it("takes request_id only from a validated envelope and only from safe characters", async () => {
    const withId = (request_id: string) => ({ error: { message: "x", status: 400, request_id } });
    for (const bad of ["access_token=abc123", "has space", "a/b", "x".repeat(129), "", "tok\u0000en"]) {
      const error = await link(json(400, withId(bad)));
      expect(error.requestId, bad).toBeUndefined();
      expect(error.errorClass, bad).toBe("unknown");
      expect(JSON.stringify(error)).not.toContain("access_token");
    }
    expect((await link(json(400, withId("req_AB-12.3:x")))).requestId).toBe("req_AB-12.3:x");
    // A foreign body's request_id is never read, even for a transient status.
    const foreign = await link(json(503, { error: { message: "x", status: 503, request_id: "req_1", extra: true } }));
    expect(foreign.errorClass).toBe("transient");
    expect(foreign.requestId).toBeUndefined();
    const mismatch = await link(json(503, { error: { message: "x", status: 400, request_id: "req_1" } }));
    expect(mismatch.requestId).toBeUndefined();
    expect((await link(json(503, envelope(503)))).requestId).toBe("req_abc123def456");
  });

  it("classifies a failure while reading the error body as transient with the timeout or network detail", async () => {
    const broken = (status: number, onPull: () => void): typeof fetch => async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); },
      pull() { return onPull(); },
    }), { status });
    const net = await link(broken(400, () => { throw new TypeError("terminated"); }));
    expect(net).toMatchObject({ kind: "bad_request", status: 400, detail: "network", errorClass: "transient" });
    expect(net.message).not.toContain("terminated");
    // A timeout while the body hangs.
    const hang: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); },
      pull() { return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError")))); },
    }), { status: 422 });
    expect(await link(hang, { timeoutMs: 30 })).toMatchObject({ kind: "bad_request", status: 422, detail: "timeout", errorClass: "transient" });
    // Empty, oversized and invalid bodies stay unknown (no transport failure).
    expect((await link(answer(400, ""))).errorClass).toBe("unknown");
    expect((await link(answer(400, "{"))).errorClass).toBe("unknown");
    expect((await link(answer(400, "x".repeat(COMPOSIO_MAX_ERROR_BODY_BYTES + 1)))).errorClass).toBe("unknown");
  });

  it("stops reading an oversized error body as soon as the total passes the cap", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(1024).fill(120);
    const endless: typeof fetch = async () => new Response(new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(chunk); } }), { status: 400 });
    const error = await link(endless, { maxErrorBodyBytes: 4096 });
    expect(error.errorClass).toBe("unknown");
    expect(pulls).toBeLessThanOrEqual(8);
  });

  it("never calls a 4xx provider_refused when the body names an account, and exposes the id apart from accountId", async () => {
    for (const body of [
      envelope(400, { connected_account_id: "ca_made" }),
      { ...envelope(400), connected_account_id: "ca_made" },
      envelope(400, { id: "ca_made" }),
      { ...envelope(400), id: "ca_made" },
    ]) {
      const error = await link(json(400, body));
      expect(error.errorClass).toBe("unknown");
      expect(error.namedAccountId).toBe("ca_made");
      expect(error.accountId).toBeUndefined();
    }
    // A field that is present but unusable still blocks the refusal class.
    const odd = await link(json(400, envelope(400, { connected_account_id: 7 })));
    expect(odd.errorClass).toBe("unknown");
    expect(odd.namedAccountId).toBeUndefined();
  });

  it("drops a body over the error limit whole, even when it would have been a refusal", async () => {
    const big = { ...envelope(400), padding: "x".repeat(COMPOSIO_MAX_ERROR_BODY_BYTES) };
    const streamed = await link(json(400, big));
    expect(streamed.errorClass).toBe("unknown");
    expect(streamed.body).toBeUndefined();
    const declared = await link(answer(400, JSON.stringify(envelope(400)), { "content-length": String(COMPOSIO_MAX_ERROR_BODY_BYTES + 1) }));
    expect(declared.errorClass).toBe("unknown");
    expect(declared.body).toBeUndefined();
    // The limit is configurable and a body at the limit is kept.
    const raw = JSON.stringify(envelope(400));
    const fits = await link(answer(400, raw), { maxErrorBodyBytes: raw.length });
    expect(fits.errorClass).toBe("provider_refused");
    const over = await link(answer(400, raw), { maxErrorBodyBytes: raw.length - 1 });
    expect(over.errorClass).toBe("unknown");
  });

  it("keeps a 2xx failure (malformed, too large) unknown", async () => {
    const malformed = await link(answer(200, "not json"));
    expect(malformed).toMatchObject({ detail: "malformed", errorClass: "unknown" });
    const huge = await link(answer(200, "{}", { "content-length": String(2 * 1024 * 1024) }));
    expect(huge).toMatchObject({ detail: "too_large", errorClass: "unknown" });
  });

  it("puts no provider text in the message, the serialized error or a log line", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const status of [400, 404, 422, 429, 500]) {
        const error = await link(json(status, envelope(status)));
        expect(error.message).not.toContain(SECRET_WORDS);
        expect(error.message).not.toContain("req_abc");
        expect(JSON.stringify(error)).not.toContain(SECRET_WORDS);
        expect(JSON.stringify({ ...error })).not.toContain(SECRET_WORDS);
        expect(Object.keys(error)).not.toContain("body");
      }
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      log.mockRestore(); warn.mockRestore(); info.mockRestore();
    }
  });

  it("classifyHttpError is pure and reads no text", () => {
    expect(classifyHttpError(400, envelope(400)).errorClass).toBe("provider_refused");
    expect(classifyHttpError(400, undefined).errorClass).toBe("unknown");
    expect(classifyHttpError(500, undefined).errorClass).toBe("transient");
    // The message words never decide the class.
    expect(classifyHttpError(400, { error: { message: "rate limit exceeded, nothing created", status: 400, request_id: "r1" } }).errorClass).toBe("provider_refused");
    expect(classifyHttpError(400, { error: { message: "Account created", status: 401, request_id: "r1" } }).errorClass).toBe("unknown");
  });
});
