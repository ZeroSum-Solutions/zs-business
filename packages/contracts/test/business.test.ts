import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_CURRENCY_CODES,
  COUNTRY_CODES,
  CURRENCIES,
  CURRENCY_CODES,
  WITHDRAWN_CURRENCY_CODES,
  currencyCodeSchema,
  currencyLabel,
  isActiveCurrencyCode,
  isCurrencyCode,
  permissionSchema,
  roleCan,
  updateBusinessProfileCommandSchema,
  updateBusinessProfileRequestSchema,
  businessProfileReadSchema,
  businessProfileSchema,
} from "../src/index.js";

// business-profile.md BP-2, BP-4, BP-6 as contracts.

const issuePaths = (input: unknown) => {
  const result = updateBusinessProfileRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("the pinned currency list (BP-4)", () => {
  it("names every code once, in order, with the label BP-8 shows", () => {
    expect(CURRENCIES.map((currency) => currency.code)).toEqual(CURRENCY_CODES);
    expect([...CURRENCY_CODES]).toEqual([...CURRENCY_CODES].sort());
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
    expect(CURRENCIES.every((currency) => /^[A-Z]{3}$/.test(currency.code) && currency.name.length > 0)).toBe(true);
    expect(currencyLabel("EUR")).toBe("EUR · Euro");
    expect(currencyLabel("XXZ")).toBe("XXZ");
  });

  it("accepts circulating codes and refuses fund, metal, test and unknown ones", () => {
    for (const code of ["USD", "EUR", "GBP", "JPY", "XOF"]) expect(isCurrencyCode(code)).toBe(true);
    for (const code of ["XXZ", "XAU", "XTS", "XXX", "usd", "US", ""]) expect(currencyCodeSchema.safeParse(code).success).toBe(false);
  });

  it("is the list the deal-currency migration checks", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261022520000_deal_currency_iso.sql", import.meta.url), "utf8");
    const checked = [...sql.matchAll(/'([A-Z]{3})'/g)].map((match) => match[1]);
    expect(CURRENCY_CODES.every((code) => checked.includes(code))).toBe(true);
  });

  it("is the list the business profile migration checks", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261023100000_business_profiles.sql", import.meta.url), "utf8");
    const start = sql.indexOf("business_profiles_currency");
    const checked = [...sql.slice(start, sql.indexOf(";", start)).matchAll(/'([A-Z]{3})'/g)].map((match) => match[1]);
    expect(checked).toEqual([...ACTIVE_CURRENCY_CODES]);
  });

  it("keeps the migration's country list in step with COUNTRY_CODES", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261023100000_business_profiles.sql", import.meta.url), "utf8");
    const start = sql.indexOf("postal_address->>'country' IN (");
    const checked = [...sql.slice(start, sql.indexOf("), false)", start)).matchAll(/'([A-Z]{2})'/g)].map((match) => match[1]);
    expect(checked).toEqual([...COUNTRY_CODES]);
  });

  it("keeps withdrawn codes readable for deals but never accepts them for a business (BP-4)", () => {
    expect(WITHDRAWN_CURRENCY_CODES.every((code) => CURRENCY_CODES.includes(code))).toBe(true);
    for (const code of ["CUC", "HRK", "SLL", "ZWL"]) {
      expect(currencyCodeSchema.safeParse(code).success).toBe(true);
      expect(isActiveCurrencyCode(code)).toBe(false);
      expect(updateBusinessProfileRequestSchema.safeParse({ expectedRevision: 1, changes: { currency: code } }).success).toBe(false);
    }
    expect(ACTIVE_CURRENCY_CODES).toHaveLength(CURRENCY_CODES.length - WITHDRAWN_CURRENCY_CODES.length);
    expect(updateBusinessProfileRequestSchema.safeParse({ expectedRevision: 1, changes: { currency: "EUR" } }).success).toBe(true);
  });
});

describe("the business permission (BP-6)", () => {
  it("is named, and only owners hold it", () => {
    expect(permissionSchema.options).toContain("business");
    expect(roleCan("owner", "business")).toBe(true);
    expect(roleCan("staff", "business")).toBe(false);
  });
});

describe("country codes (BP-2)", () => {
  it("lists the 249 ISO 3166-1 alpha-2 codes", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const code of ["US", "GB", "DE", "AX"]) expect(COUNTRY_CODES).toContain(code);
  });
});

