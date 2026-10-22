// M5 Stripe client, webhook signature and configuration (docs/requirements/stripe.md S-2, S-3,
// S-9) against an in-process fake Stripe server. No database, no network beyond 127.0.0.1.
// Keys and secrets are made at runtime so nothing here looks like a real credential.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkoutSessionForm,
  createStripeClient,
  mapError,
  parseStripeEnv,
  signStripeWebhook,
  STRIPE_DEFAULT_BASE_URL,
  STRIPE_WEBHOOK_TOLERANCE_MS,
  stripeEventSchema,
  StripeRequestFailed,
  stripeWebhookSecretSchema,
  verifyStripeWebhook,
  type CheckoutSessionRequest,
  type StripeClient,
  type StripeConfig,
} from "../../src/index.js";
import { startFakeStripe, type FakeStripe, type FakeStripeBehaviour } from "./fake-stripe.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const clock = (() => {
  let at = START;
  return { now: () => new Date(at), set(instant: number) { at = instant; } };
})();

const secretKey = (mode: "test" | "live" = "test", kind: "sk" | "rk" = "sk") => [kind, mode, randomBytes(16).toString("hex")].join("_");
const webhookSecret = () => ["whsec", randomBytes(24).toString("base64")].join("_");
const SECRET_KEY = secretKey();
const SUCCESS = "https://app.haldenrowe.example/billing/done?state=ok&from=checkout";
const CANCEL = "https://app.haldenrowe.example/billing/cancelled";

let stripe: FakeStripe;
beforeAll(async () => { stripe = await startFakeStripe({ secretKey: SECRET_KEY, clock }); });
afterAll(async () => { await stripe?.close(); });

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const client = (over: Partial<StripeConfig> = {}, fetchImpl?: Fetch): StripeClient => createStripeClient({
  config: { secretKey: SECRET_KEY, baseUrl: stripe.url, successUrl: SUCCESS, cancelUrl: CANCEL, ...over },
  ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
});

const topUp = (over: Partial<CheckoutSessionRequest> = {}): CheckoutSessionRequest => ({
  tenantId: randomUUID(),
  topupId: randomUUID(),
  amount: 2500,
  currency: "usd",
  successUrl: SUCCESS,
  cancelUrl: CANCEL,
  productName: "Message credit",
  expiresAt: Math.floor(START / 1000) + 3600,
  ...over,
});

const open = () => ({ signal: new AbortController().signal });

/** The requests and sessions a block of work added on the shared fake. */
async function observe<T>(work: () => Promise<T>) {
  const received = stripe.received.length;
  const sessions = stripe.sessions.length;
  const result = await work();
  return { result, received: stripe.received.slice(received), sessions: stripe.sessions.slice(sessions) };
}

/** The StripeRequestFailed a call rejects with (fails the test if it resolves or throws otherwise). */
async function failure(promise: Promise<unknown>): Promise<StripeRequestFailed> {
  const outcome = await promise.then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(StripeRequestFailed);
  return outcome as StripeRequestFailed;
}

describe("the Checkout Session request (S-2)", () => {
  it("posts the exact form, in a fixed order, with the key, the idempotency key and no Stripe-Version", async () => {
    const inits: RequestInit[] = [];
    const stripeClient = client({}, (input, init) => {
      inits.push(init);
      return fetch(input, init);
    });
    const request = topUp();
    const { result, received, sessions } = await observe(() => stripeClient.createCheckoutSession(request, open()));
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.method).toBe("POST");
    expect(got.path).toBe("/v1/checkout/sessions");
    expect(got.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(got.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(got.headers["idempotency-key"]).toBe(`zst-${request.topupId}`);
    expect(got.headers).not.toHaveProperty("stripe-version");
    expect(got.entries).toEqual([
      ["mode", "payment"],
      ["line_items[0][quantity]", "1"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][unit_amount]", "2500"],
      ["line_items[0][price_data][product_data][name]", "Message credit"],
      ["success_url", SUCCESS],
      ["cancel_url", CANCEL],
      ["client_reference_id", request.topupId],
      ["metadata[zs_tenant]", request.tenantId],
      ["metadata[zs_topup]", request.topupId],
      ["payment_intent_data[metadata][zs_tenant]", request.tenantId],
      ["payment_intent_data[metadata][zs_topup]", request.topupId],
      ["expires_at", String(request.expiresAt)],
    ]);
    expect(got.raw).toBe(checkoutSessionForm(request));
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ method: "POST", redirect: "manual" });
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      amount_total: 2500,
      currency: "usd",
      client_reference_id: request.topupId,
      expires_at: request.expiresAt,
      metadata: { zs_tenant: request.tenantId, zs_topup: request.topupId },
      livemode: false,
    });
    expect(result).toEqual({ id: sessions[0]!.id, url: sessions[0]!.url });
  });

  it("form-encodes every reserved character, so the URLs and names arrive unchanged", () => {
    const request = topUp({
      topupId: "t-1", tenantId: "n-1", amount: 700, currency: "eur", expiresAt: 1_800_000_000,
      productName: "Credit & more = 100%", successUrl: "https://a.example/x?y=1&z=[2]",
    });
    expect(checkoutSessionForm(request)).toBe([
      "mode=payment",
      "line_items%5B0%5D%5Bquantity%5D=1",
      "line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=eur",
      "line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=700",
      "line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Credit%20%26%20more%20%3D%20100%25",
      "success_url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D%5B2%5D",
      `cancel_url=${encodeURIComponent(CANCEL)}`,
      "client_reference_id=t-1",
      "metadata%5Bzs_tenant%5D=n-1",
      "metadata%5Bzs_topup%5D=t-1",
      "payment_intent_data%5Bmetadata%5D%5Bzs_tenant%5D=n-1",
      "payment_intent_data%5Bmetadata%5D%5Bzs_topup%5D=t-1",
      "expires_at=1800000000",
    ].join("&"));
  });

  it("sends Stripe-Version only when apiVersion is set, and the request's product name", async () => {
    const stripeClient = client({ apiVersion: "2026-09-30.clover", baseUrl: `${stripe.url}//` });
    const request = topUp({ currency: "usd", amount: 999, productName: "Halden credit" });
    const { received } = await observe(() => stripeClient.createCheckoutSession(request, open()));
    expect(received[0]!.path).toBe("/v1/checkout/sessions");
    expect(received[0]!.headers["stripe-version"]).toBe("2026-09-30.clover");
    expect(received[0]!.form["line_items[0][price_data][product_data][name]"]).toBe("Halden credit");
    expect(received[0]!.form["line_items[0][price_data][unit_amount]"]).toBe("999");
  });

  it("works without a signal", async () => {
    const result = await client().createCheckoutSession(topUp(), {});
    expect(result.id).toMatch(/^cs_test_/);
  });
});

