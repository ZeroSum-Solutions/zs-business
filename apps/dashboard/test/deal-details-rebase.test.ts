// inbox-home.md H-1: after a stale save the dialog keeps the owner's edits and takes every
// other field from the deal someone else saved, so a second save cannot overwrite their change.
import { describe, expect, it } from "vitest";
import { rebaseForm, type DetailsForm } from "../src/components/customers/deal-details-dialog";

const base: DetailsForm = { amount: "5200", currency: "USD", leadSource: "referral" };
const saved: DetailsForm = { amount: "5200", currency: "USD", leadSource: "phone" };

describe("rebaseForm", () => {
  it("keeps an edited value and takes the lead source someone else saved", () => {
    expect(rebaseForm(base, { ...base, amount: "6100" }, saved)).toEqual({ amount: "6100", currency: "USD", leadSource: "phone" });
  });

  it("keeps an edited lead source and takes the value someone else saved", () => {
    const theirs = { amount: "900", currency: "EUR", leadSource: "phone" };
    expect(rebaseForm(base, { ...base, leadSource: "ads" }, theirs)).toEqual({ amount: "900", currency: "EUR", leadSource: "ads" });
  });

  it("moves value and currency together", () => {
    const theirs = { amount: "900", currency: "EUR", leadSource: "referral" };
    expect(rebaseForm(base, { ...base, currency: "GBP" }, theirs)).toEqual({ amount: "5200", currency: "GBP", leadSource: "referral" });
  });

  it("takes everything from the saved deal when nothing was edited", () => {
    expect(rebaseForm(base, base, saved)).toEqual(saved);
  });
});
