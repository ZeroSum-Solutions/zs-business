// M5 Twilio SMS adapter (docs/requirements/twilio.md T-1..T-5, T-9) against an in-process fake
// Twilio server. No database, no network beyond 127.0.0.1. All numbers are 555-01xx fakes and
// every credential is random hex made here.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliveryProvider, ProviderSendRequest } from "../../src/delivery/provider.js";
import {
  classifyTwilioResponse,
  createTwilioProvider,
  parseTwilioEnv,
  TWILIO_BODY_MAX,
  TWILIO_DEFAULT_BASE_URL,
  TWILIO_DEFAULT_OUTCOME_WAIT_MS,
  TWILIO_MAX_OUTCOME_WAIT_MS,
  twilioConfigSchema,
  type TwilioConfig,
} from "../../src/delivery/twilio.js";
import { fakeMessageSid, startFakeTwilio, type FakeTwilio } from "./fake-twilio.js";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const accountSid = () => `AC${hex(16)}`;
const ACCOUNT_SID = accountSid();
const AUTH_TOKEN = hex(16);
const API_KEY_SID = `SK${hex(16)}`;
const API_KEY_SECRET = randomBytes(24).toString("base64url");
const WEBHOOK = "https://api.haldenrowe.example";
const SENDER = "+15555550100";
const GUEST = "+15555550123";
let server: FakeTwilio;

beforeAll(async () => {
  server = await startFakeTwilio({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, apiKey: { sid: API_KEY_SID, secret: API_KEY_SECRET } });
});
afterAll(async () => { await server?.close(); });

const request = (over: Partial<ProviderSendRequest> = {}): ProviderSendRequest => {
  const deliveryId = over.deliveryId ?? randomUUID();
  return {
    idempotencyKey: `zsd-${deliveryId}`,
    channel: "sms",
    to: GUEST,
    subject: null,
    text: "Halden & Rowe: your table is booked for 7pm. Reply STOP to opt out.",
    headers: {},
    tenantId: randomUUID(),
    deliveryId,
    ...over,
  };
};

const open = () => ({ signal: new AbortController().signal });
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Deps = Partial<Omit<Parameters<typeof createTwilioProvider>[0], "config">>;

const provider = (over: Partial<TwilioConfig> = {}, deps: Deps = {}): DeliveryProvider =>
  createTwilioProvider({
    config: { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, webhookBaseUrl: WEBHOOK, baseUrl: server.url, ...over } as TwilioConfig,
    senderFor: async () => SENDER,
    findStatus: async () => null,
    ...deps,
  });

