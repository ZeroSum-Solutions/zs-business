// inbox-home.md H-1: after a stale save the dialog keeps the owner's edits and takes every
// other field from the deal someone else saved, so a second save cannot overwrite their change.
import { describe, expect, it } from "vitest";
import { initialForm, rebaseForm, type DetailsForm } from "../src/components/customers/deal-details-dialog";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";

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

// business-profile.md BP-8: a deal with no value starts at the business's currency; one with a
// value keeps the currency it was saved in, even when the business changed its own since.
describe("initialForm currency", () => {
  const deals = () => createDemoAdapter().listDeals().then((page) => page.items);

  it("starts a deal with no value at the profile's currency, and at US dollars when it is not known", async () => {
    const empty = (await deals()).find((deal) => deal.value === null)!;
    expect(initialForm(empty, "EUR").currency).toBe("EUR");
    expect(initialForm(empty).currency).toBe("USD");
  });

  it("shows the stored currency of a deal that has a value", async () => {
    const priced = (await deals()).find((deal) => deal.value !== null)!;
    expect(initialForm(priced, "EUR").currency).toBe(priced.value!.currency);
    expect(priced.value!.currency).toBe("USD");
  });
});
