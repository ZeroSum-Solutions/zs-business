import { describe, expect, it } from "vitest";
import { ALL_PLAN_PRICE_KEYS, EXTRA_CONNECTION_PRICE, MAX_EXTRA_CONNECTIONS, PLAN_ADDON_LOOKUP_KEY, PLAN_CATALOG } from "../src/index.js";

// plans.md PL-1: the one catalog the API, the worker and the dashboard read. Amounts are USD cents.
describe("PLAN_CATALOG (plans.md PL-1)", () => {
  it("holds the list prices", () => {
    expect(PLAN_CATALOG.solo.prices).toEqual({ month: 4_900, year: 49_000 });
    expect(PLAN_CATALOG.studio.prices).toEqual({ month: 9_900, year: 99_000 });
    expect(PLAN_CATALOG.pro.prices).toEqual({ month: 19_900, year: 199_000 });
  });

  it("offers founding prices to Studio and Pro only", () => {
    expect(PLAN_CATALOG.solo.foundingPrices).toBeNull();
    expect(PLAN_CATALOG.studio.foundingPrices).toEqual({ month: 6_900, year: 69_000 });
    expect(PLAN_CATALOG.pro.foundingPrices).toEqual({ month: 13_900, year: 139_000 });
  });

  it("holds the limits of each plan", () => {
    expect(PLAN_CATALOG.solo.limits).toEqual({
      seats: 2, bookableResources: 1, managedConnections: 1, automationTokens: 0,
      modelAgents: false, voice: false, agentDailyCapCents: 100, emailsPerMonth: 1_000,
    });
    expect(PLAN_CATALOG.studio.limits).toEqual({
      seats: 6, bookableResources: 3, managedConnections: 3, automationTokens: 2,
      modelAgents: true, voice: false, agentDailyCapCents: 100, emailsPerMonth: 4_000,
    });
    expect(PLAN_CATALOG.pro.limits).toEqual({
      seats: 15, bookableResources: 10, managedConnections: 10, automationTokens: 10,
      modelAgents: true, voice: true, agentDailyCapCents: 300, emailsPerMonth: 15_000,
    });
  });

  it("prices the extra-connection add-on at 1,000 cents a month, up to 20 units", () => {
    expect(EXTRA_CONNECTION_PRICE).toBe(1_000);
    expect(MAX_EXTRA_CONNECTIONS).toBe(20);
  });

  it("names eleven Stripe lookup keys (PL-2, PL-13)", () => {
    expect(ALL_PLAN_PRICE_KEYS).toEqual([
      "hub_connection_month", "hub_pro_founding_month", "hub_pro_founding_year", "hub_pro_month", "hub_pro_year",
      "hub_solo_month", "hub_solo_year", "hub_studio_founding_month", "hub_studio_founding_year", "hub_studio_month", "hub_studio_year",
    ]);
    expect(ALL_PLAN_PRICE_KEYS).toContain(PLAN_ADDON_LOOKUP_KEY);
  });
});