describe("idempotency against the fake (S-2)", () => {
  it("a repeat of the same top-up is the same bytes and Stripe replays the same session", async () => {
    const stripeClient = client();
    const request = topUp();
    const { result, received, sessions } = await observe(async () => [
      await stripeClient.createCheckoutSession(request, open()),
      await stripeClient.createCheckoutSession(request, open()),
    ]);
    expect(received).toHaveLength(2);
    expect(received[1]!.raw).toBe(received[0]!.raw);
    expect(received[1]!.headers["idempotency-key"]).toBe(received[0]!.headers["idempotency-key"]);
    expect(sessions).toHaveLength(1);
    expect(result[1]).toEqual(result[0]);
    expect(result[0]).toEqual({ id: sessions[0]!.id, url: sessions[0]!.url });
  });

  it("a new client with the same config builds the same request, so a restarted server replays too", async () => {
    const request = topUp();
    const { result, sessions } = await observe(async () => [
      await client().createCheckoutSession(request, open()),
      await client().createCheckoutSession(request, open()),
    ]);
    expect(sessions).toHaveLength(1);
    expect(result[1]).toEqual(result[0]);
  });

  it("the same key with other parameters is refused as an idempotency_error, not retried", async () => {
    const stripeClient = client();
    const request = topUp();
    await stripeClient.createCheckoutSession(request, open());
    const { result: error, sessions } = await observe(() => failure(stripeClient.createCheckoutSession({ ...request, amount: request.amount + 1 }, open())));
    expect(sessions).toHaveLength(0);
    expect(error.code).toBe("stripe_400_idempotency_error");
    expect(error.retry).toBe(false);
  });

  it("a second request while the first is in flight gets 409 (retry), and a later retry replays the first", async () => {
    const stripeClient = client();
    const request = topUp();
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    stripe.queue({ hold: new Promise<void>((resolve) => { release = resolve; }), reached: () => arrived() });
    const first = stripeClient.createCheckoutSession(request, open());
    await reached;
    const busy = await failure(stripeClient.createCheckoutSession(request, open()));
    expect(busy.code).toBe("stripe_409_idempotency_key_in_use");
    expect(busy.retry).toBe(true);
    release();
    const created = await first;
    expect(await stripeClient.createCheckoutSession(request, open())).toEqual(created);
  });

  it("a lost answer is a network failure (retry), and the retry gets the session that was made", async () => {
    const stripeClient = client();
    const request = topUp();
    stripe.queue("lose-reply");
    const { result: lost, sessions } = await observe(() => failure(stripeClient.createCheckoutSession(request, open())));
    expect(lost.code).toBe("stripe_network");
    expect(lost.retry).toBe(true);
    expect(sessions).toHaveLength(1);
    const { result: retried, sessions: none } = await observe(() => stripeClient.createCheckoutSession(request, open()));
    expect(none).toHaveLength(0);
    expect(retried).toEqual({ id: sessions[0]!.id, url: sessions[0]!.url });
  });

  it("a refusal for bad parameters is remembered for its key, as Stripe does", async () => {
    const stripeClient = client();
    const request = topUp({ expiresAt: Math.floor(START / 1000) + 60 });
    const first = await failure(stripeClient.createCheckoutSession(request, open()));
    expect(first.code).toBe("stripe_400_invalid_request_error");
    expect(first.retry).toBe(false);
    const again = await failure(stripeClient.createCheckoutSession(request, open()));
    expect(again.code).toBe(first.code);
  });
});

