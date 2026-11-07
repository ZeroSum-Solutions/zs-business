// Devin's hard suppression (2026-11-07): a prospect list that includes Broken English or
// Rise Movement, their staff or their domains must come out without them.
import { describe, expect, it } from "vitest";
import { consentBlock, filterHardSuppressed, hardSuppressionHit } from "../../src/index.js";

const list = [
  { company: "Iron Peak Fitness", email: "owner@ironpeakfit.com", name: "Sam Lee" },
  { company: "Broken English Jewelry", email: "devin@brokenenglishjewelry.com", name: "Devin W" },
  { company: "BE Store NY", email: "ny@shop.brokenenglishjewelry.com" },
  { company: "Studio X", website: "https://www.risemovement.studio/about", email: "hello@studiox.com" },
  { company: "Rise Movement", email: "front@gmail.com" },
  { company: "Rise-Movement LLC" },
  { company: "Some Gym", email: "jason.walsh@gmail.com" },
  { company: "Some Gym 2", name: "Jason Walsh", email: "owner@somegym2.com" },
  { company: "Gem & Co", email: "office@brokenenglishjewelry.com", name: "Polina Schultz" },
  { company: "Oak Jewellers", email: "oak@oakjewellers.com" },
  { company: "Rise Fitness Group", email: "hi@risefitnessgroup.com" },
];

describe("hard suppression", () => {
  it("removes Broken English, Rise Movement and their people from a mixed list", () => {
    const { kept, removed } = filterHardSuppressed(list);
    expect(kept.map((k) => k.company)).toEqual(["Iron Peak Fitness", "Oak Jewellers", "Rise Fitness Group"]);
    expect(removed).toHaveLength(8);
    expect(removed.map((r) => r.reason).sort()).toEqual(
      ["company", "company", "domain", "domain", "domain", "person", "person", "domain"].sort());
  });

  it("matches subdomains, case, www, URLs and punctuation", () => {
    for (const email of ["A@BrokenEnglishJewelry.com", "a@mail.risemovement.studio", "a@rise-movement.com"])
      expect(hardSuppressionHit({ email })).toBe("domain");
    expect(hardSuppressionHit({ website: "HTTPS://WWW.RiseMovement.studio/x?y=1" })).toBe("domain");
    expect(hardSuppressionHit({ company: "  broken-english  " })).toBe("company");
    expect(hardSuppressionHit({ company: "Oak Jewellers", email: "oak@oakjewellers.com" })).toBeNull();
  });

  it("blocks a marketing email send but not a transactional one", () => {
    const base = { channel: "email" as const, consent: "granted" as const, suppressed: false };
    expect(consentBlock({ ...base, purpose: "marketing", address: "x@brokenenglishjewelry.com" })).toBe("suppressed");
    expect(consentBlock({ ...base, purpose: "marketing", address: "x@fine.com" })).toBeNull();
    expect(consentBlock({ ...base, purpose: "transactional", address: "x@brokenenglishjewelry.com" })).toBeNull();
  });
});
