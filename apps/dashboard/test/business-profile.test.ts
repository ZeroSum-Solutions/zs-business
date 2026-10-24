// business-profile.md BP-2, BP-3, BP-6: the Settings form turns what a person types into the
// `changes` a save sends: only what changed, a phone in E.164, an address all or nothing.
import { describe, expect, it } from "vitest";
import type { BusinessProfile } from "@zs/contracts";
import { countryChoices, fieldFromIssuePath, readBusinessForm, toBusinessForm } from "../src/lib/business-profile";

const profile = (change: Partial<BusinessProfile> = {}): BusinessProfile => ({
  displayName: "Halden & Rowe", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null,
  revision: 1, updatedAt: "2026-10-23T10:00:00.000Z", ...change,
});
const address = { line1: "12 Mill Lane", city: "Leeds", country: "GB" } as const;

describe("toBusinessForm", () => {
  it("shows nothing for what the profile does not have", () => {
    expect(toBusinessForm(profile())).toEqual({
      displayName: "Halden & Rowe", legalName: "", phone: "", timeZone: "", currency: "USD",
      line1: "", line2: "", city: "", region: "", postalCode: "", country: "",
    });
  });

  it("spreads the address over its fields", () => {
    const form = toBusinessForm(profile({ postalAddress: { ...address, line2: "Unit 4", postalCode: "LS1 4AB" } }));
    expect(form).toMatchObject({ line1: "12 Mill Lane", line2: "Unit 4", city: "Leeds", region: "", postalCode: "LS1 4AB", country: "GB" });
  });
});

describe("readBusinessForm", () => {
  it("sends no change when nothing was edited", () => {
    const saved = profile({ legalName: "Halden & Rowe Ltd", phoneE164: "+442079460000", timeZone: "Europe/London", postalAddress: address });
    expect(readBusinessForm(saved, toBusinessForm(saved))).toEqual({ ok: true, changes: {} });
  });

  it("sends only the fields that differ", () => {
    const form = { ...toBusinessForm(profile()), legalName: " Halden & Rowe Ltd ", timeZone: "Europe/London", currency: "EUR" };
    expect(readBusinessForm(profile(), form)).toEqual({ ok: true, changes: { legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR" } });
  });

  it("clears an optional field with null", () => {
    const saved = profile({ legalName: "Halden & Rowe Ltd", phoneE164: "+442079460000", timeZone: "Europe/London", postalAddress: address });
    const form = { ...toBusinessForm(saved), legalName: " ", phone: "", timeZone: "", line1: "", city: "", country: "" };
    expect(readBusinessForm(saved, form)).toEqual({ ok: true, changes: { legalName: null, phoneE164: null, timeZone: null, postalAddress: null } });
  });

  it("never clears a saved phone number because the field holds only punctuation", () => {
    const saved = profile({ phoneE164: "+442079460000" });
    for (const typed of ["---", "( )", " . "]) {
      const read = readBusinessForm(saved, { ...toBusinessForm(saved), phone: typed });
      expect(read.ok, typed).toBe(false);
    }
    expect(readBusinessForm(saved, { ...toBusinessForm(saved), phone: "  " })).toEqual({ ok: true, changes: { phoneE164: null } });
  });

  it("turns a typed phone number into E.164", () => {
    const form = { ...toBusinessForm(profile()), phone: "+44 (20) 7946-0000" };
    expect(readBusinessForm(profile(), form)).toEqual({ ok: true, changes: { phoneE164: "+442079460000" } });
  });

  it("names the phone field when the number has no country code", () => {
    const form = { ...toBusinessForm(profile()), phone: "020 7946 0000" };
    expect(readBusinessForm(profile(), form)).toMatchObject({ ok: false, errors: { phone: expect.stringContaining("country code") } });
  });

  it("does not let the business name be empty or too long", () => {
    for (const displayName of ["  ", "x".repeat(121)]) {
      expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), displayName })).toMatchObject({ ok: false, errors: { displayName: expect.any(String) } });
    }
  });

  it("builds an address with only the lines that were filled in", () => {
    const form = { ...toBusinessForm(profile()), line1: "12 Mill Lane ", city: "Leeds", country: "GB", postalCode: "LS1 4AB" };
    expect(readBusinessForm(profile(), form)).toEqual({
      ok: true, changes: { postalAddress: { line1: "12 Mill Lane", city: "Leeds", postalCode: "LS1 4AB", country: "GB" } },
    });
  });

  it("asks for street, city and country once any address field is filled", () => {
    const form = { ...toBusinessForm(profile()), postalCode: "LS1 4AB" };
    const read = readBusinessForm(profile(), form);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors).sort()).toEqual(["city", "country", "line1"]);
  });

  it("leaves an unchanged address out even when its optional lines are typed with spaces", () => {
    const saved = profile({ postalAddress: { ...address, region: "West Yorkshire" } });
    const form = { ...toBusinessForm(saved), region: " West Yorkshire " };
    expect(readBusinessForm(saved, form)).toEqual({ ok: true, changes: {} });
  });
});

describe("fieldFromIssuePath", () => {
  it("maps the API's issue paths to form fields", () => {
    expect(fieldFromIssuePath("changes.timeZone")).toBe("timeZone");
    expect(fieldFromIssuePath("changes.currency")).toBe("currency");
    expect(fieldFromIssuePath("changes.phoneE164")).toBe("phone");
    expect(fieldFromIssuePath("changes.postalAddress.city")).toBe("city");
    expect(fieldFromIssuePath("changes.postalAddress")).toBe("line1");
    expect(fieldFromIssuePath("expectedRevision")).toBeNull();
  });
});

describe("countryChoices", () => {
  it("lists every country the contract accepts, by English name", () => {
    const choices = countryChoices();
    expect(choices.find((choice) => choice.code === "GB")?.name).toMatch(/United Kingdom/);
    expect(choices.every((choice, index) => index === 0 || choices[index - 1]!.name.localeCompare(choice.name) <= 0)).toBe(true);
  });
});