describe("failures and their retry flag (S-2)", () => {
  const scripted: Array<[string, FakeStripeBehaviour, string, boolean]> = [
    ["a dropped connection", "drop", "stripe_network", true],
    ["409 lock_timeout", { error: 409, type: "invalid_request_error", code: "lock_timeout" }, "stripe_409_lock_timeout", true],
    ["429 rate_limit", { error: 429, type: "invalid_request_error", code: "rate_limit" }, "stripe_429_rate_limit", true],
    ["429 with no body", { respond: 429, raw: "" }, "stripe_429", true],
    ["500 api_error", { error: 500, type: "api_error" }, "stripe_500_api_error", true],
    ["502 with an HTML page", { respond: 502, raw: "<html>bad gateway</html>", headers: { "content-type": "text/html" } }, "stripe_502", true],
    ["503 with no body", { respond: 503, raw: "" }, "stripe_503", true],
    ["500 with an oversized body", { huge: 70 * 1024, status: 500 }, "stripe_500", true],
    ["400 parameter_missing", { error: 400, type: "invalid_request_error", code: "parameter_missing" }, "stripe_400_parameter_missing", false],
    ["400 with only a type", { error: 400, type: "invalid_request_error" }, "stripe_400_invalid_request_error", false],
    ["402 card_declined", { error: 402, type: "card_error", code: "card_declined" }, "stripe_402_card_declined", false],
    ["401 bad key", { error: 401, type: "invalid_request_error" }, "stripe_401_invalid_request_error", false],
    ["403 permission", { error: 403, type: "invalid_request_error", code: "secret_key_required" }, "stripe_403_secret_key_required", false],
    ["404", { respond: 404, body: { error: { type: "invalid_request_error" } } }, "stripe_404_invalid_request_error", false],
    ["a redirect, never followed", { respond: 302, raw: "", headers: { location: "https://elsewhere.example/v1/checkout/sessions" } }, "stripe_302", false],
  ];
  for (const [name, behaviour, code, retry] of scripted) {
    it(`${name}: ${code}, retry ${retry}`, async () => {
      stripe.queue(behaviour);
      const { result: error, received, sessions } = await observe(() => failure(client().createCheckoutSession(topUp(), open())));
      expect(received).toHaveLength(1);
      expect(sessions).toHaveLength(0);
      expect(error.code).toBe(code);
      expect(error.retry).toBe(retry);
      expect(error.message).toBe(`Stripe request failed: ${code}`);
      expect(error.name).toBe("StripeRequestFailed");
    });
  }

  it("the real auth check: a client with another key is told 401, not retried", async () => {
    const error = await failure(client({ secretKey: secretKey() }).createCheckoutSession(topUp(), open()));
    expect(error).toMatchObject({ code: "stripe_401_invalid_request_error", retry: false });
  });

  it("a fetch that throws, or an aborted signal, is stripe_network with retry", async () => {
    const thrown = await failure(client({}, () => Promise.reject(new TypeError("fetch failed"))).createCheckoutSession(topUp(), open()));
    expect(thrown).toMatchObject({ code: "stripe_network", retry: true });
    const controller = new AbortController();
    controller.abort();
    const aborted = await failure(client().createCheckoutSession(topUp(), { signal: controller.signal }));
    expect(aborted).toMatchObject({ code: "stripe_network", retry: true });
  });

  it("an error code is reduced to safe characters and at most 60 of them", async () => {
    stripe.queue({ error: 400, type: "invalid_request_error", code: "Weird-Code <script>!" });
    expect((await failure(client().createCheckoutSession(topUp(), open()))).code).toBe("stripe_400_weirdcodescript");
    stripe.queue({ error: 400, type: "invalid_request_error", code: "x".repeat(200) });
    expect((await failure(client().createCheckoutSession(topUp(), open()))).code).toBe(`stripe_400_${"x".repeat(60)}`);
  });
});

