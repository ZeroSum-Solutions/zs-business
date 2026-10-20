// M5 Resend adapter and webhook verification (docs/requirements/resend.md R-1..R-8) against an
// in-process fake Resend server. No database, no network beyond 127.0.0.1.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyResendResponse,
  createResendProvider,
  parseResendEnv,
  RESEND_DEDUPE_WINDOW_MS,
  RESEND_WEBHOOK_TOLERANCE_MS,
  resendConfigSchema,
  resendEmailEventSchema,
  resendSuppressionReason,
  resendWebhookSecretSchema,
  signResendWebhook,
  verifyResendWebhook,
  type DeliveryProvider,
  type ProviderSendRequest,
  type ResendConfig,
} from "../../src/index.js";
import { startFakeResend, type FakeResend } from "./fake-resend.js";
import { manualClock } from "./helpers.js";

const apiKey = () => `re_test_${randomBytes(16).toString("hex")}`;
const API_KEY = apiKey();
const FROM = "Halden & Rowe <bookings@haldenrowe.example>";
const UNSUBSCRIBE = "<https://api.example.test/public/v1/unsubscribe/zsu1_token>";
const clock = manualClock();
let server: FakeResend;

beforeAll(async () => { server = await startFakeResend({ apiKey: API_KEY, clock }); });
afterAll(async () => { await server?.close(); });

