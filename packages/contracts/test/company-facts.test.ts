// Company facts (docs/requirements/business-profile.md BP-16..BP-21): the shapes of hours, tone and
// policies, and the prompt form where a missing fact reads "not known".
import { describe, expect, it } from "vitest";
import {
  businessHoursSchema,
  businessProfileChangesSchema,
  businessProfileReadSchema,
  companyFactsForPrompt,
  companyFactsPromptSchema,
  NOT_KNOWN,
  type BusinessHours,
  type CompanyFacts,
} from "../src/index.js";

const HOURS: BusinessHours = {
  mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" }, wed: null, thu: { open: "09:00", close: "24:00" },
  fri: { open: "09:00", close: "17:00" }, sat: null, sun: null,
};
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.path.join("."));

describe("opening hours (BP-16)", () => {
  it("takes all seven days, closed days as null, and 24:00 as midnight", () => {
    expect(businessHoursSchema.parse(HOURS)).toEqual(HOURS);
  });

  it("refuses a closing time before the opening time, a missing day, an unknown day, bad times, and a week with no open day", () => {
    expect(issuePaths(businessHoursSchema.safeParse({ ...HOURS, mon: { open: "17:00", close: "09:00" } }))).toEqual(["mon.close"]);
    expect(issuePaths(businessHoursSchema.safeParse({ ...HOURS, mon: { open: "09:00", close: "09:00" } }))).toEqual(["mon.close"]);
    const { sun: _sun, ...sixDays } = HOURS;
    expect(businessHoursSchema.safeParse(sixDays).success).toBe(false);
    expect(businessHoursSchema.safeParse({ ...HOURS, hol: null }).success).toBe(false);
    for (const open of ["9:00", "24:00", "09:60", "0900"]) {
      expect(businessHoursSchema.safeParse({ ...HOURS, mon: { open, close: "23:00" } }).success).toBe(false);
    }
    const closed = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
    expect(businessHoursSchema.safeParse(closed).success).toBe(false);
  });
});

describe("tone and policies in a save (BP-17, BP-18)", () => {
  it("trims the tone and the policies, and null clears the tone", () => {
    expect(businessProfileChangesSchema.parse({ tone: "  Warm.  ", policies: [{ title: " Refunds ", text: " Ten days. " }] }))
      .toEqual({ tone: "Warm.", policies: [{ title: "Refunds", text: "Ten days." }] });
    expect(businessProfileChangesSchema.parse({ tone: null })).toEqual({ tone: null });
  });

  it("refuses a blank or long tone, duplicate titles ignoring case, an 11th policy, a two-line title and a mark sent by the client", () => {
    expect(issuePaths(businessProfileChangesSchema.safeParse({ tone: "  " }))).toEqual(["tone"]);
    expect(businessProfileChangesSchema.safeParse({ tone: "x".repeat(501) }).success).toBe(false);
    expect(businessProfileChangesSchema.safeParse({ tone: "x".repeat(500) }).success).toBe(true);
    expect(issuePaths(businessProfileChangesSchema.safeParse({ policies: [{ title: "Refunds", text: "A" }, { title: "REFUNDS", text: "B" }] })))
      .toEqual(["policies"]);
    expect(businessProfileChangesSchema.safeParse({ policies: Array.from({ length: 11 }, (_, i) => ({ title: `P${i}`, text: "T" })) }).success).toBe(false);
    expect(businessProfileChangesSchema.safeParse({ policies: [{ title: "A\nB", text: "T" }] }).success).toBe(false);
    expect(businessProfileChangesSchema.safeParse({ policies: [{ title: "x".repeat(61), text: "T" }] }).success).toBe(false);
    expect(businessProfileChangesSchema.safeParse({ policies: [{ title: "A", text: "x".repeat(1001) }] }).success).toBe(false);
    expect(businessProfileChangesSchema.safeParse({ policies: [{ title: "A", text: "T", setBy: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70" }] }).success).toBe(false);
  });

  it("is read tolerantly when an older API sends none of the facts (BP-21)", () => {
    const older = { displayName: "A", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null, revision: 1, updatedAt: "2026-10-23T08:00:00.000Z" };
    const read = businessProfileReadSchema.parse(older);
    expect(read.hours).toBeUndefined();
    expect(read.policies).toBeUndefined();
  });
});

describe("the prompt form (BP-21)", () => {
  const mark = { setBy: "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70", setAt: "2026-11-22T09:00:00.000Z" };
  const missing = { status: "not_known" } as const;

  it("says 'not known' for every missing fact, never a guess", () => {
    const facts: CompanyFacts = {
      name: { status: "known", value: "Halden", setBy: null, setAt: null },
      description: missing, services: missing, timeZone: missing, hours: missing, tone: missing, policies: missing,
    };
    const prompt = companyFactsForPrompt(facts);
    expect(prompt).toEqual({
      name: "Halden", description: NOT_KNOWN, services: NOT_KNOWN, timeZone: NOT_KNOWN, hours: NOT_KNOWN, tone: NOT_KNOWN, policies: NOT_KNOWN,
    });
    expect(companyFactsPromptSchema.parse(prompt)).toEqual(prompt);
  });

  it("renders hours per day as a range or closed, and drops provenance from the prompt", () => {
    const facts: CompanyFacts = {
      name: { status: "known", value: "Halden", ...mark },
      description: { status: "known", value: "Jewelry.", ...mark },
      services: { status: "known", value: ["Repairs"], ...mark },
      timeZone: { status: "known", value: "Europe/London", ...mark },
      hours: { status: "known", value: HOURS, ...mark },
      tone: { status: "known", value: "Warm.", ...mark },
      policies: { status: "known", value: [{ title: "Refunds", text: "Ten days.", ...mark, revision: 2 }] },
    };
    const prompt = companyFactsForPrompt(facts);
    expect(prompt.hours).toEqual({ mon: "09:00-17:00", tue: "09:00-17:00", wed: "closed", thu: "09:00-24:00", fri: "09:00-17:00", sat: "closed", sun: "closed" });
    expect(prompt.policies).toEqual([{ title: "Refunds", text: "Ten days." }]);
    expect(JSON.stringify(prompt)).not.toContain(mark.setBy);
    expect(companyFactsPromptSchema.parse(prompt)).toEqual(prompt);
  });
});
