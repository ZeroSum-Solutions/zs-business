import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SCOPES, CONNECTION_TOOLKITS, CONNECTION_TOOL_ERROR_CODES, READ_SCOPES, SERVER_IDEMPOTENCY_PREFIXES, connectConnectionRequestSchema,
  connectionToolErrorSchema, idempotencyKeySchema, normalizeAccountLabel, runConnectionToolInputSchema,
  shopifyGetOrderInputSchema, shopifyListOrdersInputSchema, shopDomainSchema, toolkitSchema,
  accountLabelSchema, connectConnectionInputSchema, connectionSchema, connectorCancelResponseSchema, connectorLinkResponseSchema,
} from "../src/index.js";

describe("connections contracts (C-4, C-6, C-10, C-14, C-16)", () => {
  it("adds connections:read as a read scope and reserves the connect: key prefix", () => {
    expect(READ_SCOPES).toContain("connections:read");
    expect(AUTOMATION_SCOPES).toHaveLength(11);
    expect(SERVER_IDEMPOTENCY_PREFIXES).toContain("connect:");
    expect(idempotencyKeySchema.safeParse("connect:abc").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("CONNECT:abc").success).toBe(false);
  });

  it("accepts only an exact myshopify domain and a catalog-shaped toolkit", () => {
    for (const ok of ["a.myshopify.com", "my-shop-1.myshopify.com"]) expect(shopDomainSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["-a.myshopify.com", "a.myshopify.com/x", "a.myshopify.com.evil.com", "evil.com", "a@b.myshopify.com", "a.myshopify.com?x=1", ""])
      expect(shopDomainSchema.safeParse(bad).success, bad).toBe(false);
    // C-10: lower-cased (and trimmed) before the pattern, on every side that parses it.
    expect(shopDomainSchema.parse(" My-Shop.MyShopify.COM ")).toBe("my-shop.myshopify.com");
    expect(toolkitSchema.safeParse("shopify").success).toBe(true);
    expect(toolkitSchema.safeParse("Shopify/..").success).toBe(false);
    expect(connectConnectionRequestSchema.safeParse({ shopDomain: "a.myshopify.com", browserBinding: "x".repeat(43), extra: 1 }).success).toBe(false);
  });

  it("refuses unknown and override fields in tool arguments", () => {
    expect(shopifyGetOrderInputSchema.safeParse({ orderId: "123" }).success).toBe(true);
    for (const extra of ["custom_auth_params", "custom_connection_data", "text", "instant_account", "connected_account_id"])
      expect(shopifyGetOrderInputSchema.safeParse({ orderId: "123", [extra]: "x" }).success, extra).toBe(false);
    expect(shopifyGetOrderInputSchema.safeParse({ orderId: "gid://shopify/Order/1" }).success).toBe(false);
    expect(shopifyListOrdersInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(shopifyListOrdersInputSchema.safeParse({ status: "weird" }).success).toBe(false);
  });

  it("limits the order range to 92 days", () => {
    const range = (a: string, b: string) => shopifyListOrdersInputSchema.safeParse({ createdAfter: a, createdBefore: b }).success;
    expect(range("2026-08-01T00:00:00.000Z", "2026-10-31T00:00:00.000Z")).toBe(true);
    expect(range("2026-08-01T00:00:00.000Z", "2026-11-03T00:00:00.000Z")).toBe(false);
    expect(range("2026-10-31T00:00:00.000Z", "2026-08-01T00:00:00.000Z")).toBe(false);
  });

  it("lists the catalog with our tool names of at most 40 characters and no provider slug", () => {
    const names = CONNECTION_TOOLKITS.flatMap((toolkit) => toolkit.tools.map((tool) => tool.name));
    expect(names).toEqual(["shopify_list_orders", "shopify_get_order"]);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(40);
  });

  it("shapes tool errors without provider text", () => {
    expect(connectionToolErrorSchema.safeParse({ error: { code: "provider_rate_limited", retryAfterSeconds: 30 } }).success).toBe(true);
    // C-10: the app's permissions blocking a read is its own code, apart from the reconnect one.
    expect(connectionToolErrorSchema.safeParse({ error: { code: "provider_permission_denied" } }).success).toBe(true);
    expect(CONNECTION_TOOL_ERROR_CODES).toContain("connection_needs_reconnect");
    expect(connectionToolErrorSchema.safeParse({ error: { code: "boom", message: "x" } }).success).toBe(false);
    expect(runConnectionToolInputSchema.parse({ connectionId: "7b3f1a52-1111-4222-8333-444455556666", tool: "t" }).arguments).toEqual({});
  });

  it("normalizes labels: NFC, no control, format or bidi characters, collapsed spaces, 1..120", () => {
    expect(normalizeAccountLabel("  Café   Shop\n\t")).toBe("Café Shop");
    expect(normalizeAccountLabel("Zero​Sum ‮Shop‬⁦x⁩")).toBe("ZeroSum Shopx");
    expect(normalizeAccountLabel("a\u0000b")).toBe("a b");
    expect(normalizeAccountLabel("​ \u0007 ")).toBeNull();
    expect([...normalizeAccountLabel("x".repeat(500))!]).toHaveLength(120);
    expect(normalizeAccountLabel("lone \ud800 surrogate")).toBe("lone � surrogate");
  });

  it("is idempotent and NFC for random hostile text (property, seeded)", () => {
    // A format character between a base and a combining mark used to leave the first pass decomposed.
    const pieces = ["a", "e", "\u0301", "\u200b", "\u202e", "\u0000", " ", "\t", "\n", "\u2028", "\ud800", "\udc00", "😀", "\u0041\u030a", "\u00c5", "\ufeff", "\ue000", "\u0378", "Z", "\u0308"];
    let seed = 20261108;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 4000; i += 1) {
      const raw = Array.from({ length: 1 + Math.floor(next() * 40) }, () => pieces[Math.floor(next() * pieces.length)]).join("");
      const once = normalizeAccountLabel(raw);
      if (once === null) continue;
      expect(normalizeAccountLabel(once), JSON.stringify(raw)).toBe(once);
      expect(once, JSON.stringify(raw)).toBe(once.normalize("NFC"));
      expect([...once].length).toBeLessThanOrEqual(120);
    }
    expect(normalizeAccountLabel("e\u200b\u0301")).toBe("\u00e9");
    const nearCut = "x".repeat(119) + "e\u0301";
    expect(normalizeAccountLabel(nearCut)).toBe("x".repeat(119) + "\u00e9");
  });

  it("counts label characters, not UTF-16 units, as the database does (C-8 of the fix round, C-14)", () => {
    const astral = "😀".repeat(120);
    expect(normalizeAccountLabel(astral + "x")).toBe(astral);
    expect(accountLabelSchema.safeParse(astral).success).toBe(true);
    expect(accountLabelSchema.safeParse(astral + "x").success).toBe(false);
    expect(accountLabelSchema.safeParse("").success).toBe(false);
  });

  it("keeps the Composio account ID out of the connect action's payload (C-1)", () => {
    const payload = { connectionId: "7b3f1a52-1111-4222-8333-444455556666", toolkit: "shopify", externalAccountId: "1", accountDomain: "a.myshopify.com", accountLabel: "A" };
    expect(connectConnectionInputSchema.safeParse(payload).success).toBe(true);
    expect(connectConnectionInputSchema.safeParse({ ...payload, composioAccountId: "ca_1" }).success).toBe(false);
  });

  it("names the worker's cancel and link refusals (C-5, C-12)", () => {
    expect(connectorCancelResponseSchema.safeParse({ outcome: "cancelled", revokeFailed: true }).success).toBe(true);
    expect(connectorCancelResponseSchema.safeParse({ outcome: "not_found" }).success).toBe(true);
    expect(connectorCancelResponseSchema.safeParse({ outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: 60 }).success).toBe(true);
    expect(connectorCancelResponseSchema.safeParse({ outcome: "refused", code: "account_mismatch" }).success).toBe(true);
    expect(connectorCancelResponseSchema.safeParse({ outcome: "cancelled" }).success).toBe(false);
    expect(connectorLinkResponseSchema.safeParse({ outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: 60 }).success).toBe(true);
  });

  it("reads a connection with a tier, and without one (additive field, C-18)", () => {
    const base = {
      id: "7b3f1a52-1111-4222-8333-444455556666", toolkit: "shopify", accountLabel: "A", accountDomain: "a.myshopify.com", status: "reauthorize",
      reauthorizeReason: "auth_error", revokeFailed: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z",
    };
    // An answer stored before the field existed, and one from an older server, still parse and carry no tier.
    const old = connectionSchema.parse(base);
    expect(old.tier).toBeUndefined();
    expect("tier" in old).toBe(false);
    for (const tier of ["native", "composio"] as const) expect(connectionSchema.parse({ ...base, tier }).tier).toBe(tier);
    expect(connectionSchema.safeParse({ ...base, tier: "other" }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...base, tier: null }).success).toBe(false);
  });
});