const request = (over: Partial<ProviderSendRequest> = {}): ProviderSendRequest => ({
  idempotencyKey: `zsd-${randomUUID()}`,
  channel: "email",
  to: "guest@haldenrowe.example",
  subject: "Your booking",
  text: "Thanks for booking with Halden & Rowe.",
  headers: { "List-Unsubscribe": UNSUBSCRIBE, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  tenantId: randomUUID(),
  deliveryId: randomUUID(),
  ...over,
});

const open = () => ({ signal: new AbortController().signal });
const provider = (over: Partial<ResendConfig> = {}, fetchImpl?: (input: string, init: RequestInit) => Promise<Response>): DeliveryProvider =>
  createResendProvider({
    config: { apiKey: API_KEY, from: FROM, baseUrl: server.url, ...over },
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });

/** The requests and deliveries a block of work added on the shared server. */
async function observe<T>(work: () => Promise<T>) {
  const received = server.received.length;
  const delivered = server.delivered.length;
  const result = await work();
  return { result, received: server.received.slice(received), delivered: server.delivered.slice(delivered) };
}

describe("the request (R-2, R-4, R-5)", () => {
  it("posts exactly one JSON email to /emails with the key, the auth, the unsubscribe headers and the tags", async () => {
    const inits: RequestInit[] = [];
    const resend = provider({ replyTo: "front-desk@haldenrowe.example", baseUrl: `${server.url}/` }, (input, init) => {
      inits.push(init);
      return fetch(input, init);
    });
    const sent = request();
    const { result, received, delivered } = await observe(() => resend.send(sent, open()));
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.method).toBe("POST");
    expect(got.path).toBe("/emails");
    expect(got.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(got.headers["idempotency-key"]).toBe(sent.idempotencyKey);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["user-agent"]).toBe("zs-business-delivery");
    expect(got.body).toEqual({
      from: FROM,
      to: [sent.to],
      subject: sent.subject,
      text: sent.text,
      headers: { "List-Unsubscribe": UNSUBSCRIBE, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      reply_to: "front-desk@haldenrowe.example",
      tags: [{ name: "zs_tenant", value: sent.tenantId }, { name: "zs_delivery", value: sent.deliveryId }],
    });
    // A fixed field order, so a resend is the same bytes.
    expect(Object.keys(got.body as object)).toEqual(["from", "to", "subject", "text", "headers", "reply_to", "tags"]);
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(delivered).toHaveLength(1);
    expect(result).toEqual({ status: "accepted", providerMessageId: delivered[0]!.id });
  });

  it("leaves out reply_to when none is configured, and sends the same bytes on a resend", async () => {
    const resend = provider();
    const sent = request();
    const { result: first, received, delivered } = await observe(async () => [await resend.send(sent, open()), await resend.send(sent, open())]);
    expect(received).toHaveLength(2);
    expect(received[0]!.body).not.toHaveProperty("reply_to");
    expect(received[1]!.raw).toBe(received[0]!.raw);
    // The fake replays the first answer for the repeat: one email, one ID.
    expect(delivered).toHaveLength(1);
    expect(first).toEqual([
      { status: "accepted", providerMessageId: delivered[0]!.id },
      { status: "accepted", providerMessageId: delivered[0]!.id },
    ]);
  });

  it("exposes its name and Resend's 24-hour window", () => {
    const resend = provider();
    expect(resend.name).toBe("resend");
    expect(resend.dedupeWindowMs).toBe(RESEND_DEDUPE_WINDOW_MS);
    expect(RESEND_DEDUPE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(resend.lookup).toBeUndefined();
    expect(provider({ name: "resend-eu", dedupeWindowMs: 60_000 })).toMatchObject({ name: "resend-eu", dedupeWindowMs: 60_000 });
  });
});

describe("idempotency against the fake (R-2)", () => {
  it("a repeat inside 24 hours is replayed; after the window the key is new again", async () => {
    const resend = provider();
    const sent = request();
    const first = await resend.send(sent, open());
    clock.advance(RESEND_DEDUPE_WINDOW_MS - 1);
    const { result: repeat, delivered: none } = await observe(() => resend.send(sent, open()));
    expect(repeat).toEqual(first);
    expect(none).toHaveLength(0);
    clock.advance(2);
    const { result: late, delivered } = await observe(() => resend.send(sent, open()));
    expect(delivered).toHaveLength(1);
    expect(late).toEqual({ status: "accepted", providerMessageId: delivered[0]!.id });
    expect(late).not.toEqual(first);
  });

  it("the same key with another body is a 409 invalid_idempotent_request, which stays uncertain", async () => {
    const resend = provider();
    const sent = request();
    await resend.send(sent, open());
    const { result, delivered } = await observe(() => resend.send({ ...sent, text: "Different text" }, open()));
    expect(result).toEqual({ status: "uncertain", code: "resend_409_invalid_idempotent_request" });
    expect(delivered).toHaveLength(0);
    // A changed sender changes the body too (R-2).
    expect(await provider({ from: "Other <other@haldenrowe.example>" }).send(sent, open()))
      .toEqual({ status: "uncertain", code: "resend_409_invalid_idempotent_request" });
  });

  it("a repeat while the first is still being processed is a 409 concurrent_idempotent_requests, uncertain", async () => {
    const resend = provider();
    const sent = request();
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    server.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), reached });
    const before = server.delivered.length;
    const first = resend.send(sent, open());
    await arrived;
    expect(await resend.send(sent, open())).toEqual({ status: "uncertain", code: "resend_409_concurrent_idempotent_requests" });
    expect(server.delivered.length).toBe(before);
    release();
    const accepted = await first;
    expect(server.delivered.length).toBe(before + 1);
    expect(accepted).toEqual({ status: "accepted", providerMessageId: server.delivered.at(-1)!.id });
    expect(await resend.send(sent, open())).toEqual(accepted);
  });
});

