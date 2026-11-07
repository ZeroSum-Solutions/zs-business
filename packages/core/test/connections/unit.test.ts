// Connections (docs/requirements/connections.md C-3, C-5, C-6, C-8, C-10, C-14): the pieces that need no
// database. Signing, tokens, the catalog, the Composio client against the in-process fake, the size trim.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONNECTION_RESULT_MAX_BYTES } from "@zs/contracts";
import {
  COMPOSIO_STATUSES, ComposioError, OVERRIDE_KEYS, buildExecuteEnvelope, catalogTool, catalogToolkit, classifyExecuteFailure, completeDecision,
  connectGrantId, connectIdempotencyKey, createComposioClient, liveDecision, normalizeStatus, signConnectAttempt, signConnectGrant,
  signConnectorRequest, trimToSize, verifyConnectAttempt, verifyConnectGrant, verifyConnectorRequest, attemptBrowserMatches,
  MAX_CONNECT_GRANT_LENGTH, browserBindingFor, callbackCharges, callbackStatusCharges, runCharges, connectCharges, checkComposioCatalog, COMPOSIO_CATALOG,
} from "../../src/index.js";
import { FakeComposio, fakeOrder } from "./fake-composio.js";

const SECRET = ["conn", "internal", "a".repeat(32)].join("-");
const PREVIOUS = ["conn", "internal", "b".repeat(32)].join("-");
const STATE = ["conn", "state", "c".repeat(32)].join("-");
const NOW = new Date("2026-11-06T12:00:00.000Z");
const HOST = "worker.example.test";
const PATH = "/internal/connections/run";
const BODY = JSON.stringify({ tenantId: "t" });

const verify = (overrides: Partial<Omit<Parameters<typeof verifyConnectorRequest>[0], "headers">> & { headers: Record<string, string> }) => {
  const { headers, ...rest } = overrides;
  return verifyConnectorRequest({
    secrets: { current: SECRET }, env: "preview", host: HOST, method: "POST", path: PATH, body: BODY, now: NOW,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null }, takeNonce: async () => true, ...rest,
  });
};
const signed = (extra: Partial<Parameters<typeof signConnectorRequest>[0]> = {}) =>
  signConnectorRequest({ secret: SECRET, env: "preview", host: HOST, path: PATH, body: BODY, now: NOW, ...extra });

