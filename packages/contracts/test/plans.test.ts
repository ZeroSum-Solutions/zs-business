import { describe, expect, it } from "vitest";
import {
  ALL_PLAN_PRICE_KEYS, billingPlanSchema, EXTRA_CONNECTION_PRICE, MAX_EXTRA_CONNECTIONS, PLAN_ADDON_LOOKUP_KEY, PLAN_CATALOG, PLAN_FEATURES, planFeatures, planFeatureSchema,
  planFeatureSwitch, planGrantSchema, type HubPlan,
} from "../src/index.js";

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

// plans.md PL-22: GET /v1/billing/plan with and without the operator-granted plan. The dashboard and the API deploy separately.
describe("billingPlanSchema grant (plans.md PL-22)", () => {
  const read = {
    billingProvider: "stripe", status: "trialing", plan: "solo", interval: "month", founding: false, foundingInvite: false,
    extraConnections: 0, trialEnd: "2026-11-20T00:00:00.000Z", currentPeriodEnd: "2026-11-20T00:00:00.000Z", cancelAtPeriodEnd: false,
    trialAvailable: false, trialDays: 0, paymentFailedAt: null, readOnlyAfter: null, readOnly: false,
    limits: { ...PLAN_CATALOG.solo.limits },
    catalog: Object.values(PLAN_CATALOG).map((entry) => ({ plan: entry.plan, name: entry.name, prices: { ...entry.prices }, foundingPrices: null, limits: { ...entry.limits } })),
    extraConnectionPrice: EXTRA_CONNECTION_PRICE, currency: "usd", checkoutEnabled: true, portalEnabled: true, shopifyManageUrl: null,
  };

  it("parses a read without the grant key, as an API that has none to report sends it", () => {
    const parsed = billingPlanSchema.parse(read);
    expect("grant" in parsed).toBe(false);
  });

  it("parses a read with a grant that ends and one that does not", () => {
    const grant = { source: "grant", plan: "pro", grantedUntil: "2027-01-31T23:59:59.000Z" };
    expect(billingPlanSchema.parse({ ...read, grant }).grant).toEqual(grant);
    expect(billingPlanSchema.parse({ ...read, grant: { ...grant, grantedUntil: null } }).grant).toEqual({ ...grant, grantedUntil: null });
  });

  it("refuses a grant that names another source or plan, a date that is not an instant, or a field the note would leak through", () => {
    const grant = { source: "grant", plan: "pro", grantedUntil: null };
    expect(planGrantSchema.safeParse(grant).success).toBe(true);
    for (const bad of [
      { ...grant, source: "stripe" }, { ...grant, plan: "enterprise" }, { ...grant, grantedUntil: "2027-01-31" },
      { ...grant, note: "retainer" }, { ...grant, grantedBy: "Dana" }, { source: "grant", plan: "pro" },
    ]) expect(billingPlanSchema.safeParse({ ...read, grant: bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

// plans.md PL-26: a plan names a feature as included only while its agent switch is on.
describe("planFeatures (PL-26)", () => {
  const allOn = { appointment_reminder: "on", review_request: "on", inquiry_followup: "on", voice_receptionist: "on" } as const;
  const allOff = { appointment_reminder: "disabled", review_request: "disabled", inquiry_followup: "disabled", voice_receptionist: "disabled" } as const;

  it("lists a switched-on feature as included and a switched-off one as off with its reason", () => {
    const features = planFeatures(PLAN_CATALOG.studio.limits, { ...allOn, review_request: "disabled", inquiry_followup: "stopped", appointment_reminder: "paused" });
    expect(features).toEqual([
      { kind: "appointment_reminder", label: "Appointment reminders", state: "off", offReason: "paused" },
      { kind: "review_request", label: "Review requests", state: "off", offReason: "disabled" },
      { kind: "inquiry_followup", label: "Agents that draft with AI", state: "off", offReason: "stopped" },
    ]);
    expect(planFeatures(PLAN_CATALOG.studio.limits, allOn).every((feature) => feature.state === "included" && feature.offReason === null)).toBe(true);
    expect(planFeatures(PLAN_CATALOG.studio.limits, allOff).some((feature) => feature.state === "included")).toBe(false);
  });

  it("never lists a kind without a runner as included, and lets a read-only plan override the switches", () => {
    const voice = planFeatures(PLAN_CATALOG.pro.limits, allOn).find((feature) => feature.kind === "voice_receptionist");
    expect(voice).toEqual({ kind: "voice_receptionist", label: "Voice and missed-call text back", state: "off", offReason: "coming" });
    const readOnly = planFeatures(PLAN_CATALOG.studio.limits, { appointment_reminder: "read_only", review_request: "read_only", inquiry_followup: "read_only", voice_receptionist: "read_only" });
    expect(readOnly.every((feature) => feature.state === "off" && feature.offReason === "read_only")).toBe(true);
  });

  it("names only what the plan's limits hold, from the same entitlements the catalog sells", () => {
    const kinds = (plan: HubPlan) => planFeatures(PLAN_CATALOG[plan].limits, allOn).map((feature) => feature.kind);
    expect(kinds("solo")).toEqual(["appointment_reminder", "review_request"]);
    expect(kinds("studio")).toEqual(["appointment_reminder", "review_request", "inquiry_followup"]);
    expect(kinds("pro")).toEqual(["appointment_reminder", "review_request", "inquiry_followup", "voice_receptionist"]);
    // A comped tenant has no limits and holds every feature.
    expect(planFeatures(null, allOn)).toHaveLength(PLAN_FEATURES.length);
    // A change to the limits changes the copy: the AI line follows `modelAgents`, the voice line `voice`.
    expect(planFeatures({ ...PLAN_CATALOG.pro.limits, voice: false }, allOn).map((feature) => feature.kind)).not.toContain("voice_receptionist");
    expect(planFeatures({ ...PLAN_CATALOG.pro.limits, modelAgents: false }, allOn).map((feature) => feature.kind)).not.toContain("inquiry_followup");
  });

  it("orders the switch like the runners do: support's pause, then the tenant's off setting, then its kill switch", () => {
    expect(planFeatureSwitch({ paused: true, enabled: false, killed: true })).toBe("paused");
    expect(planFeatureSwitch({ paused: false, enabled: false, killed: true })).toBe("disabled");
    expect(planFeatureSwitch({ paused: false, enabled: true, killed: true })).toBe("stopped");
    expect(planFeatureSwitch({ paused: false, enabled: true, killed: false })).toBe("on");
  });

  it("accepts only the four feature kinds", () => {
    expect(planFeatureSchema.safeParse({ kind: "voice_receptionist", label: "x", state: "off", offReason: "disabled" }).success).toBe(true);
    expect(planFeatureSchema.safeParse({ kind: "document_intake", label: "x", state: "included", offReason: null }).success).toBe(false);
  });
});