describe("classification of HTTP answers (R-3)", () => {
  const cases: [number, unknown, unknown][] = [
    [200, { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, { status: "accepted", providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }],
    [201, { id: "created-id" }, { status: "accepted", providerMessageId: "created-id" }],
    [200, {}, { status: "uncertain", code: "resend_unreadable_success" }],
    [200, { id: "" }, { status: "uncertain", code: "resend_unreadable_success" }],
    [200, { id: "has space" }, { status: "uncertain", code: "resend_unreadable_success" }],
    [200, { id: 42 }, { status: "uncertain", code: "resend_unreadable_success" }],
    [400, { statusCode: 400, name: "validation_error", message: "x" }, { status: "rejected", code: "resend_400_validation_error" }],
    [401, { statusCode: 401, name: "missing_api_key", message: "x" }, { status: "failed", code: "resend_401_missing_api_key" }],
    [403, { statusCode: 403, name: "invalid_api_key", message: "x" }, { status: "failed", code: "resend_403_invalid_api_key" }],
    [404, { statusCode: 404, name: "not_found", message: "x" }, { status: "failed", code: "resend_404_not_found" }],
    [408, { statusCode: 408, name: "request_timeout", message: "x" }, { status: "uncertain", code: "resend_408_request_timeout" }],
    [409, { statusCode: 409, name: "invalid_idempotent_request", message: "x" }, { status: "uncertain", code: "resend_409_invalid_idempotent_request" }],
    [409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "x" }, { status: "uncertain", code: "resend_409_concurrent_idempotent_requests" }],
    [413, { statusCode: 413, name: "payload_too_large", message: "x" }, { status: "rejected", code: "resend_413_payload_too_large" }],
    [422, { statusCode: 422, name: "validation_error", message: "x" }, { status: "rejected", code: "resend_422_validation_error" }],
    [429, { statusCode: 429, name: "rate_limit_exceeded", message: "x" }, { status: "failed", code: "resend_429_rate_limit_exceeded" }],
    [429, { statusCode: 429, name: "daily_quota_exceeded", message: "x" }, { status: "failed", code: "resend_429_daily_quota_exceeded" }],
    [500, { statusCode: 500, name: "internal_server_error", message: "x" }, { status: "uncertain", code: "resend_500_internal_server_error" }],
    [502, "<html>Bad gateway</html>", { status: "uncertain", code: "resend_502" }],
    [503, { statusCode: 503, name: "service_unavailable", message: "x" }, { status: "uncertain", code: "resend_503_service_unavailable" }],
  ];

  it.each(cases)("%i %j over HTTP", async (status, body, expected) => {
    server.queue(typeof body === "string" ? { respond: status, raw: body } : { respond: status, body });
    const { result, received, delivered } = await observe(() => provider().send(request(), open()));
    expect(result).toEqual(expected);
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("does not follow a redirect", async () => {
    server.queue({ respond: 302, headers: { location: `${server.url}/emails` } });
    const { result, received } = await observe(() => provider().send(request(), open()));
    expect(result).toEqual({ status: "uncertain", code: "resend_302" });
    expect(received).toHaveLength(1);
  });

  it("a key the fake refuses is a failure: 403 invalid_api_key", async () => {
    const { result, delivered } = await observe(() => provider({ apiKey: apiKey() }).send(request(), open()));
    expect(result).toEqual({ status: "failed", code: "resend_403_invalid_api_key" });
    expect(delivered).toHaveLength(0);
  });

  it("a wrong base path is a 404 failure", async () => {
    expect(await provider({ baseUrl: `${server.url}/v9` }).send(request(), open())).toEqual({ status: "failed", code: "resend_404_not_found" });
  });

  it("cleans the error name into the code", () => {
    expect(classifyResendResponse(429, { name: "Rate-Limit Exceeded!" })).toEqual({ status: "failed", code: "resend_429_ratelimitexceeded" });
    expect(classifyResendResponse(429, { name: "!!!" })).toEqual({ status: "failed", code: "resend_429" });
    expect(classifyResendResponse(422, { name: 7 })).toEqual({ status: "rejected", code: "resend_422" });
    expect(classifyResendResponse(500, null)).toEqual({ status: "uncertain", code: "resend_500" });
    expect(classifyResendResponse(422, { name: "x".repeat(100) })).toEqual({ status: "rejected", code: `resend_422_${"x".repeat(60)}` });
    expect(classifyResendResponse(200, { id: "x".repeat(501) })).toEqual({ status: "uncertain", code: "resend_unreadable_success" });
    expect(classifyResendResponse(100, null)).toEqual({ status: "uncertain", code: "resend_100" });
  });
});

describe("network faults (R-3)", () => {
  it("a timeout through the aborted signal is uncertain", async () => {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    server.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), then: { respond: 200, body: { id: "late" } }, reached });
    const controller = new AbortController();
    const pending = provider().send(request(), { signal: controller.signal });
    await arrived;
    controller.abort();
    expect(await pending).toEqual({ status: "uncertain", code: "resend_timeout" });
    release();
  });

  it("a slow answer cut off by a deadline signal is uncertain", async () => {
    server.queue({ delay: 300 });
    const sent = request();
    const result = await provider().send(sent, { signal: AbortSignal.timeout(30) });
    expect(result).toEqual({ status: "uncertain", code: "resend_timeout" });
    // The fake still takes it after the client gave up: exactly why a timeout is never a failure.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(server.delivered.filter((item) => item.idempotencyKey === sent.idempotencyKey)).toHaveLength(1);
  });

  it("a connection refused on a closed port is a definite failure", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await provider({ baseUrl: `http://127.0.0.1:${port}` }).send(request(), open()))
      .toEqual({ status: "failed", code: "resend_connect_econnrefused" });
  });

  it("a reply lost after the fake accepted is uncertain, and the resend replays the same ID", async () => {
    const resend = provider();
    const sent = request();
    server.queue("lose-reply");
    const { result: lost, delivered } = await observe(() => resend.send(sent, open()));
    expect(lost.status).toBe("uncertain");
    expect((lost as { code: string }).code).toMatch(/^resend_network/);
    expect(delivered).toHaveLength(1);
    const { result: again, delivered: none } = await observe(() => resend.send(sent, open()));
    expect(again).toEqual({ status: "accepted", providerMessageId: delivered[0]!.id });
    expect(none).toHaveLength(0);
  });

  it("a socket destroyed after the request arrived, before any processing, is uncertain", async () => {
    server.queue("drop");
    const { result, received, delivered } = await observe(() => provider().send(request(), open()));
    expect(result.status).toBe("uncertain");
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("an oversized body is unreadable: a 2xx stays uncertain, an error status stands", async () => {
    server.queue({ huge: 64 * 1024 + 1, id: "would-be-id" });
    expect(await provider().send(request(), open())).toEqual({ status: "uncertain", code: "resend_unreadable_success" });
    server.queue({ huge: 1024 * 1024, status: 422 });
    expect(await provider().send(request(), open())).toEqual({ status: "rejected", code: "resend_422" });
    // Exactly at the limit still reads.
    server.queue({ huge: 64 * 1024, id: "at-the-limit" });
    expect(await provider().send(request(), open())).toEqual({ status: "accepted", providerMessageId: "at-the-limit" });
  });
});