describe("internal request signature (C-3, C-15)", () => {
  it("accepts a fresh, signed request and records its jti once", async () => {
    const seen = new Set<string>();
    const takeNonce = async (jti: string) => !seen.has(jti) && Boolean(seen.add(jti));
    const headers = signed();
    expect(await verify({ headers, takeNonce })).toEqual({ ok: true });
    expect(await verify({ headers, takeNonce })).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses unsigned, stale, wrong-environment, wrong-host, wrong-path, wrong-body and wrong-method requests", async () => {
    expect(await verify({ headers: {} })).toEqual({ ok: false, reason: "unsigned" });
    expect(await verify({ headers: signed({ now: new Date(NOW.getTime() - 61_000) }) })).toEqual({ ok: false, reason: "stale" });
    expect(await verify({ headers: signed({ now: new Date(NOW.getTime() + 61_000) }) })).toEqual({ ok: false, reason: "stale" });
    expect(await verify({ headers: signed({ env: "production" }) })).toEqual({ ok: false, reason: "wrong_env" });
    expect(await verify({ headers: signed({ host: "other.example.test" }) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ headers: signed({ path: "/internal/connections/link" }) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ headers: signed({ body: "{}" }) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ headers: signed({ method: "GET" }) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ headers: signed({ secret: PREVIOUS }) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("verifies through a rotation and spends no nonce on a forged tag", async () => {
    expect(await verify({ headers: signed({ secret: PREVIOUS }), secrets: { current: SECRET, previous: PREVIOUS } })).toEqual({ ok: true });
    let taken = 0;
    await verify({ headers: signed({ secret: PREVIOUS }), takeNonce: async () => { taken += 1; return true; } });
    expect(taken).toBe(0);
  });

  it("refuses a malformed tag spelling and a missing host", async () => {
    const headers = { ...signed(), "x-zs-conn-signature": `${signed()["x-zs-conn-signature"]}A` };
    expect(await verify({ headers })).toEqual({ ok: false, reason: "unsigned" });
    expect(await verify({ headers: signed(), host: undefined })).toEqual({ ok: false, reason: "unsigned" });
  });
});

const attemptFields = () => ({
  tenantId: randomUUID(), actorId: randomUUID(), toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(),
  composioAccountId: "ca_1", authConfigId: "ac_shopify", browserHash: "h".repeat(43), expiresAt: NOW.getTime() + 600_000,
});
const grantFields = () => ({
  tenantId: randomUUID(), actorId: randomUUID(), toolkit: "shopify", attemptId: randomUUID(), connectionId: randomUUID(), composioAccountId: "ca_1",
  authConfigId: "ac_shopify", browserHash: "b".repeat(43),
  accountDomain: "testshop.myshopify.com", externalAccountId: "8812345", accountLabel: "Test Shop", expiresAt: NOW.getTime() + 600_000,
});

describe("attempt and grant tokens (C-4, C-5)", () => {
  it("round-trips, expires, and verifies through a rotation", () => {
    const attempt = attemptFields();
    const token = signConnectAttempt(STATE, attempt);
    expect(token.startsWith("zca1.")).toBe(true);
    expect(verifyConnectAttempt({ current: STATE }, token, NOW)).toEqual(attempt);
    expect(verifyConnectAttempt({ current: STATE }, token, new Date(attempt.expiresAt))).toBeNull();
    expect(verifyConnectAttempt({ current: PREVIOUS, previous: STATE }, token, NOW)).toEqual(attempt);
    expect(verifyConnectAttempt({ current: PREVIOUS }, token, NOW)).toBeNull();
  });

  it("never reads a token of one kind as the other, or a tampered or re-spelled one", () => {
    const attempt = signConnectAttempt(STATE, attemptFields());
    const grant = signConnectGrant(STATE, grantFields())!;
    expect(verifyConnectGrant({ current: STATE }, attempt, NOW)).toBeNull();
    expect(verifyConnectAttempt({ current: STATE }, grant, NOW)).toBeNull();
    expect(verifyConnectAttempt({ current: STATE }, `${attempt}x`, NOW)).toBeNull();
    const [head, body, tag] = attempt.split(".") as [string, string, string];
    expect(verifyConnectAttempt({ current: STATE }, `${head}.${body}.${tag.slice(0, 42)}${tag.endsWith("A") ? "B" : "A"}`, NOW)).toBeNull();
    expect(verifyConnectAttempt({ current: STATE }, undefined, NOW)).toBeNull();
  });

  it("binds the attempt to the browser that started it, and the grant to its exact bytes", () => {
    const key = "k".repeat(43);
    const browserHash = browserBindingFor(key);
    expect(attemptBrowserMatches({ browserHash }, key)).toBe(true);
    expect(attemptBrowserMatches({ browserHash }, "j".repeat(43))).toBe(false);
    expect(attemptBrowserMatches({ browserHash }, undefined)).toBe(false);
    const one = signConnectGrant(STATE, grantFields())!;
    const two = signConnectGrant(STATE, grantFields())!;
    expect(connectGrantId(one)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connectGrantId(one)).not.toBe(connectGrantId(two));
    expect(connectIdempotencyKey("ABC")).toBe("connect:abc");
  });

  it("C-14: the grant carries the attempt's auth config and browser binding", () => {
    const fields = grantFields();
    expect(verifyConnectGrant({ current: STATE }, signConnectGrant(STATE, fields)!, NOW)).toEqual(fields);
    expect(verifyConnectGrant({ current: STATE }, signConnectGrant(STATE, { ...fields, browserHash: "short" })!, NOW)).toBeNull();
  });

  it("C-8: a label is counted in characters, so 120 astral characters fit and 121 do not", () => {
    const fits = "\u{1F600}".repeat(120);
    expect(verifyConnectGrant({ current: STATE }, signConnectGrant(STATE, { ...grantFields(), accountLabel: fits })!, NOW)?.accountLabel).toBe(fits);
    expect(verifyConnectGrant({ current: STATE }, signConnectGrant(STATE, { ...grantFields(), accountLabel: `${fits}x` })!, NOW)).toBeNull();
  });

  it("refuses a grant whose label is not in normal form, and one that would not fit a cookie", () => {
    expect(verifyConnectGrant({ current: STATE }, signConnectGrant(STATE, { ...grantFields(), accountLabel: "  two  spaces " })!, NOW)).toBeNull();
    expect(signConnectGrant(STATE, { ...grantFields(), accountLabel: "x".repeat(120), externalAccountId: "1".repeat(64), composioAccountId: "c".repeat(128) })!.length)
      .toBeLessThanOrEqual(MAX_CONNECT_GRANT_LENGTH);
  });
});

describe("rate-limit charges (C-4, C-5, C-12)", () => {
  it("names tenant-scoped keys and the two run buckets", () => {
    const tenant = randomUUID();
    expect(connectCharges(tenant)).toEqual([{ key: `conn-connect:${tenant}`, rule: { limit: 10, windowMs: 3_600_000 } }]);
    expect(callbackCharges(tenant)[0]).toEqual({ key: `conn-callback:${tenant}`, rule: { limit: 30, windowMs: 3_600_000 } });
    const attempt = randomUUID();
    // C-5: a status call is capped per attempt and spends the tenant's run buckets too.
    expect(callbackStatusCharges(tenant, attempt).map((c) => [c.key, c.rule.limit])).toEqual([
      [`conn-status:${tenant}`, 120], [`conn-status-attempt:${attempt}`, 5], [`conn-minute:${tenant}`, 60], [`conn-day:${tenant}`, 2000],
    ]);
    expect(runCharges(tenant).map((c) => [c.key, c.rule.limit, c.rule.windowMs])).toEqual([
      [`conn-minute:${tenant}`, 60, 60_000], [`conn-day:${tenant}`, 2000, 86_400_000],
    ]);
  });
});

describe("status map (C-8)", () => {
  it("is exhaustive and fails closed", () => {
    for (const status of COMPOSIO_STATUSES) {
      expect(completeDecision(status)).toBe(status === "ACTIVE" ? "go" : status === "INITIATED" || status === "INITIALIZING" ? "pending" : "refuse");
      expect(liveDecision(status)).toBe(status === "ACTIVE" ? "active" : "reauthorize");
    }
    expect(normalizeStatus("active")).toBe("ACTIVE");
    for (const odd of ["PAUSED", "", undefined, 7, null]) {
      expect(normalizeStatus(odd)).toBe("UNKNOWN");
      expect(completeDecision(normalizeStatus(odd))).toBe("refuse");
      expect(liveDecision(normalizeStatus(odd))).toBe("reauthorize");
    }
  });
});

describe("Composio client (C-2, C-3, C-10, C-14)", () => {
  const make = (fake: FakeComposio, extra: { timeoutMs?: number; maxBodyBytes?: number } = {}) =>
    createComposioClient({ apiKey: "test-key", baseUrl: "https://composio.test/api/v3.1", fetch: fake.fetch, ...extra });

  it("builds the execute envelope from exactly four values and refuses overrides and a missing version", () => {
    const envelope = buildExecuteEnvelope({ slug: "S", version: "v1", userId: "zsb:preview:t", connectedAccountId: "ca_1", arguments: { a: 1 } });
    expect(Object.keys(envelope).sort()).toEqual(["arguments", "connected_account_id", "user_id", "version"]);
    for (const key of ["custom_auth_params", "custom_connection_data", "text", "instant_account"])
      expect(OVERRIDE_KEYS.has(key)).toBe(true);
    for (const key of OVERRIDE_KEYS)
      expect(() => buildExecuteEnvelope({ slug: "S", version: "v1", userId: "u", connectedAccountId: "c", arguments: { [key]: "x" } }), key).toThrow();
    expect(() => buildExecuteEnvelope({ slug: "S", version: "", userId: "u", connectedAccountId: "c", arguments: {} })).toThrow();
  });

  it("sends the key, parses accounts with an allowlist and drops the credential state", async () => {
    const fake = new FakeComposio();
    fake.seed({ id: "ca_9", userId: "zsb:preview:t" });
    const account = await make(fake).getAccount("ca_9");
    expect(account).toEqual({ id: "ca_9", status: "ACTIVE", userId: "zsb:preview:t", toolkit: "shopify", authConfigId: "ac_shopify" });
    expect(JSON.stringify(account)).not.toMatch(/masked|access_token|leak/);
    expect(fake.calls.every((call) => call.apiKey === "test-key")).toBe(true);
    expect(await make(fake).getAccount("missing")).toBeNull();
  });

  it("treats a 200 with successful:false, a missing data and an unusable body as errors, never data", async () => {
    const fake = new FakeComposio();
    fake.seed({ id: "ca_1", userId: "u" });
    const client = make(fake);
    const call = () => client.execute({ slug: "SHOPIFY_QUERY_SHOP", version: "v", userId: "u", connectedAccountId: "ca_1", arguments: {} });
    // A-5: the class comes from a structured status only; words in the text never make an auth error.
    fake.override(/tools\/execute/, { status: 200, json: { successful: false, error: "Token has expired; please reauthorize" } });
    expect(await call()).toEqual({ kind: "failed", reason: "unavailable" });
    fake.clearOverrides();
    fake.override(/tools\/execute/, { status: 200, json: { successful: false, error: "Forbidden product title", data: { status_code: 401 } } });
    expect(await call()).toEqual({ kind: "failed", reason: "auth" });
    fake.clearOverrides();
    fake.override(/tools\/execute/, { status: 200, json: { successful: false, error: { status_code: 429, message: "slow down" } } });
    expect(await call()).toEqual({ kind: "failed", reason: "rate_limited" });
    fake.clearOverrides();
    fake.override(/tools\/execute/, { status: 200, json: { successful: false, error: { message: "boom" } } });
    expect(await call()).toEqual({ kind: "failed", reason: "unavailable" });
    fake.clearOverrides();
    fake.override(/tools\/execute/, { status: 200, json: { successful: true, error: null } });
    expect(await call()).toEqual({ kind: "failed", reason: "unavailable" });
    fake.clearOverrides();
    fake.override(/tools\/execute/, { status: 200, json: { nonsense: true } });
    await expect(call()).rejects.toMatchObject({ kind: "unavailable", detail: "malformed" });
  });

  it("maps HTTP statuses without provider text: 429 and 402 rate, 401, 403 and 410 our key refused, 404 gone, 5xx unavailable", async () => {
    const fake = new FakeComposio();
    const client = make(fake);
    // A-5: a 401, 403 or 410 on our own call is about our key or project, never the store's grant.
    const kinds: Record<number, string> = { 429: "rate_limited", 402: "rate_limited", 401: "key_refused", 403: "key_refused", 410: "key_refused", 404: "not_found", 400: "bad_request", 500: "unavailable", 503: "unavailable" };
    for (const [status, kind] of Object.entries(kinds)) {
      fake.clearOverrides();
      fake.override(/connected_accounts\/ca_x(\/revoke)?$/, { status: Number(status), json: { error: { message: "provider words" } } });
      const error = await client.revoke("ca_x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ComposioError);
      expect((error as ComposioError).kind).toBe(kind);
      expect((error as Error).message).not.toMatch(/provider words/);
    }
  });

  it("refuses a 2 MiB body, aborts past the timeout, and follows no redirect", async () => {
    const fake = new FakeComposio();
    fake.seed({ id: "ca_1", userId: "u" });
    fake.override(/GET \/connected_accounts\/ca_1/, { bytes: 2 * 1024 * 1024 });
    await expect(make(fake).getAccount("ca_1")).rejects.toMatchObject({ kind: "unavailable", detail: "too_large" });
    fake.clearOverrides();
    fake.override(/GET \/connected_accounts\/ca_1/, { hang: true });
    const started = Date.now();
    await expect(make(fake, { timeoutMs: 50 }).getAccount("ca_1")).rejects.toMatchObject({ kind: "unavailable", detail: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    const controller = new AbortController();
    const pending = make(fake).getAccount("ca_1", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "unavailable" });
    let redirect: string | undefined;
    const spy: typeof fetch = async (_url, init) => { redirect = init?.redirect; return new Response("{}", { status: 200 }); };
    await createComposioClient({ apiKey: "k", fetch: spy }).getAccount("ca_1").catch(() => undefined);
    expect(redirect).toBe("error");
  });

  it("classifies a 200 failure from structured status fields only and keeps none of its text", () => {
    expect(classifyExecuteFailure({ error: "Invalid access token" })).toBe("unavailable");
    expect(classifyExecuteFailure({ error: { message: "HTTP 429 Too Many Requests" } })).toBe("unavailable");
    expect(classifyExecuteFailure({ error: "x", data: { status_code: 403 } })).toBe("auth");
    expect(classifyExecuteFailure({ error: { statusCode: 401 } })).toBe("auth");
    expect(classifyExecuteFailure({ data: { http_status: 429 } })).toBe("rate_limited");
    expect(classifyExecuteFailure({ data: { status_code: "401" } })).toBe("unavailable");
    expect(classifyExecuteFailure({ data: { status_code: 500 } })).toBe("unavailable");
    expect(classifyExecuteFailure({})).toBe("unavailable");
  });

  it("keeps the account ID of a link answer it cannot parse, so the worker can remove it (B-7)", async () => {
    const fake = new FakeComposio();
    fake.override(/connected_accounts\/link/, { status: 201, json: { connected_account_id: "ca_orphan", redirect_url: "http://not-https.example" } });
    const error = await make(fake).link({ authConfigId: "ac", userId: "u", callbackUrl: "https://x.test/cb", connectionData: {} }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unavailable", detail: "malformed", accountId: "ca_orphan" });
  });
});

describe("catalog and output projection (C-6, C-10, C-14)", () => {
  const list = catalogTool("shopify", "shopify_list_orders")!;
  const get = catalogTool("shopify", "shopify_get_order")!;

  it("pins a version on every tool and the identity call, and offers only our names", () => {
    const toolkit = catalogToolkit("shopify")!;
    expect(toolkit.identity.version).not.toBe("");
    expect(toolkit.tools.map((tool) => tool.name)).toEqual(["shopify_list_orders", "shopify_get_order"]);
    for (const tool of toolkit.tools) expect(tool.version).not.toBe("");
    expect(catalogTool("shopify", "SHOPIFY_GET_ORDER")).toBeUndefined();
    expect(catalogTool("other", "shopify_list_orders")).toBeUndefined();
  });

  it("builds list arguments inside a 92 day range whatever bounds the caller gave", () => {
    const day = 86_400_000;
    const now = NOW;
    for (const input of [{}, { createdAfter: "2026-10-01T00:00:00.000Z" }, { createdBefore: "2026-10-01T00:00:00.000Z" }, { createdAfter: "2026-08-01T00:00:00.000Z", createdBefore: "2026-10-31T00:00:00.000Z" }]) {
      const args = list.toArguments(list.input.parse(input), now) as { created_at_min: string; created_at_max: string; limit: number };
      expect(Date.parse(args.created_at_max) - Date.parse(args.created_at_min)).toBeLessThanOrEqual(92 * day);
      expect(Date.parse(args.created_at_max)).toBeGreaterThan(Date.parse(args.created_at_min));
      expect(args.limit).toBeLessThanOrEqual(50);
    }
    expect(get.toArguments({ orderId: "42" }, now)).toEqual({ order_id: "42" });
  });

  it("keeps only the named output fields", () => {
    const projected = list.project({ orders: [fakeOrder(1001)] }) as { orders: Record<string, unknown>[] };
    const text = JSON.stringify(projected);
    expect(text).not.toMatch(/sku|vendor|should-not-leak|secret|phone|default_address|note_attributes/);
    expect(projected.orders[0]).toMatchObject({
      id: "1001", name: "#1001", financialStatus: "paid", currency: "USD", totalPrice: "59.00",
      lineItems: [{ title: "Mug", quantity: 2, price: "27.00" }], customer: { id: "207119551", name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(list.project({ orders: "no" })).toBeUndefined();
    expect(list.project({ orders: [{ name: "#1" }] })).toEqual({ orders: [] });
    expect(get.project(fakeOrder(5))).toMatchObject({ order: { id: "5" } });
    expect(get.project({ order: fakeOrder(5) })).toBeUndefined();
    expect(get.project(null)).toBeUndefined();
  });

  it("reads the shop's numeric id out of its global id and refuses any other id (C-14)", () => {
    const identity = catalogToolkit("shopify")!.identity;
    const shop = (id: string) => ({ shop: { id, name: "Test Shop", myshopifyDomain: "TestShop.myshopify.com", email: "x@example.com" } });
    expect(identity.arguments).toEqual({ fields: "id name myshopifyDomain" });
    expect(identity.project(shop("gid://shopify/Shop/8812345"))).toEqual({ externalAccountId: "8812345", name: "Test Shop", domain: "testshop.myshopify.com" });
    for (const id of ["8812345", "gid://shopify/Order/8812345", "gid://shopify/Shop/", "gid://shopify/Shop/12a"]) expect(identity.project(shop(id))).toBeUndefined();
    expect(identity.project({ shop: { id: "gid://shopify/Shop/1", name: "x", myshopify_domain: "x.myshopify.com" } })).toBeUndefined();
    expect(identity.project(shop("gid://shopify/Shop/1").shop)).toBeUndefined();
  });

  it("C-9: projects each order on its own, keeps at most 50 orders and 250 line items", () => {
    const sixty = Array.from({ length: 60 }, (_, i) => fakeOrder(2000 + i));
    const capped = list.project({ orders: sixty }) as { orders: { id: string }[] };
    expect(capped.orders).toHaveLength(50);
    expect(capped.orders[0]!.id).toBe("2000");

    const mixed = list.project({ orders: [fakeOrder(1), { name: "no id" }, fakeOrder(3)] }) as { orders: { id: string }[] };
    expect(mixed.orders.map((entry) => entry.id)).toEqual(["1", "3"]);

    const many = { ...fakeOrder(7), line_items: [...Array.from({ length: 300 }, () => ({ title: "Mug", quantity: 1, price: "1.00" })), { title: 5 }] };
    const one = list.project({ orders: [many] }) as { orders: { lineItems: unknown[] }[] };
    expect(one.orders[0]!.lineItems).toHaveLength(250);
    const bad = { ...fakeOrder(8), line_items: [{ title: 5 }, { title: "Cup", quantity: 1, price: "2.00" }] };
    expect((list.project({ orders: [bad] }) as { orders: { lineItems: unknown[] }[] }).orders[0]!.lineItems).toEqual([{ title: "Cup", quantity: 1, price: "2.00" }]);
  });

  it("C-9: a createdAfter far in the past still gives a span of at most 92 days", () => {
    const args = list.toArguments(list.input.parse({ createdAfter: "2020-01-01T00:00:00.000Z" }), NOW) as { created_at_min: string; created_at_max: string };
    expect(Date.parse(args.created_at_max) - Date.parse(args.created_at_min)).toBeLessThanOrEqual(92 * 86_400_000);
  });

  it("trims a long list from the tail, flags it, and leaves a small one alone", () => {
    const orders = Array.from({ length: 200 }, (_, i) => ({ id: String(i), note: "x".repeat(1000) }));
    const small = trimToSize({ orders: orders.slice(0, 3) }, ["orders"], CONNECTION_RESULT_MAX_BYTES)!;
    expect(small.truncated).toBe(false);
    const trimmed = trimToSize({ orders }, ["orders"], CONNECTION_RESULT_MAX_BYTES)!;
    expect(trimmed.truncated).toBe(true);
    const kept = (trimmed.data as { orders: { id: string }[] }).orders;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(200);
    expect(kept[0]!.id).toBe("0");
    expect(Buffer.byteLength(JSON.stringify(trimmed.data))).toBeLessThanOrEqual(CONNECTION_RESULT_MAX_BYTES);
    expect(trimToSize({ blob: "x".repeat(100_000) }, ["orders"], CONNECTION_RESULT_MAX_BYTES)).toBeNull();
  });
});

describe("the owner-run catalog check (A-8, C-6)", () => {
  const client = (fake: FakeComposio) => createComposioClient({ apiKey: "ck_test_secret", baseUrl: "https://composio.test/api/v3.1", fetch: fake.fetch });

  it("passes when every slug exists in its toolkit at the pinned version", async () => {
    const fake = new FakeComposio();
    const report = await checkComposioCatalog(client(fake));
    expect(report.ok).toBe(true);
    const expected = COMPOSIO_CATALOG.flatMap((toolkit) => [toolkit.identity.slug, ...toolkit.tools.map((tool) => tool.slug)]);
    expect(report.results.map((result) => result.slug)).toEqual(expected);
    expect(report.results.every((result) => result.problem === null)).toBe(true);
    expect(fake.calls.every((call) => call.method === "GET" && call.apiKey === "ck_test_secret")).toBe(true);
  });

  it("fails on a missing slug, a version that is gone, another toolkit, and a refused key, and names no secret", async () => {
    const fake = new FakeComposio();
    fake.tools.delete("SHOPIFY_GET_ORDER");
    fake.tools.set("SHOPIFY_GET_ORDERS_WITH_FILTERS", { toolkit: "shopify", versions: ["20261201_00", "20260101_00"] });
    fake.tools.set("SHOPIFY_QUERY_SHOP", { toolkit: "gmail", versions: ["20261104_00"] });
    const report = await checkComposioCatalog(client(fake));
    expect(report.ok).toBe(false);
    expect(Object.fromEntries(report.results.map((result) => [result.slug, result.problem]))).toEqual({
      SHOPIFY_QUERY_SHOP: "wrong_toolkit", SHOPIFY_GET_ORDERS_WITH_FILTERS: "version_missing", SHOPIFY_GET_ORDER: "slug_missing",
    });
    // The version miss was asked for directly before it counted.
    expect(fake.callsTo(/GET \/tools\/SHOPIFY_GET_ORDERS_WITH_FILTERS/).map((call) => call.query.get("toolkit_versions"))).toEqual([null, "20261104_00"]);
    fake.override(/GET \/tools\//, { status: 401 });
    const refused = await checkComposioCatalog(client(fake));
    expect(refused.ok).toBe(false);
    expect(refused.results.every((result) => result.problem === "key_refused")).toBe(true);
    expect(JSON.stringify([report, refused])).not.toContain("ck_test_secret");
  });

  it("accepts a pin the capped version list no longer shows when the registry still has it", async () => {
    const fake = new FakeComposio();
    fake.tools.set("SHOPIFY_GET_ORDER", { toolkit: "shopify", versions: ["20270101_00", "20261104_00"], listed: ["20270101_00"] });
    const report = await checkComposioCatalog(client(fake));
    expect(report.ok).toBe(true);
    expect(fake.callsTo(/GET \/tools\/SHOPIFY_GET_ORDER$/).map((call) => call.query.get("toolkit_versions"))).toEqual([null, "20261104_00"]);
  });

  it("fails a deprecated tool even at a pinned version it still serves", async () => {
    const fake = new FakeComposio();
    fake.tools.set("SHOPIFY_QUERY_SHOP", { toolkit: "shopify", versions: ["20261104_00"], deprecated: true });
    const report = await checkComposioCatalog(client(fake));
    expect(report.ok).toBe(false);
    expect(report.results.find((result) => result.slug === "SHOPIFY_QUERY_SHOP")!.problem).toBe("deprecated");
  });

  it("applies the same checks to the answer at the pinned version", async () => {
    const older = { toolkit: "shopify", versions: ["20270101_00", "20261104_00"], listed: ["20270101_00"] };
    const fake = new FakeComposio();
    fake.tools.set("SHOPIFY_QUERY_SHOP", { ...older, atVersion: { "20261104_00": { deprecated: true } } });
    fake.tools.set("SHOPIFY_GET_ORDERS_WITH_FILTERS", { ...older, atVersion: { "20261104_00": { toolkit: "gmail" } } });
    fake.tools.set("SHOPIFY_GET_ORDER", { ...older, atVersion: { "20261104_00": { slug: "SHOPIFY_OTHER" } } });
    const report = await checkComposioCatalog(client(fake));
    expect(Object.fromEntries(report.results.map((result) => [result.slug, result.problem]))).toEqual({
      SHOPIFY_QUERY_SHOP: "deprecated", SHOPIFY_GET_ORDERS_WITH_FILTERS: "wrong_toolkit", SHOPIFY_GET_ORDER: "slug_changed",
    });
  });

  it("counts an answer that does not say whether the tool is deprecated as unavailable", async () => {
    const fake = new FakeComposio();
    for (const flag of [undefined, null]) {
      fake.clearOverrides();
      fake.override(/GET \/tools\//, { status: 200, json: { slug: "SHOPIFY_QUERY_SHOP", toolkit: { slug: "shopify" }, version: "20261104_00", available_versions: ["20261104_00"], is_deprecated: flag } });
      const report = await checkComposioCatalog(client(fake));
      expect(report.ok).toBe(false);
      expect(report.results[0]!.problem).toBe("unavailable");
    }
  });
});
