// business-profile.md BP-2, BP-3, BP-6: the Settings form turns what a person types into the
// `changes` a save sends: only what changed, a phone in E.164, an address all or nothing.
import { describe, expect, it } from "vitest";
import type { BusinessProfile } from "@zs/contracts";
import { countryChoices, factProvenance, fieldFromIssuePath, newerProfile, readBusinessForm, toBusinessForm } from "../src/lib/business-profile";

const profile = (change: Partial<BusinessProfile> = {}): BusinessProfile => ({
  displayName: "Halden & Rowe", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null,
  description: null, services: [], hours: null, tone: null, policies: [], factMarks: {}, revision: 1, updatedAt: "2026-10-23T10:00:00.000Z", ...change,
});
const address = { line1: "12 Mill Lane", city: "Leeds", country: "GB" } as const;

describe("toBusinessForm", () => {
  it("shows nothing for what the profile does not have", () => {
    expect(toBusinessForm(profile())).toEqual({
      displayName: "Halden & Rowe", legalName: "", phone: "", timeZone: "", currency: "USD",
      line1: "", line2: "", city: "", region: "", postalCode: "", country: "", description: "", services: "",
      hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [day, { isOpen: false, open: "", close: "" }])),
      tone: "", policies: [],
    });
  });

  it("spreads the address over its fields", () => {
    const form = toBusinessForm(profile({ postalAddress: { ...address, line2: "Unit 4", postalCode: "LS1 4AB" } }));
    expect(form).toMatchObject({ line1: "12 Mill Lane", line2: "Unit 4", city: "Leeds", region: "", postalCode: "LS1 4AB", country: "GB" });
  });
});

describe("description and services (BP-13, BP-14)", () => {
  it("shows the services one per line", () => {
    const form = toBusinessForm(profile({ description: "Jewellers since 1952.", services: ["Repairs", "Bridal consultation"] }));
    expect(form).toMatchObject({ description: "Jewellers since 1952.", services: "Repairs\nBridal consultation" });
  });

  it("sends the description trimmed, and null when it is emptied", () => {
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), description: "  Jewellers.  " })).toEqual({ ok: true, changes: { description: "Jewellers." } });
    const saved = profile({ description: "Jewellers." });
    expect(readBusinessForm(saved, { ...toBusinessForm(saved), description: "  " })).toEqual({ ok: true, changes: { description: null } });
  });

  it("refuses a description over 2000 characters", () => {
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), description: "x".repeat(2001) })).toMatchObject({ ok: false, errors: { description: expect.any(String) } });
  });

  it("sends the services as a list: trimmed, blank lines dropped, [] when emptied", () => {
    const form = { ...toBusinessForm(profile()), services: " Repairs \n\r\n Bridal consultation\n" };
    expect(readBusinessForm(profile(), form)).toEqual({ ok: true, changes: { services: ["Repairs", "Bridal consultation"] } });
    const saved = profile({ services: ["Repairs"] });
    expect(readBusinessForm(saved, { ...toBusinessForm(saved), services: "" })).toEqual({ ok: true, changes: { services: [] } });
  });

  it("sends no change for the same services in the same order", () => {
    const saved = profile({ services: ["Repairs", "Resizing"] });
    expect(readBusinessForm(saved, toBusinessForm(saved))).toEqual({ ok: true, changes: {} });
  });

  it("refuses a service twice (ignoring case), too many services and a name over 80 characters", () => {
    const read = (services: string) => readBusinessForm(profile(), { ...toBusinessForm(profile()), services });
    expect(read("Repairs\nrepairs")).toMatchObject({ ok: false, errors: { services: expect.any(String) } });
    expect(read(Array.from({ length: 21 }, (_, i) => `Service ${i}`).join("\n"))).toMatchObject({ ok: false });
    expect(read("x".repeat(81))).toMatchObject({ ok: false });
    expect(read(Array.from({ length: 20 }, (_, i) => `Service ${i}`).join("\n"))).toMatchObject({ ok: true });
  });

  it("points a validation issue at the field", () => {
    expect(fieldFromIssuePath("changes.description")).toBe("description");
    expect(fieldFromIssuePath("changes.services.0")).toBe("services");
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
    const emoji = (n: number) => "😀".repeat(n);
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), displayName: emoji(120) })).toMatchObject({ ok: true });
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), displayName: emoji(121) })).toMatchObject({ ok: false });
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), legalName: emoji(200) })).toMatchObject({ ok: true });
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), legalName: emoji(201) })).toMatchObject({ ok: false });
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

describe("newerProfile", () => {
  it("keeps a cached copy that is newer than a late read", () => {
    const cached = profile({ revision: 2, displayName: "Saved" });
    expect(newerProfile(cached, profile({ revision: 1 }))).toBe(cached);
  });

  it("takes the read when it is newer, equal or there is no cache", () => {
    const incoming = profile({ revision: 3 });
    expect(newerProfile(profile({ revision: 2 }), incoming)).toBe(incoming);
    expect(newerProfile(profile({ revision: 3 }), incoming)).toBe(incoming);
    expect(newerProfile(undefined, incoming)).toBe(incoming);
  });
});

