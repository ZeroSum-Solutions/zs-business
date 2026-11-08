import { describe, expect, it } from "vitest";
import { redactStoreIdentity } from "../../src/shopify/redact.js";

const identity = { domain: "zs-test-store.myshopify.com", shopId: "gid://shopify/Shop/9001", names: ["ZS Test (Store) [1]", "  "] };

describe("redactStoreIdentity", () => {
  it("replaces the domain (any case), the shop id and the name wherever they appear, and nulls name keys, without touching the input", () => {
    const input = { a: "ZS-Test-Store.myshopify.com", b: ["x gid://shopify/Shop/9001 y", { accountLabel: "Anything" }], c: "zs test (store) [1]", d: 5, e: null, f: { shopName: "ZS Test (Store) [1]" } };
    const before = JSON.stringify(input);
    expect(redactStoreIdentity(input, identity)).toEqual({ a: "redacted.invalid", b: ["x redacted y", { accountLabel: null }], c: "redacted", d: 5, e: null, f: { shopName: null } });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("does not treat regex characters in the domain as patterns and keeps other shops' values", () => {
    expect(redactStoreIdentity({ s: "zs-test-storeXmyshopifyYcom", t: "other.myshopify.com" }, identity)).toEqual({ s: "zs-test-storeXmyshopifyYcom", t: "other.myshopify.com" });
  });
});
