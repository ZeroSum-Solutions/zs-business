// BT-3: allowed origins are exact and stored in canonical form (`new URL(o).origin`).
import { describe, expect, it } from "vitest";
import { browserOriginSchema, saveBrowserTargetRequestSchema } from "../src/index.js";

const save = (allowedOrigins: string[]) => saveBrowserTargetRequestSchema.safeParse({
  expectedRevision: 0, name: "Supplier", taskKind: "supplier_invoice_download", allowedOrigins,
  allowedPaths: ["/invoices"], signInPath: "/login", enabled: false,
});

describe("browser origins (BT-3)", () => {
  it.each([
    ["https://portal.example", "https://portal.example"],
    ["https://portal.example:443", "https://portal.example"],
    ["HTTPS://PORTAL.Example", "https://portal.example"],
    ["https://portal.example:8443", "https://portal.example:8443"],
    ["https://portal.example/", "https://portal.example"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:80", "http://127.0.0.1"],
    ["http://[::1]:5173", "http://[::1]:5173"],
  ])("canonicalizes %s to %s", (input, canonical) => {
    expect(browserOriginSchema.parse(input)).toBe(canonical);
  });

  it.each([
    "http://127.0.0.1.attacker.example",
    "http://localhost.attacker.example",
    "http://127.0.0.2",
    "http://portal.example",
    "https://portal.example.",
    "https://portal.example/invoices",
    "https://portal.example?x=1",
    "https://portal.example#top",
    "https://user:pass@portal.example",
    "https://user@portal.example",
    "https://*.portal.example",
    "https://portal.example:99999",
    "ftp://portal.example",
    "https://",
    "portal.example",
    " https://portal.example",
  ])("rejects %s", (input) => {
    expect(browserOriginSchema.safeParse(input).success).toBe(false);
  });

  it("stores canonical origins and rejects duplicates after canonicalization", () => {
    const ok = save(["https://Portal.Example:443", "https://cdn.example:8443"]);
    expect(ok.success && ok.data.allowedOrigins).toEqual(["https://portal.example", "https://cdn.example:8443"]);
    expect(save(["https://portal.example", "https://portal.example:443"]).success).toBe(false);
    expect(save(["https://portal.example", "HTTPS://PORTAL.EXAMPLE"]).success).toBe(false);
  });
});