describe("company facts (BP-16..BP-20)", () => {
  const CLOSED = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
  const mark = { setBy: "a1b2c3d4-1a3f-4b5c-9d7e-000000000001", setAt: "2026-11-22T10:00:00.000Z", revision: 2 };

  it("sends the open days' hours, 00:00 closing as midnight, and null when every day is off", () => {
    const form = toBusinessForm(profile());
    form.hours.mon = { isOpen: true, open: "09:00", close: "17:30" };
    form.hours.sat = { isOpen: true, open: "18:00", close: "00:00" };
    expect(readBusinessForm(profile(), form)).toEqual({ ok: true, changes: {
      hours: { ...CLOSED, mon: { open: "09:00", close: "17:30" }, sat: { open: "18:00", close: "24:00" } },
    } });
    const saved = profile({ hours: { ...CLOSED, sat: { open: "18:00", close: "24:00" } } });
    const shown = toBusinessForm(saved);
    expect(shown.hours.sat).toEqual({ isOpen: true, open: "18:00", close: "00:00" });
    expect(readBusinessForm(saved, shown)).toEqual({ ok: true, changes: {} });
    shown.hours.sat = { ...shown.hours.sat, isOpen: false };
    expect(readBusinessForm(saved, shown)).toEqual({ ok: true, changes: { hours: null } });
  });

  it("refuses an open day with a missing time or a closing time before the opening time", () => {
    const form = toBusinessForm(profile());
    form.hours.tue = { isOpen: true, open: "10:00", close: "" };
    expect(readBusinessForm(profile(), form)).toMatchObject({ ok: false, errors: { hours: expect.any(String) } });
    form.hours.tue = { isOpen: true, open: "17:00", close: "09:00" };
    expect(readBusinessForm(profile(), form)).toMatchObject({ ok: false, errors: { hours: expect.any(String) } });
  });

  it("sends the tone trimmed, null when emptied, and refuses one over 500 characters", () => {
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), tone: "  Warm.  " })).toEqual({ ok: true, changes: { tone: "Warm." } });
    const saved = profile({ tone: "Warm." });
    expect(readBusinessForm(saved, { ...toBusinessForm(saved), tone: "" })).toEqual({ ok: true, changes: { tone: null } });
    expect(readBusinessForm(profile(), { ...toBusinessForm(profile()), tone: "x".repeat(501) })).toMatchObject({ ok: false, errors: { tone: expect.any(String) } });
  });

  it("sends the policies trimmed with empty rows dropped, and nothing when they did not change", () => {
    const form = { ...toBusinessForm(profile()), policies: [{ title: " Refunds ", text: " Within 14 days. " }, { title: "", text: " " }] };
    expect(readBusinessForm(profile(), form)).toEqual({ ok: true, changes: { policies: [{ title: "Refunds", text: "Within 14 days." }] } });
    const saved = profile({ policies: [{ title: "Refunds", text: "Within 14 days.", ...mark }] });
    expect(readBusinessForm(saved, toBusinessForm(saved))).toEqual({ ok: true, changes: {} });
    expect(readBusinessForm(saved, { ...toBusinessForm(saved), policies: [] })).toEqual({ ok: true, changes: { policies: [] } });
  });

  it("refuses a policy without a title or text, a title twice, a two-line title and more than 10", () => {
    const read = (policies: { title: string; text: string }[]) => readBusinessForm(profile(), { ...toBusinessForm(profile()), policies });
    expect(read([{ title: "Refunds", text: "" }])).toMatchObject({ ok: false, errors: { policies: expect.any(String) } });
    expect(read([{ title: "Refunds", text: "a" }, { title: "refunds", text: "b" }])).toMatchObject({ ok: false });
    expect(read([{ title: "Re\nfunds", text: "a" }])).toMatchObject({ ok: false });
    expect(read(Array.from({ length: 11 }, (_, i) => ({ title: `P${i}`, text: "a" })))).toMatchObject({ ok: false });
  });

  it("reads who set a fact, and a fact nobody set as not known", () => {
    expect(factProvenance(profile(), "hours")).toEqual({ known: false });
    expect(factProvenance(profile(), "policies")).toEqual({ known: false });
    expect(factProvenance(profile({ tone: "Warm." }), "tone")).toEqual({ known: true, mark: null });
    expect(factProvenance(profile({ tone: "Warm.", factMarks: { tone: mark } }), "tone")).toEqual({ known: true, mark: { setBy: mark.setBy, setAt: mark.setAt } });
  });

  it("maps the API's issue paths for the facts to their fields", () => {
    expect(fieldFromIssuePath("changes.hours.mon.close")).toBe("hours");
    expect(fieldFromIssuePath("changes.tone")).toBe("tone");
    expect(fieldFromIssuePath("changes.policies.0.title")).toBe("policies");
  });
});
