import { describe, expect, it } from "vitest";
import {
  AUTOMATION_SCOPES, CONNECTION_TOOLKITS, READ_SCOPES, SERVER_IDEMPOTENCY_PREFIXES, connectConnectionRequestSchema,
  connectionToolErrorSchema, idempotencyKeySchema, normalizeAccountLabel, runConnectionToolInputSchema,
  shopifyGetOrderInputSchema, shopifyListOrdersInputSchema, shopDomainSchema, toolkitSchema,
} from "../src/index.js";

describe("connections contracts (C-4, C-6, C-10, C-14, C-16)", () => {
  it("adds connections:read as a read scope and reserves the connect: key prefix", () => {
    expect(READ_SCOPES).toContain("connections:read");
    expect(AUTOMATION_SCOPES).toHaveLength(10);
    expect(SERVER_IDEMPOTENCY_PREFIXES).toContain("connect:");
    expect(idempotencyKeySchema.safeParse("connect:abc").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("CONNECT:abc").success).toBe(false);
  });

  it("accepts only an exact myshopify domain and a catalog-shaped toolkit", () => {
    for (const ok of ["a.myshopify.com", "my-shop-1.myshopify.com"]) expect(shopDomainSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["-a.myshopify.com", "a.myshopify.com/x", "a.myshopify.com.evil.com", "evil.com", "A.myshopify.com", "a@b.myshopify.com", "a.myshopify.com?x=1", ""])
      expect(shopDomainSchema.safeParse(bad).success, bad).toBe(false);
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
});