/** The requests and deliveries a block of work added on the shared server. */
async function observe<T>(work: () => Promise<T>) {
  const received = server.received.length;
  const delivered = server.delivered.length;
  const result = await work();
  return { result, received: server.received.slice(received), delivered: server.delivered.slice(delivered) };
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("the request (T-1, T-3)", () => {
  it("posts one form to the account's Messages.json with Basic auth, the sender and the status callback", async () => {
    const inits: RequestInit[] = [];
    const lookups: { tenantId: string; signal: AbortSignal }[] = [];
    const twilio = provider({ webhookBaseUrl: `${WEBHOOK}//`, baseUrl: `${server.url}/` }, {
      senderFor: async (tenantId, { signal }) => { lookups.push({ tenantId, signal }); return SENDER; },
      fetch: (input, init) => { inits.push(init); return fetch(input, init); },
    });
    const sent = request();
    const options = open();
    const { result, received, delivered } = await observe(() => twilio.send(sent, options));
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.method).toBe("POST");
    expect(got.path).toBe(`/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(got.headers.authorization).toBe(basic(ACCOUNT_SID, AUTH_TOKEN));
    expect(got.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(got.headers.accept).toBe("application/json");
    expect(got.headers["user-agent"]).toBe("zs-business-delivery");
    // Twilio documents no idempotency key; the adapter sends none.
    expect(Object.keys(got.headers).filter((name) => /idempot/i.test(name))).toEqual([]);
    expect(got.fields).toEqual([
      ["To", GUEST],
      ["From", SENDER],
      ["Body", sent.text],
      ["StatusCallback", `${WEBHOOK}/webhooks/twilio/status/${sent.tenantId}/${sent.deliveryId}`],
    ]);
    expect(lookups).toEqual([{ tenantId: sent.tenantId, signal: options.signal }]);
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(inits[0]!.signal).toBe(options.signal);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ to: GUEST, from: SENDER, body: sent.text });
    expect(result).toEqual({ status: "accepted", providerMessageId: delivered[0]!.sid });
  });

  it("signs in with an API key SID and secret when configured", async () => {
    const twilio = createTwilioProvider({
      config: { accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET, webhookBaseUrl: WEBHOOK, baseUrl: server.url },
      senderFor: async () => SENDER,
      findStatus: async () => null,
    });
    const { result, received } = await observe(() => twilio.send(request(), open()));
    expect(received[0]!.headers.authorization).toBe(basic(API_KEY_SID, API_KEY_SECRET));
    expect(received[0]!.path).toBe(`/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`);
    expect(result.status).toBe("accepted");
  });

  it("sends the same bytes on a repeat, and Twilio makes two messages of it (no dedupe)", async () => {
    const twilio = provider();
    const sent = request();
    const { result, received, delivered } = await observe(async () => [await twilio.send(sent, open()), await twilio.send(sent, open())]);
    expect(received).toHaveLength(2);
    expect(received[1]!.raw).toBe(received[0]!.raw);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]!.sid).not.toBe(delivered[1]!.sid);
    expect(result).toEqual(delivered.map((item) => ({ status: "accepted", providerMessageId: item.sid })));
  });

  it("encodes form-special and non-ASCII text intact, up to exactly 1600 characters", async () => {
    const tricky = "Halden & Rowe: 50% off = great + café 🍷\nReply STOP to opt out.";
    const long = "x".repeat(TWILIO_BODY_MAX);
    const { result, delivered } = await observe(async () => [
      await provider().send(request({ text: tricky }), open()),
      await provider().send(request({ text: long }), open()),
    ]);
    expect(result.map((item) => item.status)).toEqual(["accepted", "accepted"]);
    expect(delivered.map((item) => item.body)).toEqual([tricky, long]);
  });

  it("exposes its name, no dedupe window and the outcome wait", () => {
    const twilio = provider();
    expect(twilio.name).toBe("twilio");
    expect(twilio.dedupeWindowMs).toBe(0);
    expect(twilio.outcomeWaitMs).toBe(TWILIO_DEFAULT_OUTCOME_WAIT_MS);
    expect(TWILIO_DEFAULT_OUTCOME_WAIT_MS).toBe(24 * 60 * 60 * 1000);
    expect(typeof twilio.lookup).toBe("function");
    expect(provider({ name: "twilio-us", outcomeWaitMs: 60_000 })).toMatchObject({ name: "twilio-us", dedupeWindowMs: 0, outcomeWaitMs: 60_000 });
  });
});

describe("classification of HTTP answers (T-4)", () => {
  const sid = fakeMessageSid();
  const mms = `MM${hex(16)}`;
  const failure = (status: number, code: number) => ({ code, message: "x", more_info: "https://errors.example.test/x", status });
  const cases: [number, unknown, unknown][] = [
    [201, { sid, status: "queued" }, { status: "accepted", providerMessageId: sid }],
    [200, { sid: mms }, { status: "accepted", providerMessageId: mms }],
    [201, {}, { status: "uncertain", code: "twilio_unreadable_success" }],
    [201, { sid: sid.toUpperCase().replace(/^SM/, "SM") }, { status: "uncertain", code: "twilio_unreadable_success" }],
    [201, { sid: `SM${hex(15)}` }, { status: "uncertain", code: "twilio_unreadable_success" }],
    [201, { sid: `AC${hex(16)}` }, { status: "uncertain", code: "twilio_unreadable_success" }],
    [201, { sid: 42 }, { status: "uncertain", code: "twilio_unreadable_success" }],
    [400, failure(400, 21211), { status: "rejected", code: "twilio_400_21211" }],
    [400, failure(400, 21610), { status: "rejected", code: "twilio_400_21610" }],
    [400, failure(400, 21614), { status: "rejected", code: "twilio_400_21614" }],
    [413, failure(413, 21617), { status: "rejected", code: "twilio_413_21617" }],
    [422, failure(422, 21606), { status: "rejected", code: "twilio_422_21606" }],
    [401, failure(401, 20003), { status: "failed", code: "twilio_401_20003" }],
    [403, failure(403, 20003), { status: "failed", code: "twilio_403_20003" }],
    [404, failure(404, 20404), { status: "failed", code: "twilio_404_20404" }],
    [405, failure(405, 20004), { status: "failed", code: "twilio_405_20004" }],
    [429, failure(429, 20429), { status: "failed", code: "twilio_429_20429" }],
    [408, failure(408, 20001), { status: "uncertain", code: "twilio_408_20001" }],
    [409, failure(409, 20409), { status: "uncertain", code: "twilio_409_20409" }],
    [500, failure(500, 20500), { status: "uncertain", code: "twilio_500_20500" }],
    [502, "<html>Bad gateway</html>", { status: "uncertain", code: "twilio_502" }],
    [503, failure(503, 20503), { status: "uncertain", code: "twilio_503_20503" }],
  ];

  it.each(cases)("%i %j over HTTP", async (status, body, expected) => {
    server.queue(typeof body === "string" ? { respond: status, raw: body } : { respond: status, body });
    const { result, received, delivered } = await observe(() => provider().send(request(), open()));
    expect(result).toEqual(expected);
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("does not follow a redirect", async () => {
    server.queue({ respond: 302, headers: { location: `${server.url}/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json` } });
    const { result, received, delivered } = await observe(() => provider().send(request(), open()));
    expect(result).toEqual({ status: "uncertain", code: "twilio_302" });
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("reads Twilio's numeric code from a number or a digit string, and nothing else", () => {
    expect(classifyTwilioResponse(400, { code: "21211" })).toEqual({ status: "rejected", code: "twilio_400_21211" });
    expect(classifyTwilioResponse(400, { code: 1234567890 })).toEqual({ status: "rejected", code: "twilio_400_1234567890" });
    expect(classifyTwilioResponse(400, { code: 12345678901 })).toEqual({ status: "rejected", code: "twilio_400" });
    expect(classifyTwilioResponse(400, { code: "12345678901" })).toEqual({ status: "rejected", code: "twilio_400" });
    expect(classifyTwilioResponse(429, { code: -1 })).toEqual({ status: "failed", code: "twilio_429" });
    expect(classifyTwilioResponse(429, { code: 1.5 })).toEqual({ status: "failed", code: "twilio_429" });
    expect(classifyTwilioResponse(429, { code: "20429; drop" })).toEqual({ status: "failed", code: "twilio_429" });
    expect(classifyTwilioResponse(429, { code: "" })).toEqual({ status: "failed", code: "twilio_429" });
    expect(classifyTwilioResponse(500, null)).toEqual({ status: "uncertain", code: "twilio_500" });
    expect(classifyTwilioResponse(500, [20500])).toEqual({ status: "uncertain", code: "twilio_500" });
    expect(classifyTwilioResponse(100, null)).toEqual({ status: "uncertain", code: "twilio_100" });
    expect(classifyTwilioResponse(304, null)).toEqual({ status: "uncertain", code: "twilio_304" });
    expect(classifyTwilioResponse(204, null)).toEqual({ status: "uncertain", code: "twilio_unreadable_success" });
    expect(classifyTwilioResponse(201, { sid: ` ${fakeMessageSid()}` })).toEqual({ status: "uncertain", code: "twilio_unreadable_success" });
  });
});

describe("refusals the fake gives (T-4)", () => {
  it("a number that opted out at Twilio is a 21610 rejection with no message", async () => {
    const stopped = "+15555550142";
    server.optOut(stopped);
    const { result, received, delivered } = await observe(() => provider().send(request({ to: stopped }), open()));
    expect(result).toEqual({ status: "rejected", code: "twilio_400_21610" });
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("a wrong auth token is a 401 failure", async () => {
    const { result, delivered } = await observe(() => provider({ authToken: hex(16) }).send(request(), open()));
    expect(result).toEqual({ status: "failed", code: "twilio_401_20003" });
    expect(delivered).toHaveLength(0);
  });

  it("a key for another account path is a 404 failure", async () => {
    const twilio = createTwilioProvider({
      config: { accountSid: accountSid(), apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET, webhookBaseUrl: WEBHOOK, baseUrl: server.url },
      senderFor: async () => SENDER,
      findStatus: async () => null,
    });
    const { result, delivered } = await observe(() => twilio.send(request(), open()));
    expect(result).toEqual({ status: "failed", code: "twilio_404_20404" });
    expect(delivered).toHaveLength(0);
  });

  it("a wrong base path is a 404 failure", async () => {
    expect(await provider({ baseUrl: `${server.url}/v9` }).send(request(), open())).toEqual({ status: "failed", code: "twilio_404_20404" });
  });

  it("a rate limit is a failure, a server error is uncertain", async () => {
    server.queue({ respond: 429, body: { code: 20429, message: "Too many requests", status: 429 } }, { respond: 500, body: { code: 20500, status: 500 } });
    expect(await provider().send(request(), open())).toEqual({ status: "failed", code: "twilio_429_20429" });
    expect(await provider().send(request(), open())).toEqual({ status: "uncertain", code: "twilio_500_20500" });
  });
});

describe("network faults (T-4)", () => {
  it("a timeout through the aborted signal is uncertain", async () => {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    server.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), then: { respond: 201, body: { sid: fakeMessageSid() } }, reached });
    const controller = new AbortController();
    const pending = provider().send(request(), { signal: controller.signal });
    await arrived;
    controller.abort();
    expect(await pending).toEqual({ status: "uncertain", code: "twilio_timeout" });
    release();
  });

  it("a slow answer cut off by a deadline is uncertain, and the fake still sends the text", async () => {
    server.queue({ delay: 300 });
    const sent = request();
    const result = await provider().send(sent, { signal: AbortSignal.timeout(30) });
    expect(result).toEqual({ status: "uncertain", code: "twilio_timeout" });
    // Exactly why a timeout is never a failure: Twilio may have created the message.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(server.delivered.filter((item) => item.raw === server.received.at(-1)!.raw)).toHaveLength(1);
  });

  it("a signal already aborted before the call is a failure with no request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, received } = await observe(() => provider().send(request(), { signal: controller.signal }));
    expect(result).toEqual({ status: "failed", code: "twilio_timeout_before_send" });
    expect(received).toHaveLength(0);
  });

  it("a connection refused on a closed port is a definite failure", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await provider({ baseUrl: `http://127.0.0.1:${port}` }).send(request(), open()))
      .toEqual({ status: "failed", code: "twilio_connect_econnrefused" });
  });

  it("maps thrown fetch errors by their errno", async () => {
    const throwing = (error: unknown): Fetch => async () => { throw error; };
    const withCode = (code: string) => Object.assign(new Error("x"), { code });
    const send = (error: unknown) => provider({}, { fetch: throwing(error) }).send(request(), open());
    expect(await send(new TypeError("fetch failed", { cause: withCode("ENOTFOUND") }))).toEqual({ status: "failed", code: "twilio_connect_enotfound" });
    expect(await send(new TypeError("fetch failed", { cause: withCode("EHOSTUNREACH") }))).toEqual({ status: "failed", code: "twilio_connect_ehostunreach" });
    expect(await send(new TypeError("fetch failed", { cause: withCode("ECONNRESET") }))).toEqual({ status: "uncertain", code: "twilio_network_econnreset" });
    expect(await send(new Error("something else"))).toEqual({ status: "uncertain", code: "twilio_network" });
  });

  it("a reply lost after the fake sent the text is uncertain, with exactly one message", async () => {
    server.queue("lose-reply");
    const { result, delivered } = await observe(() => provider().send(request(), open()));
    expect(result.status).toBe("uncertain");
    expect((result as { code: string }).code).toMatch(/^twilio_network/);
    expect(delivered).toHaveLength(1);
  });

  it("a socket destroyed before any processing is uncertain, with no message", async () => {
    server.queue("drop");
    const { result, received, delivered } = await observe(() => provider().send(request(), open()));
    expect(result.status).toBe("uncertain");
    expect(received).toHaveLength(1);
    expect(delivered).toHaveLength(0);
  });

  it("an oversized body is unreadable: a 2xx stays uncertain, an error status stands", async () => {
    const sid = fakeMessageSid();
    server.queue({ huge: 64 * 1024 + 1, sid });
    expect(await provider().send(request(), open())).toEqual({ status: "uncertain", code: "twilio_unreadable_success" });
    server.queue({ huge: 1024 * 1024, status: 400 });
    expect(await provider().send(request(), open())).toEqual({ status: "rejected", code: "twilio_400" });
    // Exactly at the limit still reads.
    server.queue({ huge: 64 * 1024, sid });
    expect(await provider().send(request(), open())).toEqual({ status: "accepted", providerMessageId: sid });
  });
});

describe("refusals before any HTTP call (T-1, T-3)", () => {
  const cases: [string, Partial<ProviderSendRequest>, string][] = [
    ["an email", { channel: "email", to: "guest@haldenrowe.example", subject: "Hi" }, "twilio_channel_not_sms"],
    ["a number without +", { to: "15555550123" }, "twilio_invalid_recipient"],
    ["a local number", { to: "555-0123" }, "twilio_invalid_recipient"],
    ["a number starting +0", { to: "+05555550123" }, "twilio_invalid_recipient"],
    ["a number with spaces", { to: "+1 555 555 0123" }, "twilio_invalid_recipient"],
    ["a number over 15 digits", { to: "+1555555012345678" }, "twilio_invalid_recipient"],
    ["two numbers", { to: "+15555550123,+15555550124" }, "twilio_invalid_recipient"],
    ["a number with a newline", { to: "+15555550123\n" }, "twilio_invalid_recipient"],
    ["an empty body", { text: "" }, "twilio_invalid_body"],
    ["a body over 1600 characters", { text: "x".repeat(TWILIO_BODY_MAX + 1) }, "twilio_invalid_body"],
    ["a body of 800 emoji (1600 code units plus one)", { text: `${"🍷".repeat(800)}x` }, "twilio_invalid_body"],
    ["a body with NUL", { text: "Halden\u0000Rowe" }, "twilio_invalid_body"],
    ["a tenant id that is not a UUID", { tenantId: "tenant-one" }, "twilio_invalid_id"],
    ["an upper-case tenant UUID", { tenantId: randomUUID().toUpperCase() }, "twilio_invalid_id"],
    ["a delivery id with a path", { deliveryId: `${randomUUID()}/../x` }, "twilio_invalid_id"],
  ];

  it.each(cases)("refuses %s without a lookup or a request", async (_label, over, code) => {
    let lookups = 0;
    const twilio = provider({}, { senderFor: async () => { lookups += 1; return SENDER; } });
    const { result, received } = await observe(() => twilio.send(request(over), open()));
    expect(result).toEqual({ status: "rejected", code });
    expect(received).toHaveLength(0);
    expect(lookups).toBe(0);
  });

  const senders: [string, () => Promise<string | null>, unknown][] = [
    ["a tenant without a number", async () => null, { status: "rejected", code: "twilio_no_sender" }],
    ["a sender that is not E.164", async () => "5555550100", { status: "rejected", code: "twilio_invalid_sender" }],
    ["a sender with NUL", async () => "+1555\u00005550100", { status: "rejected", code: "twilio_invalid_sender" }],
    ["a sender that is not a string", async () => 15555550100 as unknown as string, { status: "rejected", code: "twilio_invalid_sender" }],
    ["a lookup that throws", async () => { throw new Error("database down"); }, { status: "failed", code: "twilio_sender_lookup" }],
  ];

  it.each(senders)("answers %s without a request", async (_label, senderFor, expected) => {
    const { result, received } = await observe(() => provider({}, { senderFor }).send(request(), open()));
    expect(result).toEqual(expected);
    expect(received).toHaveLength(0);
  });
});

describe("lookup from status evidence (T-5)", () => {
  const ids = () => ({ tenantId: randomUUID(), deliveryId: randomUUID() });

  it("a recorded status proves the message: accepted with its SID", async () => {
    const sid = fakeMessageSid();
    const calls: unknown[] = [];
    const twilio = provider({}, { findStatus: async (input, options) => { calls.push({ input, options }); return { messageSid: sid }; } });
    const { tenantId, deliveryId } = ids();
    const signal = new AbortController().signal;
    expect(await twilio.lookup!(`zsd-${deliveryId}`, { signal, tenantId, deliveryId })).toEqual({ status: "accepted", providerMessageId: sid });
    expect(calls).toEqual([{ input: { tenantId, deliveryId }, options: { signal } }]);
    const mms = `MM${hex(16)}`;
    expect(await provider({}, { findStatus: async () => ({ messageSid: mms }) }).lookup!(`zsd-${deliveryId}`, { signal, tenantId, deliveryId }))
      .toEqual({ status: "accepted", providerMessageId: mms });
  });

  it("no evidence, a failing lookup or unreadable evidence is unknown, never not_found", async () => {
    const { tenantId, deliveryId } = ids();
    const ask = (findStatus: Deps["findStatus"]) =>
      provider({}, { ...(findStatus === undefined ? {} : { findStatus }) }).lookup!(`zsd-${deliveryId}`, { ...open(), tenantId, deliveryId });
    expect(await ask(async () => null)).toEqual({ status: "unknown", code: "twilio_no_status_evidence" });
    expect(await ask(async () => { throw new Error("database down"); })).toEqual({ status: "unknown", code: "twilio_status_lookup" });
    expect(await ask(async () => ({ messageSid: "SMnot-a-sid" }))).toEqual({ status: "unknown", code: "twilio_unreadable_status" });
    expect(await ask(async () => ({ messageSid: 7 as unknown as string }))).toEqual({ status: "unknown", code: "twilio_unreadable_status" });
  });

  it("a key that is not this delivery's, or ids that are not UUIDs, are unknown without a lookup", async () => {
    let calls = 0;
    const twilio = provider({}, { findStatus: async () => { calls += 1; return { messageSid: fakeMessageSid() }; } });
    const { tenantId, deliveryId } = ids();
    expect(await twilio.lookup!(`zsd-${randomUUID()}`, { ...open(), tenantId, deliveryId })).toEqual({ status: "unknown", code: "twilio_key_mismatch" });
    expect(await twilio.lookup!(deliveryId, { ...open(), tenantId, deliveryId })).toEqual({ status: "unknown", code: "twilio_key_mismatch" });
    expect(await twilio.lookup!("zsd-x", { ...open(), tenantId, deliveryId: "x" })).toEqual({ status: "unknown", code: "twilio_invalid_id" });
    expect(await twilio.lookup!(`zsd-${deliveryId}`, { ...open(), tenantId: "t", deliveryId })).toEqual({ status: "unknown", code: "twilio_invalid_id" });
    expect(calls).toBe(0);
  });
});

describe("config (T-1, T-9)", () => {
  const withToken = { accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, webhookBaseUrl: WEBHOOK };
  const withKey = { accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET, webhookBaseUrl: WEBHOOK };
  const problem = (config: unknown): string => {
    try {
      createTwilioProvider({ config: config as TwilioConfig, senderFor: async () => SENDER, findStatus: async () => null });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the config to be refused");
  };

  it("defaults to Twilio's https API, the name twilio and a 24-hour wait", () => {
    const defaults = { baseUrl: TWILIO_DEFAULT_BASE_URL, name: "twilio", outcomeWaitMs: TWILIO_DEFAULT_OUTCOME_WAIT_MS };
    expect(twilioConfigSchema.parse(withToken)).toEqual({ ...withToken, ...defaults });
    expect(twilioConfigSchema.parse(withKey)).toEqual({ ...withKey, ...defaults });
    expect(TWILIO_DEFAULT_BASE_URL).toBe("https://api.twilio.com");
    expect(twilioConfigSchema.parse({ ...withToken, authToken: AUTH_TOKEN.toUpperCase() }).authToken).toBe(AUTH_TOKEN.toUpperCase());
  });

  it("takes exactly one credential form", () => {
    expect(problem({ ...withToken, apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET })).toMatch(/authToken: give authToken or an API key, not both/);
    expect(problem({ ...withToken, apiKeySid: API_KEY_SID })).toMatch(/not both/);
    expect(problem({ accountSid: ACCOUNT_SID, webhookBaseUrl: WEBHOOK })).toMatch(/give authToken or apiKeySid with apiKeySecret/);
    expect(problem({ ...withKey, apiKeySecret: undefined })).toMatch(/apiKeySecret is required with apiKeySid/);
    expect(problem({ ...withKey, apiKeySid: undefined })).toMatch(/apiKeySid is required with apiKeySecret/);
  });

  it("checks the shape of every SID and secret", () => {
    expect(problem({ ...withToken, accountSid: `AC${hex(15)}` })).toMatch(/accountSid/);
    expect(problem({ ...withToken, accountSid: `SK${hex(16)}` })).toMatch(/accountSid/);
    expect(problem({ ...withToken, accountSid: ACCOUNT_SID.toUpperCase() })).toMatch(/accountSid/);
    expect(problem({ ...withToken, authToken: hex(15) })).toMatch(/authToken/);
    expect(problem({ ...withToken, authToken: `${hex(15)}zz` })).toMatch(/authToken/);
    expect(problem({ ...withKey, apiKeySid: `AC${hex(16)}` })).toMatch(/apiKeySid/);
    expect(problem({ ...withKey, apiKeySecret: "short" })).toMatch(/apiKeySecret/);
    expect(problem({ ...withKey, apiKeySecret: `${hex(16)} x` })).toMatch(/apiKeySecret must be printable ASCII/);
    expect(problem({ ...withKey, apiKeySecret: "x".repeat(201) })).toMatch(/apiKeySecret/);
  });

  it("refuses plain http to anything but loopback, credentials in URLs, and a webhook base with a query", () => {
    expect(problem({ ...withToken, baseUrl: "http://api.twilio.example" })).toMatch(/baseUrl must use https/);
    expect(problem({ ...withToken, baseUrl: "https://user:pass@api.twilio.example" })).toMatch(/credentials/);
    expect(problem({ ...withToken, baseUrl: "not a url" })).toMatch(/baseUrl must be a URL/);
    expect(problem({ ...withToken, webhookBaseUrl: "http://api.haldenrowe.example" })).toMatch(/webhookBaseUrl must use https/);
    expect(problem({ ...withToken, webhookBaseUrl: `${WEBHOOK}/?x=1` })).toMatch(/webhookBaseUrl must not carry a query/);
    expect(problem({ ...withToken, webhookBaseUrl: `${WEBHOOK}/#frag` })).toMatch(/webhookBaseUrl must not carry a query/);
    expect(problem({ ...withToken, webhookBaseUrl: undefined })).toMatch(/webhookBaseUrl/);
    for (const baseUrl of ["http://127.0.0.1:9", "http://localhost:9", "https://api.twilio.example"])
      expect(() => twilioConfigSchema.parse({ ...withToken, baseUrl })).not.toThrow();
    expect(() => twilioConfigSchema.parse({ ...withToken, webhookBaseUrl: "http://127.0.0.1:8787/api" })).not.toThrow();
  });

  it("bounds the outcome wait to 72 hours and refuses unknown keys", () => {
    expect(TWILIO_MAX_OUTCOME_WAIT_MS).toBe(72 * 60 * 60 * 1000);
    expect(problem({ ...withToken, outcomeWaitMs: TWILIO_MAX_OUTCOME_WAIT_MS + 1 })).toMatch(/outcomeWaitMs/);
    expect(problem({ ...withToken, outcomeWaitMs: 0 })).toMatch(/outcomeWaitMs/);
    expect(problem({ ...withToken, outcomeWaitMs: 1.5 })).toMatch(/outcomeWaitMs/);
    expect(twilioConfigSchema.parse({ ...withToken, outcomeWaitMs: TWILIO_MAX_OUTCOME_WAIT_MS }).outcomeWaitMs).toBe(TWILIO_MAX_OUTCOME_WAIT_MS);
    expect(problem({ ...withToken, extra: true })).toMatch(/extra/);
  });

  it("never puts a credential in an error message", () => {
    const token = hex(16);
    const secret = randomBytes(24).toString("base64url");
    for (const config of [
      { ...withToken, authToken: token, webhookBaseUrl: "ftp://x.example" },
      { ...withToken, authToken: `${token}0` },
      { ...withToken, authToken: token, apiKeySid: API_KEY_SID, apiKeySecret: secret },
      { ...withKey, apiKeySecret: `${secret} ` },
      { ...withKey, apiKeySecret: secret, accountSid: "AC123" },
    ]) {
      const message = problem(config);
      expect(message).toMatch(/^Invalid Twilio config: /);
      expect(message).not.toContain(token);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(API_KEY_SECRET);
    }
  });
});

describe("parseTwilioEnv (T-9)", () => {
  const base = { TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_WEBHOOK_BASE_URL: WEBHOOK };
  const message = (env: Record<string, string | undefined>): string => {
    try {
      parseTwilioEnv(env);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected the environment to be refused");
  };

  it("names each missing required variable", () => {
    expect(message({})).toBe("Invalid environment: TWILIO_ACCOUNT_SID, TWILIO_WEBHOOK_BASE_URL");
    expect(message({ TWILIO_ACCOUNT_SID: ACCOUNT_SID, TWILIO_AUTH_TOKEN: AUTH_TOKEN })).toBe("Invalid environment: TWILIO_WEBHOOK_BASE_URL");
    expect(message(base)).toBe("Invalid environment: TWILIO_AUTH_TOKEN, or TWILIO_API_KEY_SID with TWILIO_API_KEY_SECRET");
    expect(message({ ...base, TWILIO_API_KEY_SID: API_KEY_SID })).toBe("Invalid environment: TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together");
    expect(message({ ...base, TWILIO_AUTH_TOKEN: AUTH_TOKEN, TWILIO_API_KEY_SECRET: API_KEY_SECRET }))
      .toBe("Invalid environment: TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together");
  });

  it("builds the config from a token or a key, preferring the key, with the optional variables", () => {
    expect(parseTwilioEnv({ ...base, TWILIO_AUTH_TOKEN: AUTH_TOKEN, UNRELATED: "x" }))
      .toEqual({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, webhookBaseUrl: WEBHOOK });
    const key = { TWILIO_API_KEY_SID: API_KEY_SID, TWILIO_API_KEY_SECRET: API_KEY_SECRET };
    const fromKey = { accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: API_KEY_SECRET, webhookBaseUrl: WEBHOOK };
    expect(parseTwilioEnv({ ...base, ...key })).toEqual(fromKey);
    expect(parseTwilioEnv({ ...base, ...key, TWILIO_AUTH_TOKEN: AUTH_TOKEN })).toEqual(fromKey);
    expect(parseTwilioEnv({ ...base, ...key, TWILIO_BASE_URL: "http://127.0.0.1:4010", TWILIO_OUTCOME_WAIT_MS: "3600000" }))
      .toEqual({ ...fromKey, baseUrl: "http://127.0.0.1:4010", outcomeWaitMs: 3_600_000 });
    // The result is a config the adapter takes as it is.
    expect(createTwilioProvider({ config: parseTwilioEnv({ ...base, ...key }), senderFor: async () => SENDER, findStatus: async () => null }).name).toBe("twilio");
  });

  it("refuses bad values by variable name without repeating them", () => {
    const token = `${hex(15)}zz`;
    const host = `sms-${hex(6)}.example`;
    const text = message({ ...base, TWILIO_AUTH_TOKEN: token, TWILIO_BASE_URL: `http://${host}`, TWILIO_WEBHOOK_BASE_URL: `http://${host}` });
    expect(text).toMatch(/^Invalid environment: /);
    expect(text).toMatch(/TWILIO_AUTH_TOKEN/);
    expect(text).toMatch(/TWILIO_BASE_URL/);
    expect(text).toMatch(/TWILIO_WEBHOOK_BASE_URL/);
    expect(text).not.toContain(token);
    expect(text).not.toContain(host);
    const secret = `${randomBytes(12).toString("base64url")} space`;
    const keyText = message({ ...base, TWILIO_API_KEY_SID: `SK${hex(15)}`, TWILIO_API_KEY_SECRET: secret, TWILIO_ACCOUNT_SID: "AC-nope" });
    expect(keyText).toMatch(/TWILIO_API_KEY_SID/);
    expect(keyText).toMatch(/TWILIO_API_KEY_SECRET/);
    expect(keyText).toMatch(/TWILIO_ACCOUNT_SID/);
    expect(keyText).not.toContain(secret);
    expect(keyText).not.toContain("AC-nope");
  });

  it("checks the outcome wait as a whole number of milliseconds up to 72 hours", () => {
    const withToken = { ...base, TWILIO_AUTH_TOKEN: AUTH_TOKEN };
    expect(message({ ...withToken, TWILIO_OUTCOME_WAIT_MS: "soon" })).toBe("Invalid environment: TWILIO_OUTCOME_WAIT_MS");
    expect(message({ ...withToken, TWILIO_OUTCOME_WAIT_MS: "1.5" })).toBe("Invalid environment: TWILIO_OUTCOME_WAIT_MS");
    expect(message({ ...withToken, TWILIO_OUTCOME_WAIT_MS: String(TWILIO_MAX_OUTCOME_WAIT_MS + 1) })).toMatch(/^Invalid environment: TWILIO_OUTCOME_WAIT_MS: /);
    expect(message({ ...withToken, TWILIO_OUTCOME_WAIT_MS: "0" })).toMatch(/^Invalid environment: TWILIO_OUTCOME_WAIT_MS: /);
  });
});