describe("the update request (BP-2, BP-6)", () => {
  const request = (changes: Record<string, unknown>) => ({ expectedRevision: 1, changes });

  it("takes any subset of the fields, null clearing the ones that may be cleared", () => {
    const ok = updateBusinessProfileRequestSchema.parse(request({
      displayName: "  Halden & Rowe  ", legalName: null, phoneE164: "+14155550123", timeZone: "Europe/London", currency: "EUR",
      postalAddress: { line1: "1 High St", city: "London", country: "GB" },
    }));
    expect(ok.changes.displayName).toBe("Halden & Rowe");
    expect(updateBusinessProfileRequestSchema.safeParse(request({ timeZone: null, postalAddress: null, phoneE164: null })).success).toBe(true);
  });

  it("refuses an empty change set and unknown keys", () => {
    expect(issuePaths(request({}))).toEqual(["changes"]);
    expect(updateBusinessProfileRequestSchema.safeParse(request({ revision: 3 })).success).toBe(false);
    expect(updateBusinessProfileRequestSchema.safeParse({ expectedRevision: 1, changes: { currency: "EUR" }, extra: 1 }).success).toBe(false);
    expect(updateBusinessProfileRequestSchema.safeParse({ changes: { currency: "EUR" } }).success).toBe(false);
  });

  it("names the field's path for a bad time zone or currency", () => {
    expect(issuePaths(request({ timeZone: "Mars/Base" }))).toEqual(["changes.timeZone"]);
    expect(issuePaths(request({ currency: "XXZ" }))).toEqual(["changes.currency"]);
    expect(issuePaths(request({ timeZone: "Mars/Base", currency: "XXZ" })).sort()).toEqual(["changes.currency", "changes.timeZone"]);
  });

  it("never clears the display name or the currency", () => {
    expect(issuePaths(request({ displayName: null }))).toEqual(["changes.displayName"]);
    expect(issuePaths(request({ currency: null }))).toEqual(["changes.currency"]);
    expect(issuePaths(request({ displayName: "   " }))).toEqual(["changes.displayName"]);
    expect(issuePaths(request({ displayName: "x".repeat(121) }))).toEqual(["changes.displayName"]);
  });

  it("checks the legal name, phone and Postgres text", () => {
    expect(issuePaths(request({ legalName: "y".repeat(201) }))).toEqual(["changes.legalName"]);
    expect(issuePaths(request({ legalName: "a\u0000b" }))).toEqual(["changes.legalName"]);
    expect(issuePaths(request({ legalName: "a\uD800b" }))).toEqual(["changes.legalName"]);
    for (const phone of ["4155550123", "+1415555", "+1234567890123456", "+1 415 555 0123", "+1415555012x"]) {
      expect(issuePaths(request({ phoneE164: phone })), phone).toEqual(["changes.phoneE164"]);
    }
    for (const phone of ["+12345678", "+123456789012345"]) expect(issuePaths(request({ phoneE164: phone })), phone).toEqual([]);
  });

  it("checks the postal address shape and its country", () => {
    const address = { line1: "1 High St", city: "London", country: "GB" };
    expect(issuePaths(request({ postalAddress: { ...address, line2: "Floor 2", region: "Greater London", postalCode: "N1 9GU" } }))).toEqual([]);
    expect(issuePaths(request({ postalAddress: { ...address, country: "UK" } }))).toEqual(["changes.postalAddress.country"]);
    expect(issuePaths(request({ postalAddress: { ...address, country: "gb" } }))).toEqual(["changes.postalAddress.country"]);
    expect(issuePaths(request({ postalAddress: { line1: "1 High St", country: "GB" } }))).toEqual(["changes.postalAddress.city"]);
    expect(issuePaths(request({ postalAddress: { ...address, line1: "" } }))).toEqual(["changes.postalAddress.line1"]);
    expect(issuePaths(request({ postalAddress: { ...address, line2: null } }))).toEqual(["changes.postalAddress.line2"]);
    expect(issuePaths(request({ postalAddress: { ...address, extra: "x" } }))).toEqual(["changes.postalAddress"]);
  });

  it("is the payload of a command that targets the tenant's own profile", () => {
    const tenantId = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
    const command = {
      idempotencyKey: "k1", actionType: "business.profile.update", target: { tenantId, type: "business_profile", id: tenantId },
      payload: request({ currency: "EUR" }),
      approvalReference: { tenantId, id: tenantId },
    };
    expect(updateBusinessProfileCommandSchema.safeParse(command).success).toBe(true);
    const other = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a71";
    expect(updateBusinessProfileCommandSchema.safeParse({ ...command, target: { tenantId, type: "business_profile", id: other } }).success).toBe(false);
  });
});

describe("the profile record (BP-5)", () => {
  it("carries the values and the revision, and nothing else about the tenant", () => {
    const profile = {
      displayName: "Halden & Rowe", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null,
      revision: 1, updatedAt: "2026-10-23T08:00:00.000Z",
    };
    expect(businessProfileSchema.parse(profile)).toEqual(profile);
    expect(businessProfileSchema.safeParse({ ...profile, tenantId: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70" }).success).toBe(false);
  });

  it("is read tolerantly by a client: a newer API's extra keys, even inside the address, are dropped", () => {
    const newer = {
      displayName: "Halden & Rowe", legalName: null, phoneE164: null, timeZone: null, currency: "USD",
      postalAddress: { line1: "1 High St", city: "London", country: "GB", deliveryInstructions: "Ring twice" },
      revision: 1, updatedAt: "2026-10-23T08:00:00.000Z", logoUrl: "https://example.com/logo.png",
    };
    const read = businessProfileReadSchema.parse(newer);
    expect(read.postalAddress).toEqual({ line1: "1 High St", city: "London", country: "GB" });
    expect(read).not.toHaveProperty("logoUrl");
  });
});