describe("refusals before any HTTP call (R-1, R-4)", () => {
  const good = request();
  const unsubscribeOnly = { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const cases: [string, Partial<ProviderSendRequest>, string][] = [
    ["an SMS", { channel: "sms", subject: null, headers: {} }, "resend_channel_not_email"],
    ["a null subject", { subject: null }, "resend_invalid_subject"],
    ["an empty subject", { subject: "" }, "resend_invalid_subject"],
    ["a two-line subject", { subject: "Hello\r\nBcc: someone@example.test" }, "resend_invalid_subject"],
    ["no List-Unsubscribe", { headers: unsubscribeOnly }, "resend_unsubscribe_missing"],
    ["an http List-Unsubscribe", { headers: { ...unsubscribeOnly, "List-Unsubscribe": "<http://api.example.test/u/x>" } }, "resend_unsubscribe_missing"],
    ["a mailto-only List-Unsubscribe", { headers: { ...unsubscribeOnly, "List-Unsubscribe": "<mailto:stop@haldenrowe.example>" } }, "resend_unsubscribe_missing"],
    ["no List-Unsubscribe-Post", { headers: { "List-Unsubscribe": UNSUBSCRIBE } }, "resend_unsubscribe_missing"],
    ["a wrong List-Unsubscribe-Post", { headers: { "List-Unsubscribe": UNSUBSCRIBE, "List-Unsubscribe-Post": "List-Unsubscribe=OneClick" } }, "resend_unsubscribe_missing"],
    ["a header value with CR/LF", { headers: { ...good.headers, "X-Note": "a\r\nBcc: someone@example.test" } }, "resend_invalid_header"],
    ["a header value with LF", { headers: { ...good.headers, "X-Note": "a\nb" } }, "resend_invalid_header"],
    ["a reserved Bcc header", { headers: { ...good.headers, Bcc: "someone@example.test" } }, "resend_invalid_header"],
    ["a reserved header in lower case", { headers: { ...good.headers, "reply-to": "someone@example.test" } }, "resend_invalid_header"],
    ["a header name that is not a token", { headers: { ...good.headers, "X Bad": "1" } }, "resend_invalid_header"],
    ["an over-long header value", { headers: { ...good.headers, "X-Long": "x".repeat(2001) } }, "resend_invalid_header"],
    ["an empty idempotency key", { idempotencyKey: "" }, "resend_invalid_idempotency_key"],
    ["an idempotency key with a space", { idempotencyKey: "zsd- 1" }, "resend_invalid_idempotency_key"],
    ["an idempotency key over 256 characters", { idempotencyKey: "k".repeat(257) }, "resend_invalid_idempotency_key"],
    ["two recipients", { to: "guest@haldenrowe.example, other@haldenrowe.example" }, "resend_invalid_recipient"],
    ["a recipient without @", { to: "guest" }, "resend_invalid_recipient"],
    ["a recipient with a display name", { to: "Guest <guest@haldenrowe.example>" }, "resend_invalid_recipient"],
    ["a tenant tag with a dot", { tenantId: "tenant.one" }, "resend_invalid_tag"],
  ];

  it.each(cases)("refuses %s", async (_label, over, code) => {
    const { result, received } = await observe(() => provider().send(request(over), open()));
    expect(result).toEqual({ status: "rejected", code });
    expect(received).toHaveLength(0);
  });

  it("accepts a 256-character key and extra plain headers", async () => {
    const sent = request({ idempotencyKey: "k".repeat(256), headers: { ...good.headers, "X-Entity-Ref-ID": "abc" } });
    const { result, received } = await observe(() => provider().send(sent, open()));
    expect(result.status).toBe("accepted");
    expect((received[0]!.body as { headers: unknown }).headers).toEqual(sent.headers);
  });
});

describe("config (R-1, R-6)", () => {
  const base = { apiKey: API_KEY, from: FROM };
  const problem = (config: unknown): string => {
    try {
      createResendProvider({ config: config as ResendConfig });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the config to be refused");
  };

  it("defaults to Resend's https API and its window", () => {
    expect(resendConfigSchema.parse(base)).toEqual({ ...base, baseUrl: "https://api.resend.com", name: "resend", dedupeWindowMs: RESEND_DEDUPE_WINDOW_MS });
  });

  it("refuses plain http to anything but loopback, and URLs with credentials", () => {
    expect(problem({ ...base, baseUrl: "http://api.resend.example" })).toMatch(/baseUrl must use https/);
    expect(problem({ ...base, baseUrl: "ftp://api.resend.example" })).toMatch(/baseUrl must use https/);
    expect(problem({ ...base, baseUrl: "https://user:pass@api.resend.example" })).toMatch(/credentials/);
    expect(problem({ ...base, baseUrl: "not a url" })).toMatch(/baseUrl must be a URL/);
    expect(() => createResendProvider({ config: { ...base, baseUrl: "http://127.0.0.1:9" } })).not.toThrow();
    expect(() => createResendProvider({ config: { ...base, baseUrl: "http://localhost:9" } })).not.toThrow();
    expect(() => createResendProvider({ config: { ...base, baseUrl: "https://api.resend.example" } })).not.toThrow();
  });

  it("refuses a window longer than Resend's 24 hours", () => {
    expect(problem({ ...base, dedupeWindowMs: RESEND_DEDUPE_WINDOW_MS + 1 })).toMatch(/dedupeWindowMs/);
    expect(problem({ ...base, dedupeWindowMs: 0 })).toMatch(/dedupeWindowMs/);
    expect(createResendProvider({ config: { ...base, dedupeWindowMs: RESEND_DEDUPE_WINDOW_MS } }).dedupeWindowMs).toBe(RESEND_DEDUPE_WINDOW_MS);
  });

  it("refuses a from or reply-to with a line break or without an address, and unknown keys", () => {
    expect(problem({ ...base, from: "Halden <bookings@haldenrowe.example>\nBcc: x@example.test" })).toMatch(/from/);
    expect(problem({ ...base, from: "Halden & Rowe" })).toMatch(/from must name an address/);
    expect(problem({ ...base, replyTo: "a@b.example\r\n" })).toMatch(/replyTo/);
    expect(problem({ ...base, extra: true })).toMatch(/extra/);
  });

  it("never puts the API key in an error message", () => {
    const key = apiKey();
    for (const config of [
      { apiKey: key, from: "no address" },
      { apiKey: `${key} with space`, from: FROM },
      { apiKey: `${key}\n`, from: FROM },
      { apiKey: key, from: FROM, baseUrl: `http://${key}.example` },
      { apiKey: key.slice(0, 5), from: FROM },
    ]) {
      const message = problem(config);
      expect(message).toMatch(/^Invalid Resend config: /);
      expect(message).not.toContain(config.apiKey.trim());
      expect(message).not.toContain(key.slice("re_test_".length, "re_test_".length + 12));
    }
  });
});

describe("parseResendEnv (R-6)", () => {
  it("names each missing required variable", () => {
    expect(() => parseResendEnv({})).toThrow("Invalid environment: RESEND_API_KEY, RESEND_FROM");
    expect(() => parseResendEnv({ RESEND_API_KEY: apiKey() })).toThrow("Invalid environment: RESEND_FROM");
  });

  it("builds the config with and without the optional variables", () => {
    const key = apiKey();
    expect(parseResendEnv({ RESEND_API_KEY: key, RESEND_FROM: FROM, UNRELATED: "x" })).toEqual({ apiKey: key, from: FROM });
    expect(parseResendEnv({
      RESEND_API_KEY: key, RESEND_FROM: FROM, RESEND_REPLY_TO: "desk@haldenrowe.example", RESEND_BASE_URL: "http://127.0.0.1:4010",
    })).toEqual({ apiKey: key, from: FROM, replyTo: "desk@haldenrowe.example", baseUrl: "http://127.0.0.1:4010" });
  });

  it("refuses bad values without repeating them", () => {
    const key = apiKey();
    const secretHost = `mail-${randomBytes(6).toString("hex")}.example`;
    let message = "";
    try {
      parseResendEnv({ RESEND_API_KEY: key, RESEND_FROM: "not-an-address-value", RESEND_BASE_URL: `http://${secretHost}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid environment: /);
    expect(message).toMatch(/RESEND_FROM/);
    expect(message).toMatch(/RESEND_BASE_URL/);
    expect(message).not.toContain(key);
    expect(message).not.toContain("not-an-address-value");
    expect(message).not.toContain(secretHost);
    let short = "";
    try {
      parseResendEnv({ RESEND_API_KEY: "re_x", RESEND_FROM: FROM });
    } catch (error) {
      short = (error as Error).message;
    }
    expect(short).toMatch(/RESEND_API_KEY/);
    expect(short).not.toContain("re_x");
  });
});

describe("webhook verification (R-7)", () => {
  const secret = () => `whsec_${randomBytes(32).toString("base64")}`;
  const current = secret();
  const webhookClock = manualClock();
  const nowSeconds = () => Math.floor(webhookClock.now().getTime() / 1000);
  const event = { type: "email.bounced", data: { email_id: randomUUID(), to: ["guest@haldenrowe.example"], bounce: { type: "Permanent" } } };
  const body = Buffer.from(JSON.stringify(event));
  const msgId = () => `msg_${randomBytes(12).toString("hex")}`;

  const verify = (over: {
    secrets?: { current: string; previous?: string };
    id?: string | undefined;
    timestamp?: string | undefined;
    signature?: string | undefined;
    body?: Uint8Array;
  } = {}) => {
    const id = "id" in over ? over.id : msgId();
    const timestamp = "timestamp" in over ? over.timestamp : String(nowSeconds());
    const signedBody = over.body ?? body;
    const signature = "signature" in over ? over.signature : signResendWebhook(current, id ?? "", Number(timestamp), signedBody);
    return verifyResendWebhook({ secrets: over.secrets ?? { current }, headers: { id, timestamp, signature }, body: signedBody, now: webhookClock.now() });
  };

  it("accepts a valid signature and returns the parsed payload", () => {
    const id = msgId();
    const result = verify({ id });
    expect(result).toEqual({ ok: true, id, payload: event });
  });

  it("accepts the previous secret during a rotation, and only then", () => {
    const old = secret();
    const id = msgId();
    const timestamp = String(nowSeconds());
    const signature = signResendWebhook(old, id, Number(timestamp), body);
    expect(verify({ id, timestamp, signature, secrets: { current, previous: old } })).toMatchObject({ ok: true });
    expect(verify({ id, timestamp, signature, secrets: { current } })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts a header with several entries when one of them matches, and ignores v2 entries", () => {
    const id = msgId();
    const timestamp = String(nowSeconds());
    const valid = signResendWebhook(current, id, Number(timestamp), body);
    const other = signResendWebhook(secret(), id, Number(timestamp), body);
    const garbage = `v1,${randomBytes(32).toString("base64")}`;
    expect(verify({ id, timestamp, signature: `${garbage} ${other} ${valid}` })).toMatchObject({ ok: true });
    expect(verify({ id, timestamp, signature: `${garbage} ${other}` })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ id, timestamp, signature: valid.replace(/^v1,/, "v2,") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ id, timestamp, signature: valid.replace(/^v1,/, "") })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered body, a wrong secret, another id or another timestamp", () => {
    const id = msgId();
    const timestamp = String(nowSeconds());
    const signature = signResendWebhook(current, id, Number(timestamp), body);
    const tampered = Buffer.from(JSON.stringify({ ...event, type: "email.complained" }));
    expect(verifyResendWebhook({ secrets: { current }, headers: { id, timestamp, signature }, body: tampered, now: webhookClock.now() }))
      .toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ id, timestamp, signature: signResendWebhook(secret(), id, Number(timestamp), body) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ id: msgId(), timestamp, signature })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify({ id, timestamp: String(Number(timestamp) - 1), signature })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a timestamp more than 5 minutes off the injected clock as stale", () => {
    const tolerance = RESEND_WEBHOOK_TOLERANCE_MS / 1000;
    expect(RESEND_WEBHOOK_TOLERANCE_MS).toBe(5 * 60 * 1000);
    expect(verify({ timestamp: String(nowSeconds() - tolerance - 1) })).toEqual({ ok: false, reason: "stale" });
    expect(verify({ timestamp: String(nowSeconds() + tolerance + 1) })).toEqual({ ok: false, reason: "stale" });
    expect(verify({ timestamp: String(nowSeconds() - tolerance) })).toMatchObject({ ok: true });
    expect(verify({ timestamp: String(nowSeconds() + tolerance) })).toMatchObject({ ok: true });
    // A stale request with a bad signature is a bad signature first.
    expect(verify({ timestamp: String(nowSeconds() - tolerance - 1), signature: `v1,${randomBytes(32).toString("base64")}` }))
      .toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a non-numeric timestamp and missing or malformed headers", () => {
    expect(verify({ timestamp: "12a" })).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verify({ timestamp: "-5" })).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verify({ timestamp: "1.5" })).toEqual({ ok: false, reason: "bad_timestamp" });
    expect(verify({ id: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ signature: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ id: "" })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ id: "msg.with.dots" })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verify({ signature: `v1,${"a".repeat(5000)}` })).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("a valid signature over a body that is not JSON is bad_json", () => {
    expect(verify({ body: Buffer.from("not json {") })).toEqual({ ok: false, reason: "bad_json" });
  });

  it("the secret schema takes whsec_ plus base64 of 32 random bytes and nothing else", () => {
    expect(resendWebhookSecretSchema.safeParse(secret()).success).toBe(true);
    expect(resendWebhookSecretSchema.safeParse(`whsec_${randomBytes(24).toString("base64")}`).success).toBe(true);
    for (const value of [
      randomBytes(32).toString("base64"),
      `whsec_${randomBytes(16).toString("base64")}`,
      `whsec_${randomBytes(32).toString("hex")}!`,
      "whsec_",
      `whsec_${randomBytes(32).toString("base64")} `,
      `whsec_${randomBytes(160).toString("base64")}`,
      `wh_${randomBytes(32).toString("base64")}`,
      "",
    ]) expect(resendWebhookSecretSchema.safeParse(value).success, value.slice(0, 12)).toBe(false);
  });
});

describe("events feeding suppression (R-8)", () => {
  const parse = (type: string, extra: Record<string, unknown> = {}) =>
    resendEmailEventSchema.parse({ type, data: { email_id: randomUUID(), to: "guest@haldenrowe.example", ...extra } });

  it("maps bounces, complaints and suppressions; ignores the rest", () => {
    expect(resendSuppressionReason(parse("email.bounced", { bounce: { type: "Permanent" } }))).toEqual({ reason: "bounce" });
    expect(resendSuppressionReason(parse("email.bounced", { bounce: { type: "permanent" } }))).toEqual({ reason: "bounce" });
    expect(resendSuppressionReason(parse("email.bounced", { bounce: { type: "Transient" } }))).toEqual({ ignored: "bounce_not_permanent" });
    expect(resendSuppressionReason(parse("email.bounced", { bounce: { type: "Undetermined" } }))).toEqual({ ignored: "bounce_not_permanent" });
    expect(resendSuppressionReason(parse("email.bounced", { bounce: {} }))).toEqual({ reason: "bounce" });
    expect(resendSuppressionReason(parse("email.bounced"))).toEqual({ reason: "bounce" });
    expect(resendSuppressionReason(parse("email.complained"))).toEqual({ reason: "complaint" });
    expect(resendSuppressionReason(parse("email.suppressed"))).toEqual({ reason: "bounce" });
    expect(resendSuppressionReason(parse("email.delivered"))).toEqual({ ignored: "no_suppression" });
    expect(resendSuppressionReason(parse("email.opened"))).toEqual({ ignored: "no_suppression" });
  });

  it("reads tags as an object or as name/value pairs, and one recipient or many", () => {
    const tenant = randomUUID();
    const asObject = parse("email.bounced", { tags: { zs_tenant: tenant } });
    const asPairs = parse("email.bounced", { tags: [{ name: "zs_tenant", value: tenant }] });
    expect(asObject.data.tags).toEqual({ zs_tenant: tenant });
    expect(asPairs.data.tags).toEqual({ zs_tenant: tenant });
    expect(asObject.data.to).toEqual(["guest@haldenrowe.example"]);
    expect(resendEmailEventSchema.safeParse({ type: "email.bounced", data: { to: "x@y.example" } }).success).toBe(false);
  });
});