describe("unreadable success answers are retried (S-2)", () => {
  const goodId = () => `cs_test_${randomBytes(12).toString("hex")}`;
  const bodies: Array<[string, FakeStripeBehaviour]> = [
    ["an id that is not a session", { respond: 200, body: { id: "pi_123", url: "https://checkout.stripe.test/c/pay/x" } }],
    ["an id with bad characters", { respond: 200, body: { id: "cs_test_bad id!", url: "https://checkout.stripe.test/c/pay/x" } }],
    ["an id that is not a string", { respond: 200, body: { id: 42, url: "https://checkout.stripe.test/c/pay/x" } }],
    ["a plain-http url", { respond: 200, body: { id: goodId(), url: "http://checkout.stripe.test/c/pay/x" } }],
    ["no url", { respond: 200, body: { id: goodId() } }],
    ["a body that is not JSON", { respond: 200, raw: "{not json" }],
    ["an empty body", { respond: 200, raw: "" }],
    ["JSON null", { respond: 200, raw: "null" }],
    ["a body over 64 KiB", { huge: 64 * 1024 + 1 }],
  ];
  for (const [name, behaviour] of bodies) {
    it(`${name}: stripe_unreadable_response, retry`, async () => {
      stripe.queue(behaviour);
      const error = await failure(client().createCheckoutSession(topUp(), open()));
      expect(error).toMatchObject({ code: "stripe_unreadable_response", retry: true });
    });
  }

  it("a body of exactly 64 KiB is still read, and any 2xx with a session counts", async () => {
    stripe.queue({ huge: 64 * 1024 });
    const big = await client().createCheckoutSession(topUp(), open());
    expect(big.id).toMatch(/^cs_test_/);
    expect(big.url).toMatch(/^https:\/\//);
    const id = goodId();
    stripe.queue({ respond: 201, body: { id, url: `https://checkout.stripe.test/c/pay/${id}`, extra: true } });
    expect(await client().createCheckoutSession(topUp(), open())).toEqual({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
  });
});

describe("client configuration (S-9)", () => {
  const make = (over: Partial<StripeConfig>) => () => client(over);

  it("applies the defaults", () => {
    const config = createStripeClient({ config: { secretKey: SECRET_KEY, successUrl: SUCCESS, cancelUrl: CANCEL } }).config;
    expect(config).toEqual({
      secretKey: SECRET_KEY,
      baseUrl: STRIPE_DEFAULT_BASE_URL,
      successUrl: SUCCESS,
      cancelUrl: CANCEL,
      currency: "usd",
      minTopUp: 500,
      maxTopUp: 50_000,
      productName: "Message credit",
    });
    expect(STRIPE_DEFAULT_BASE_URL).toBe("https://api.stripe.com");
  });

  it("accepts test, live and restricted keys", () => {
    for (const key of [secretKey("test"), secretKey("live"), secretKey("test", "rk"), secretKey("live", "rk")])
      expect(client({ secretKey: key }).config.secretKey).toBe(key);
  });

  it("refuses a key of the wrong shape without echoing it", () => {
    const tail = randomBytes(16).toString("hex");
    for (const key of [["pk", "test", tail].join("_"), ["sk", "prod", tail].join("_"), ["sk", "test", "short"].join("_"),
      ["sk", "test", `${tail}!`].join("_"), "", ` ${secretKey()}`]) {
      const attempt = () => client({ secretKey: key });
      expect(attempt).toThrow(/secretKey/);
      try {
        attempt();
      } catch (error) {
        if (key.length > 0) expect((error as Error).message).not.toContain(key.trim());
      }
    }
  });

  it("refuses plain http except on loopback, and URLs with credentials", () => {
    expect(make({ baseUrl: "http://api.stripe.com" })).toThrow(/baseUrl/);
    expect(make({ baseUrl: "http://10.0.0.5:8080" })).toThrow(/baseUrl/);
    expect(make({ baseUrl: "ftp://api.stripe.com" })).toThrow(/baseUrl/);
    expect(make({ baseUrl: "not a url" })).toThrow(/baseUrl/);
    expect(make({ baseUrl: "https://user:pw@api.stripe.com" })).toThrow(/baseUrl/);
    expect(make({ successUrl: "http://app.haldenrowe.example/done" })).toThrow(/successUrl/);
    expect(make({ cancelUrl: "http://app.haldenrowe.example/cancel" })).toThrow(/cancelUrl/);
    for (const baseUrl of ["http://127.0.0.1:1234", "http://localhost:1234", "http://[::1]:1234", "https://stripe.proxy.example"])
      expect(client({ baseUrl }).config.baseUrl).toBe(baseUrl);
    expect(client({ successUrl: "http://localhost:3000/done" }).config.successUrl).toBe("http://localhost:3000/done");
  });

  it("refuses minTopUp above maxTopUp, but allows them equal", () => {
    expect(make({ minTopUp: 5000, maxTopUp: 4999 })).toThrow(/minTopUp must not exceed maxTopUp/);
    expect(make({ minTopUp: 60_000 })).toThrow(/minTopUp must not exceed maxTopUp/);
    expect(client({ minTopUp: 5000, maxTopUp: 5000 }).config).toMatchObject({ minTopUp: 5000, maxTopUp: 5000 });
  });

  it("refuses other bad values and unknown fields", () => {
    expect(make({ minTopUp: 0 })).toThrow(/minTopUp/);
    expect(make({ maxTopUp: 1.5 })).toThrow(/maxTopUp/);
    expect(make({ maxTopUp: 100_000_001 })).toThrow(/maxTopUp/);
    expect(make({ currency: "USD" })).toThrow(/currency/);
    expect(make({ currency: "usdx" })).toThrow(/currency/);
    expect(make({ apiVersion: "latest" })).toThrow(/apiVersion/);
    expect(make({ productName: "" })).toThrow(/productName/);
    expect(make({ productName: "p".repeat(101) })).toThrow(/productName/);
    expect(() => createStripeClient({ config: { secretKey: SECRET_KEY, successUrl: SUCCESS, cancelUrl: CANCEL, extra: 1 } as StripeConfig })).toThrow(/Invalid Stripe config/);
    expect(client({ apiVersion: "2026-09-30" }).config.apiVersion).toBe("2026-09-30");
  });
});

describe("verifyStripeWebhook (S-3)", () => {
  const CURRENT = webhookSecret();
  const PREVIOUS = webhookSecret();
  const OTHER = webhookSecret();
  const NOW = new Date(START);
  const T = Math.floor(START / 1000);
  const event = (over: Record<string, unknown> = {}) => ({
    id: `evt_${randomBytes(12).toString("hex")}`,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    created: T,
    data: { object: { id: "cs_test_abc", object: "checkout.session", payment_status: "paid", metadata: { zs_tenant: randomUUID() } } },
    ...over,
  });
  const bytes = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const verify = (header: string | undefined, body: Uint8Array, over: { now?: Date; previous?: string | undefined; toleranceMs?: number } = {}) =>
    verifyStripeWebhook({
      secrets: { current: CURRENT, previous: "previous" in over ? over.previous : PREVIOUS },
      header,
      body,
      now: over.now ?? NOW,
      ...(over.toleranceMs === undefined ? {} : { toleranceMs: over.toleranceMs }),
    });
  const v1 = (header: string) => header.split(",v1=")[1]!;

  it("accepts a body signed by the current secret and returns the event and the raw payload", () => {
    const payload = event({ extra: { nested: [1, 2] } });
    const body = bytes(payload);
    const result = verify(signStripeWebhook(CURRENT, T, body), body);
    expect(result).toEqual({ ok: true, event: stripeEventSchema.parse(payload), payload });
    if (!result.ok) throw new Error("unreachable");
    expect(result.event.id).toBe(payload.id);
    expect(result.event.type).toBe("checkout.session.completed");
    expect(result.event.livemode).toBe(false);
    expect(result.payload).toHaveProperty("extra");
  });

  it("accepts a body signed by the previous secret, and refuses it once no previous secret is set", () => {
    const body = bytes(event());
    const header = signStripeWebhook(PREVIOUS, T, body);
    expect(verify(header, body).ok).toBe(true);
    expect(verify(header, body, { previous: undefined })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts a header with several v1 entries when any one matches, and ignores other schemes and spaces", () => {
    const body = bytes(event());
    const good = v1(signStripeWebhook(CURRENT, T, body));
    const bogus = randomBytes(32).toString("hex");
    const fromOther = v1(signStripeWebhook(OTHER, T, body));
    expect(verify(`t=${T},v1=${bogus},v1=${fromOther},v1=${good}`, body).ok).toBe(true);
    expect(verify(`t=${T}, v0=${bogus}, v1=${good}, junk`, body).ok).toBe(true);
    expect(verify(`v1=${good},t=${T}`, body).ok).toBe(true);
    expect(verify(`t=${T},v1=${bogus},v1=${fromOther}`, body)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a tampered body, another secret, and a moved timestamp as bad_signature", () => {
    const payload = event();
    const body = bytes(payload);
    const header = signStripeWebhook(CURRENT, T, body);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    expect(verify(header, tampered)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(header, bytes({ ...payload, livemode: true }))).toEqual({ ok: false, reason: "bad_signature" });
    // Re-serialised JSON with other whitespace is not the exact bytes.
    expect(verify(header, bytes(JSON.stringify(payload, null, 1)))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(header, Buffer.concat([body, Buffer.from("\n")]))).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(signStripeWebhook(OTHER, T, body), body)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(`t=${T + 1},v1=${v1(header)}`, body)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a missing or garbled header as missing_header", () => {
    const body = bytes(event());
    const good = v1(signStripeWebhook(CURRENT, T, body));
    for (const header of [
      undefined,
      "",
      "garbage",
      `t=${T}`,
      `v1=${good}`,
      `t=,v1=${good}`,
      `t=abc,v1=${good}`,
      `t=-${T},v1=${good}`,
      `t=1234567890123,v1=${good}`,
      `t=${T},v1=${good.slice(0, 63)}`,
      `t=${T},v1=${good.toUpperCase()}`,
      `t=${T},v1=${"z".repeat(64)}`,
      `t=${T},v0=${good}`,
      `t=${T},v1=${good},${"x".repeat(4096)}`,
    ]) expect(verify(header, body), String(header).slice(0, 40)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("refuses a timestamp more than 5 minutes either side of the clock as stale, and accepts the edges", () => {
    expect(STRIPE_WEBHOOK_TOLERANCE_MS).toBe(5 * 60 * 1000);
    const body = bytes(event());
    const header = signStripeWebhook(CURRENT, T, body);
    expect(verify(header, body, { now: new Date(START + STRIPE_WEBHOOK_TOLERANCE_MS) }).ok).toBe(true);
    expect(verify(header, body, { now: new Date(START - STRIPE_WEBHOOK_TOLERANCE_MS) }).ok).toBe(true);
    expect(verify(header, body, { now: new Date(START + STRIPE_WEBHOOK_TOLERANCE_MS + 1) })).toEqual({ ok: false, reason: "stale" });
    expect(verify(header, body, { now: new Date(START - STRIPE_WEBHOOK_TOLERANCE_MS - 1) })).toEqual({ ok: false, reason: "stale" });
    expect(verify(header, body, { now: new Date(START + 2000), toleranceMs: 1000 })).toEqual({ ok: false, reason: "stale" });
    expect(verify(header, body, { now: new Date(START + 2000), toleranceMs: 2000 }).ok).toBe(true);
  });

  it("checks the signature before the timestamp: a stale forgery is bad_signature", () => {
    const body = bytes(event());
    const old = T - 3600;
    expect(verify(signStripeWebhook(OTHER, old, body), body)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(signStripeWebhook(CURRENT, old, body), body)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses a well-signed body that is not a JSON event as bad_event", () => {
    const payload = event();
    const bodies: unknown[] = [
      "not json",
      "",
      "null",
      "[]",
      "\"evt_x\"",
      { ...payload, id: "ev_123" },
      { ...payload, id: "evt_" },
      { ...payload, id: "evt_bad id" },
      { ...payload, type: "" },
      { ...payload, type: "t".repeat(101) },
      { ...payload, livemode: "false" },
      { ...payload, data: undefined },
      { ...payload, data: {} },
      { ...payload, data: { object: "cs_test_abc" } },
      { ...payload, data: { object: null } },
    ];
    for (const value of bodies) {
      const body = bytes(value);
      expect(verify(signStripeWebhook(CURRENT, T, body), body), String(JSON.stringify(value)).slice(0, 60)).toEqual({ ok: false, reason: "bad_event" });
    }
    // Missing fields.
    for (const field of ["id", "type", "livemode", "data"] as const) {
      const { [field]: _dropped, ...rest } = payload;
      const body = bytes(rest);
      expect(verify(signStripeWebhook(CURRENT, T, body), body), field).toEqual({ ok: false, reason: "bad_event" });
    }
  });
});

describe("signStripeWebhook", () => {
  it("is HMAC-SHA-256 over `<t>.<body>` keyed with the secret text, as t=…,v1=…", () => {
    const secret = webhookSecret();
    const body = JSON.stringify({ id: "evt_1", note: "café ☕" });
    const header = signStripeWebhook(secret, 1_800_000_000, body);
    const expected = createHmac("sha256", secret).update(`1800000000.${body}`, "utf8").digest("hex");
    expect(header).toBe(`t=1800000000,v1=${expected}`);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(signStripeWebhook(secret, 1_800_000_000, Buffer.from(body))).toBe(header);
    expect(signStripeWebhook(secret, 1_800_000_000, new Uint8Array(Buffer.from(body)))).toBe(header);
    expect(signStripeWebhook(secret, 1_800_000_001, body)).not.toBe(header);
  });

  it("round-trips through verifyStripeWebhook for string and byte bodies", () => {
    const secret = webhookSecret();
    const payload = { id: "evt_roundtrip_1", type: "charge.refunded", livemode: true, data: { object: { amount_refunded: 500 } } };
    const text = JSON.stringify(payload);
    for (const signedBody of [text, Buffer.from(text)]) {
      const result = verifyStripeWebhook({
        secrets: { current: secret },
        header: signStripeWebhook(secret, 1_800_000_000, signedBody),
        body: Buffer.from(text),
        now: new Date(1_800_000_000 * 1000 + 1234),
      });
      expect(result).toEqual({ ok: true, event: payload, payload });
    }
  });

  it("the webhook secret schema takes whsec_ secrets only", () => {
    expect(stripeWebhookSecretSchema.safeParse(webhookSecret()).success).toBe(true);
    expect(stripeWebhookSecretSchema.safeParse(["whsec", "short"].join("_")).success).toBe(false);
    expect(stripeWebhookSecretSchema.safeParse(["wh", randomBytes(24).toString("hex")].join("_")).success).toBe(false);
    expect(stripeWebhookSecretSchema.safeParse(`${webhookSecret()} `).success).toBe(false);
  });
});

describe("parseStripeEnv (S-9)", () => {
  const base = () => ({
    STRIPE_SECRET_KEY: secretKey("test"),
    STRIPE_WEBHOOK_SECRET: webhookSecret(),
    STRIPE_LIVEMODE: "false",
    STRIPE_SUCCESS_URL: SUCCESS,
    STRIPE_CANCEL_URL: CANCEL,
  });
  /** The message parseStripeEnv throws with (fails the test if it does not throw). */
  const thrown = (env: Record<string, string | undefined>): string => {
    try {
      parseStripeEnv(env);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("parseStripeEnv did not throw");
  };

  it("returns null when no STRIPE_ variable is set (or all are empty)", () => {
    expect(parseStripeEnv({})).toBeNull();
    expect(parseStripeEnv({ RESEND_API_KEY: "x", STRIPE_UNKNOWN: "y", PATH: "/bin" })).toBeNull();
    expect(parseStripeEnv({ STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", STRIPE_LIVEMODE: undefined })).toBeNull();
  });

  it("maps the required variables, leaving defaults to the client config", () => {
    const env = base();
    expect(parseStripeEnv(env)).toEqual({
      client: { secretKey: env.STRIPE_SECRET_KEY, successUrl: SUCCESS, cancelUrl: CANCEL },
      webhook: { livemode: false, secrets: { current: env.STRIPE_WEBHOOK_SECRET } },
    });
  });

  it("maps every optional variable, and the result makes a working client", async () => {
    const env = {
      ...base(),
      STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_WEBHOOK_PREVIOUS_SECRET: webhookSecret(),
      STRIPE_CURRENCY: "eur",
      STRIPE_TOPUP_MIN: "1000",
      STRIPE_TOPUP_MAX: "20000",
      STRIPE_API_VERSION: "2026-09-30.clover",
      STRIPE_BASE_URL: stripe.url,
    };
    const parsed = parseStripeEnv(env)!;
    expect(parsed).toEqual({
      client: {
        secretKey: SECRET_KEY,
        successUrl: SUCCESS,
        cancelUrl: CANCEL,
        currency: "eur",
        minTopUp: 1000,
        maxTopUp: 20000,
        apiVersion: "2026-09-30.clover",
        baseUrl: stripe.url,
      },
      webhook: { livemode: false, secrets: { current: env.STRIPE_WEBHOOK_SECRET, previous: env.STRIPE_WEBHOOK_PREVIOUS_SECRET } },
    });
    const stripeClient = createStripeClient({ config: parsed.client });
    const { received } = await observe(() => stripeClient.createCheckoutSession(topUp({ currency: "eur" }), open()));
    expect(received[0]!.headers["stripe-version"]).toBe("2026-09-30.clover");
  });

  it("treats empty optional variables as unset", () => {
    const env = { ...base(), STRIPE_CURRENCY: "", STRIPE_BASE_URL: "", STRIPE_WEBHOOK_PREVIOUS_SECRET: "" };
    expect(parseStripeEnv(env)?.client).not.toHaveProperty("currency");
    expect(parseStripeEnv(env)?.client).not.toHaveProperty("baseUrl");
    expect(parseStripeEnv(env)?.webhook.secrets).not.toHaveProperty("previous");
  });

  it("throws naming each missing required variable when only some are set", () => {
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_LIVEMODE", "STRIPE_SUCCESS_URL", "STRIPE_CANCEL_URL"] as const) {
      const env: Record<string, string | undefined> = base();
      delete env[name];
      expect(thrown(env), name).toContain(name);
      expect(thrown({ ...env, [name]: "" }), name).toContain(name);
    }
    const only = thrown({ STRIPE_TOPUP_MIN: "500" });
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_LIVEMODE", "STRIPE_SUCCESS_URL", "STRIPE_CANCEL_URL"])
      expect(only).toContain(name);
  });

  it("names the variable for each bad value", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ STRIPE_SECRET_KEY: ["pk", "test", randomBytes(16).toString("hex")].join("_") }, "STRIPE_SECRET_KEY"],
      [{ STRIPE_WEBHOOK_SECRET: ["whsec", "short"].join("_") }, "STRIPE_WEBHOOK_SECRET"],
      [{ STRIPE_WEBHOOK_PREVIOUS_SECRET: "not-a-secret" }, "STRIPE_WEBHOOK_PREVIOUS_SECRET"],
      [{ STRIPE_LIVEMODE: "yes" }, "STRIPE_LIVEMODE"],
      [{ STRIPE_SUCCESS_URL: "http://app.haldenrowe.example/done" }, "STRIPE_SUCCESS_URL"],
      [{ STRIPE_CANCEL_URL: "javascript:alert(1)" }, "STRIPE_CANCEL_URL"],
      [{ STRIPE_BASE_URL: "http://api.stripe.com" }, "STRIPE_BASE_URL"],
      [{ STRIPE_CURRENCY: "USD" }, "STRIPE_CURRENCY"],
      [{ STRIPE_API_VERSION: "latest" }, "STRIPE_API_VERSION"],
      [{ STRIPE_TOPUP_MIN: "abc" }, "STRIPE_TOPUP_MIN"],
      [{ STRIPE_TOPUP_MIN: "0" }, "STRIPE_TOPUP_MIN"],
      [{ STRIPE_TOPUP_MAX: "12.5" }, "STRIPE_TOPUP_MAX"],
      [{ STRIPE_TOPUP_MAX: "100000001" }, "STRIPE_TOPUP_MAX"],
      [{ STRIPE_TOPUP_MIN: "5000", STRIPE_TOPUP_MAX: "4000" }, "STRIPE_TOPUP_MIN"],
    ];
    for (const [over, name] of cases) {
      const message = thrown({ ...base(), ...over });
      expect(message, name).toMatch(/^Invalid environment: /);
      expect(message, name).toContain(name);
    }
  });

  it("never echoes a secret value in an error", () => {
    const tail = randomBytes(16).toString("hex");
    const secrets = {
      STRIPE_SECRET_KEY: ["sk", "test", `${tail}!`].join("_"),
      STRIPE_WEBHOOK_SECRET: ["whsec", `${tail} bad`].join("_"),
      STRIPE_WEBHOOK_PREVIOUS_SECRET: ["whsec", `${tail}?`].join("_"),
    };
    const messages = [
      thrown({ ...base(), ...secrets }),
      thrown({ ...base(), STRIPE_SECRET_KEY: secrets.STRIPE_SECRET_KEY }),
      thrown({ ...base(), STRIPE_WEBHOOK_SECRET: secrets.STRIPE_WEBHOOK_SECRET }),
      thrown({ ...base(), STRIPE_WEBHOOK_PREVIOUS_SECRET: secrets.STRIPE_WEBHOOK_PREVIOUS_SECRET }),
    ];
    // A valid key and secret, with other variables wrong, are not echoed either.
    const good = base();
    messages.push(thrown({ ...good, STRIPE_LIVEMODE: "true" }), thrown({ ...good, STRIPE_CURRENCY: "USD" }), thrown({ ...good, STRIPE_TOPUP_MIN: "x" }));
    for (const message of messages) {
      expect(message).not.toContain(tail);
      expect(message).not.toContain(good.STRIPE_SECRET_KEY);
      expect(message).not.toContain(good.STRIPE_WEBHOOK_SECRET);
    }
  });

  it("refuses STRIPE_LIVEMODE that does not match the key's mode", () => {
    expect(thrown({ ...base(), STRIPE_SECRET_KEY: secretKey("live"), STRIPE_LIVEMODE: "false" }))
      .toBe("Invalid environment: STRIPE_LIVEMODE does not match the mode of STRIPE_SECRET_KEY");
    expect(thrown({ ...base(), STRIPE_SECRET_KEY: secretKey("test"), STRIPE_LIVEMODE: "true" })).toContain("STRIPE_LIVEMODE");
    expect(thrown({ ...base(), STRIPE_SECRET_KEY: secretKey("test", "rk"), STRIPE_LIVEMODE: "true" })).toContain("STRIPE_LIVEMODE");
    expect(parseStripeEnv({ ...base(), STRIPE_SECRET_KEY: secretKey("live"), STRIPE_LIVEMODE: "true" })?.webhook.livemode).toBe(true);
    expect(parseStripeEnv({ ...base(), STRIPE_SECRET_KEY: secretKey("live", "rk"), STRIPE_LIVEMODE: "true" })?.webhook.livemode).toBe(true);
    expect(parseStripeEnv({ ...base(), STRIPE_SECRET_KEY: secretKey("test", "rk"), STRIPE_LIVEMODE: "false" })?.webhook.livemode).toBe(false);
  });
});

describe("mapError for StripeRequestFailed (S-2)", () => {
  it("a retryable failure is 503 Unavailable with the fixed message", () => {
    for (const code of ["stripe_network", "stripe_429_rate_limit", "stripe_503", "stripe_unreadable_response", "stripe_409_idempotency_key_in_use"])
      expect(mapError(new StripeRequestFailed(code, true))).toEqual({
        status: 503,
        body: { error: { code: "Unavailable", message: "Service unavailable", details: {} } },
      });
  });

  it("any other refusal is 500 Internal with the fixed message", () => {
    for (const code of ["stripe_400_parameter_missing", "stripe_401_invalid_request_error", "stripe_402_card_declined", "stripe_400_idempotency_error"])
      expect(mapError(new StripeRequestFailed(code, false))).toEqual({
        status: 500,
        body: { error: { code: "Internal", message: "Internal error", details: {} } },
      });
  });

  it("never puts Stripe's code in the body, from a real client failure either", async () => {
    stripe.queue({ error: 429, type: "invalid_request_error", code: "rate_limit" });
    const busy = mapError(await failure(client().createCheckoutSession(topUp(), open())));
    stripe.queue({ error: 402, type: "card_error", code: "card_declined" });
    const refused = mapError(await failure(client().createCheckoutSession(topUp(), open())));
    expect(busy.status).toBe(503);
    expect(refused.status).toBe(500);
    for (const { body } of [busy, refused]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/stripe|rate_limit|card_declined|429|402/i);
    }
  });
});
