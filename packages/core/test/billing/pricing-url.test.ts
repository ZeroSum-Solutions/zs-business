// connections.md C-29, plans.md PL-15, PL-19: Shopify's plan selection page address, built only from checked handles.
import { describe, expect, it } from "vitest";
import { shopifyPricingUrl } from "../../src/index.js";

describe("shopifyPricingUrl", () => {
  it("builds the plan selection page from a store domain or handle and the app handle", () => {
    const url = "https://admin.shopify.com/store/halden-rowe/charges/zs-business-connections/pricing_plans";
    expect(shopifyPricingUrl("halden-rowe.myshopify.com", "zs-business-connections")).toBe(url);
    expect(shopifyPricingUrl("halden-rowe", "zs-business-connections")).toBe(url);
  });

  it("is null without a store or an app handle", () => {
    for (const [store, app] of [[null, "x"], [undefined, "x"], ["", "x"], ["a", null], ["a", undefined], ["a", ""]] as const) expect(shopifyPricingUrl(store, app)).toBeNull();
  });

  it("is null for a handle that is not a plain lowercase handle (no dots, slashes or encoded bytes)", () => {
    for (const bad of ["..", ".", "a/b", "a%2fb", "A", "-a", "a.b", "a b", "x".repeat(61)]) expect(shopifyPricingUrl(bad, "app"), bad).toBeNull();
    for (const bad of ["..", "a/b", "A", "-a", "a.b", "x".repeat(101)]) expect(shopifyPricingUrl("shop", bad), bad).toBeNull();
    expect(shopifyPricingUrl("a.myshopify.com.myshopify.com", "app")).toBeNull();
  });
});
