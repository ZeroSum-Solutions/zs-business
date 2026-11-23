// Account › Plan and Settings: dates in the viewer's zone, no promise the contracts do not keep
// (stripe.md, delivery.md D-4), and nothing in demo mode that looks saved when it was not.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { billingNotice, featureLines, grantSummary, PLAN_BADGE, planDateLine, PlanView, planFeaturesFresh, SHOPIFY_ADMIN_HINT } from "../src/components/account/plan-view";
import { BUSINESS_DEMO_NOTE, BUSINESS_NOT_AVAILABLE, BUSINESS_OWNER_ONLY, SettingsView } from "../src/components/account/settings-view";
import { ToastProvider } from "../src/components/ui/toast";
import { PLAN_CATALOG, PLAN_FEATURE_OFF_REASONS, planFeatures, type BillingPlan, type BusinessProfile } from "@zs/contracts";
import { ApiError, createApi } from "../src/lib/api";
import { DEMO_BUSINESS, DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { createDemoBilling } from "../src/lib/api/demo/billing";
import { ApiProvider } from "../src/lib/api/react";
import { PLAN_POLL_MS, PLAN_WATCH_MS, PLAN_WATCH_POLL_MS, planRefetchInterval, scopeKeys } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";

const NEAR_MIDNIGHT_UTC = "2026-11-21T03:30:00.000Z";
const base = await createDemoBilling().getBillingPlan();
const plan = (change: Partial<BillingPlan> = {}): BillingPlan => ({
  ...base, status: "active", trialEnd: null, currentPeriodEnd: NEAR_MIDNIGHT_UTC, ...change,
});

function render(node: ReactNode, mode: "demo" | "live", seed?: (client: QueryClient) => void, prepare?: (runtime: ReturnType<typeof createApi>) => void): string {
  const client = new QueryClient();
  seed?.(client);
  const runtime = createApi({ mode });
  prepare?.(runtime);
  const toasts = h(ToastProvider, { children: node });
  const tree = h(ApiProvider, {
    runtime,
    children: h(QueryClientProvider, { client, children: h(SessionProvider, { children: toasts }) }),
  });
  return renderToString(tree).replaceAll("<!-- -->", "");
}

describe("plan", () => {
  it("dates the renewal, the trial and the end in the zone it is given, not New York", () => {
    expect(planDateLine(plan(), "Pacific/Honolulu")).toBe("Renews Friday, November 20");
    expect(planDateLine(plan(), "Asia/Tokyo")).toBe("Renews Saturday, November 21");
    expect(planDateLine(plan({ cancelAtPeriodEnd: true }), "Pacific/Honolulu")).toBe("Ends Friday, November 20. Nothing more is charged.");
    expect(planDateLine(plan({ status: "trialing", trialEnd: NEAR_MIDNIGHT_UTC }), "Asia/Tokyo")).toBe("Trial ends Saturday, November 21. Your card is charged then.");
    expect(planDateLine(plan({ status: "canceled" }), "UTC")).toBeNull();
  });

  it("warns after a failed payment and says when the business is read-only (PL-8)", () => {
    expect(billingNotice(plan(), "UTC")).toBeNull();
    const failed = billingNotice(plan({ status: "past_due", paymentFailedAt: "2026-11-14T00:00:00.000Z", readOnlyAfter: NEAR_MIDNIGHT_UTC }), "Asia/Tokyo");
    expect(failed).toEqual({ tone: "warn", text: expect.stringContaining("Update your card by Saturday, November 21") });
    expect(billingNotice(plan({ status: "unpaid", readOnly: true }), "UTC")?.tone).toBe("danger");
    expect(JSON.stringify(failed)).not.toMatch(/refund/i);
  });

  // plans.md PL-27: a self-signed-up business is never told it turns read-only, and with no paid plan it sees its free allowances.
  it("tells a free-tier business it moves to the free allowances and shows them (PL-27)", () => {
    const failed = billingNotice(plan({ freeTier: true, status: "past_due", paymentFailedAt: "2026-11-14T00:00:00.000Z", readOnlyAfter: NEAR_MIDNIGHT_UTC }), "UTC");
    expect(failed?.text).toContain("the business moves to the free allowances");
    expect(failed?.text).not.toMatch(/read-only/);
    const ending = plan({ freeTier: true, status: "canceled", readOnlyAfter: NEAR_MIDNIGHT_UTC });
    expect(billingNotice(ending, "UTC", Date.parse(NEAR_MIDNIGHT_UTC) - 1)?.text).toContain("moves to the free allowances");
    expect(billingNotice(ending, "UTC", Date.parse(NEAR_MIDNIGHT_UTC))).toBeNull();
    const free = plan({ freeTier: true, status: "none", plan: null, interval: null,
      limits: { ...base.catalog[0]!.limits, seats: 1, managedConnections: 1, automationTokens: 1, emailsPerMonth: 100 } });
    const html = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, free));
    expect(html).toContain("Free allowances");
    expect(html).toContain("100 emails a month");
    expect(html).toContain("Choose a plan");
  });

  // plans.md PL-22: an operator-granted plan shows "Included plan: <name>" and its end, with no checkout prompt or billing notice.
  it("shows an operator-granted plan instead of checkout prompts and billing notices (PL-22)", () => {
    const unlimited = plan({ grant: { source: "grant", plan: "pro", grantedUntil: NEAR_MIDNIGHT_UTC }, status: "none", plan: null, interval: null, limits: { ...base.catalog[2]!.limits } });
    expect(grantSummary(unlimited, "Asia/Tokyo")).toEqual({ name: "Pro", endLine: "Included until Saturday, November 21." });
    expect(grantSummary(plan({ grant: { source: "grant", plan: "studio", grantedUntil: null } }), "UTC")).toEqual({ name: "Studio", endLine: null });
    expect(grantSummary(plan(), "UTC")).toBeNull();
    const html = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, unlimited));
    expect(html).toContain("Included plan: Pro");
    // The page uses the viewer's zone (the machine's, in this render), so the day is either side of UTC midnight.
    expect(html).toMatch(/Included until (Friday, November 20|Saturday, November 21)\./);
    expect(html).not.toMatch(/Choose a plan|Choose Pro|Choose Solo|Manage billing|Fix billing|read-only/);
    // Even a stale payment failure or read-only date on the provider side shows no banner while the grant lasts.
    const failing = plan({ grant: { source: "grant", plan: "solo", grantedUntil: null }, status: "past_due", paymentFailedAt: "2026-11-14T00:00:00.000Z", readOnlyAfter: NEAR_MIDNIGHT_UTC });
    const noBanner = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, failing));
    expect(noBanner).toContain("Included plan: Solo");
    expect(noBanner).not.toContain("Update your card");
    // Without a grant the page is as before.
    expect(render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, base))).not.toContain("Included plan");
  });

  // plans.md PL-26: the plan page never calls a switched-off agent feature included.
  it("shows an off feature as off and a switched-on one as included (PL-26)", () => {
    const features = (...states: ("on" | "disabled" | "stopped" | "paused")[]) =>
      planFeatures(PLAN_CATALOG.studio.limits, { appointment_reminder: states[0]!, review_request: states[1]!, inquiry_followup: states[2]!, missed_call_textback: "disabled" });
    const live = features("on", "disabled", "stopped");
    expect(featureLines(live)).toEqual([
      { text: "Appointment reminders", on: true },
      { text: "Review requests: off until you turn it on", on: false },
      { text: "Agents that draft with AI: stopped", on: false },
    ]);
    expect(featureLines(features("paused", "on", "on"))[0]).toEqual({ text: "Appointment reminders: paused by support", on: false });
    // Every reason the server can give has its own plain words, and none claims the feature is live.
    const reasons = Object.fromEntries(PLAN_FEATURE_OFF_REASONS.map((reason) => [reason,
      featureLines(planFeatures(PLAN_CATALOG.solo.limits, { appointment_reminder: reason, review_request: "on", inquiry_followup: "on", missed_call_textback: "on" }))[0]!]));
    expect(Object.fromEntries(Object.entries(reasons).map(([reason, line]) => [reason, line.text]))).toEqual({
      read_only: "Appointment reminders: paused until the plan is paid",
      not_running: "Appointment reminders: not running right now",
      paused: "Appointment reminders: paused by support",
      disabled: "Appointment reminders: off until you turn it on",
      stopped: "Appointment reminders: stopped",
      quiet_hours: "Appointment reminders: waiting for quiet hours to end",
      no_budget: "Appointment reminders: paused, its daily AI budget is used up or set to zero",
      not_approved: "Appointment reminders: waiting for you to approve its message",
      missing_setup: "Appointment reminders: waiting for a sending number or link its message needs",
    });
    expect(Object.values(reasons).every((line) => !line.on)).toBe(true);
    // An older API sends no features: the page names none rather than guess.
    expect(featureLines(undefined)).toEqual([]);

    // An answer cached before this visit is read again on open: until it is, the page names no feature, so a stale "included" never shows.
    const cached = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, plan({ features: live })));
    expect(cached).not.toContain("Appointment reminders");
    expect(cached).not.toContain("Review requests");
    // A read after a good one that fails or waits offline leaves an answer of unknown age: it names nothing either.
    const read = { isFetchedAfterMount: true, fetchStatus: "idle" as const, isRefetchError: false };
    expect(planFeaturesFresh(read)).toBe(true);
    expect(planFeaturesFresh({ ...read, fetchStatus: "fetching" })).toBe(true);
    expect(planFeaturesFresh({ ...read, fetchStatus: "paused" })).toBe(false);
    expect(planFeaturesFresh({ ...read, isRefetchError: true })).toBe(false);
    expect(planFeaturesFresh({ ...read, isFetchedAfterMount: false, fetchStatus: "fetching" })).toBe(false);
    // A current answer (read in this visit) names them.
    const current = { updatedAt: Date.now() + 60_000 };
    const html = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, plan({ features: live }), current));
    expect(html).toMatch(/data-feature-state="included"[^>]*>.*?Appointment reminders<\/li>/);
    expect(html).toContain("Review requests: off until you turn it on");
    expect(html).toContain("Agents that draft with AI: stopped");
    expect(html).not.toMatch(/Review requests</);
    expect(html).not.toMatch(/Agents that draft with AI</);
    // The choose-a-plan cards read the same switches per offer.
    const picker = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, { ...plan({ status: "none", plan: null, limits: null }),
      catalog: base.catalog.map((offer) => ({ ...offer, features: planFeatures(offer.limits, { appointment_reminder: "on", review_request: "disabled", inquiry_followup: "disabled", missed_call_textback: "on" }) })) }, current));
    expect(picker).toMatch(/Missed-call text back<\/li>/);
    expect(picker).not.toContain("Missed-call text back:");
    expect(featureLines(planFeatures(PLAN_CATALOG.studio.limits, { appointment_reminder: "read_only", review_request: "read_only", inquiry_followup: "read_only", missed_call_textback: "read_only" })).every((line) => !line.on)).toBe(true);
    expect(picker).toContain("Agents that draft with AI: off until you turn it on");
    expect(picker).not.toContain("Rule-based agents");
  });

  it("demo mode reads its feature switches from the demo agents (PL-26)", async () => {
    const off = await createDemoBilling().getBillingPlan();
    expect(off.features!.map((feature) => feature.state)).toEqual(["off", "off", "off"]);
    const allOn = await createDemoBilling({ switches: async () => ({ appointment_reminder: "on", review_request: "on", inquiry_followup: "on", missed_call_textback: "on" }) }).getBillingPlan();
    expect(allOn.features!.map((feature) => feature.state)).toEqual(["included", "included", "included"]);
  });

  it("shows the demo plan and keeps Stripe off in demo mode", () => {
    expect(PLAN_BADGE.past_due.label).toBe("Payment failed");
    const html = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, base));
    expect(html).toContain("Studio plan");
    expect(html).toContain(">Trial<");
    expect(html).toContain("Billing is not available here yet.");
    const picker = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, { ...base, status: "none", plan: null, limits: null }));
    expect(picker).toContain("Choose Solo");
    expect(picker).toContain("Paying for a plan is not switched on here yet.");
  });

  it("sends a Shopify-billed business to Shopify's plan page, with no Stripe button or add-on (PL-19)", () => {
    const url = "https://admin.shopify.com/store/halden-rowe/charges/zs-business-connections/pricing_plans";
    const shopify = { ...base, billingProvider: "shopify" as const, checkoutEnabled: false, portalEnabled: false, shopifyManageUrl: url };
    const held = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, { ...shopify, status: "active" }));
    expect(held).toContain("Manage billing in Shopify");
    expect(held).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
    expect(held).not.toContain("Billing is not available here yet.");
    const picker = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan,
      { ...shopify, status: "none", plan: null, limits: null }));
    expect(picker).toContain("Manage billing in Shopify");
    expect(picker).not.toContain("Choose Solo");
    expect(picker).not.toContain("Extra managed connections");
    expect(picker).not.toContain("Paying for a plan is not switched on here yet.");
    const unknown = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan,
      { ...shopify, status: "none", plan: null, limits: null, shopifyManageUrl: null }));
    expect(unknown).toContain(escaped(SHOPIFY_ADMIN_HINT).replaceAll(">", "&gt;"));
    expect(unknown).not.toContain("Manage billing in Shopify");
  });

  it("keeps reading an already active plan for a while after a Shopify return, then stops (PL-18)", () => {
    const now = Date.parse(NEAR_MIDNIGHT_UTC);
    const watchUntil = now + PLAN_WATCH_MS;
    // Shopify: an active plan can still change at the runner's next pass, so reading goes on.
    expect(planRefetchInterval({ status: "active" }, { watchUntil }, now)).toBe(PLAN_WATCH_POLL_MS);
    expect(planRefetchInterval({ status: "active" }, { watchUntil }, watchUntil - 1)).toBe(PLAN_WATCH_POLL_MS);
    expect(planRefetchInterval({ status: "active" }, { watchUntil }, watchUntil)).toBe(false);
    // Stripe: reads until the plan settles.
    expect(planRefetchInterval({ status: "none" }, { poll: true }, now)).toBe(PLAN_POLL_MS);
    expect(planRefetchInterval({ status: "active" }, { poll: true }, now)).toBe(false);
    expect(planRefetchInterval(undefined, {}, now)).toBe(false);
  });

  it("describes the plan and the wallet as the contracts do", async () => {
    const billing = createDemoBilling();
    const text = JSON.stringify([await billing.getBillingPlan(), await billing.getWallet()]);
    expect(text).not.toMatch(/deposit|payout|refund/i);
    // twilio.md: nothing in v1 sends texts; resend.md: email goes out through the email provider, not a mailbox.
    expect(text).not.toMatch(/text message|text number|\bsms\b|gmail/i);
    // delivery.md D-4: the wallet is integer minor units, and what is available is the balance less what is held.
    const wallet = await billing.getWallet();
    expect(wallet.available).toBe(wallet.balance - wallet.reserved);
  });

  it("reads nothing from a demo workspace in the live app", () => {
    const api = createApi({ mode: "live" }).api as unknown as Record<string, unknown>;
    for (const name of ["getUsage", "getChecklist", "listConnections"]) expect(api[name], name).toBeUndefined();
    expect(typeof api.getWallet).toBe("function");
  });
});

const BUSINESS: BusinessProfile = {
  displayName: DEMO_BUSINESS, legalName: "Halden & Rowe Ltd", phoneE164: "+442079460000", timeZone: "Europe/London", currency: "EUR",
  postalAddress: { line1: "12 Mill Lane", city: "Leeds", country: "GB" }, description: null, services: [], revision: 2, updatedAt: "2026-10-23T10:00:00.000Z",
};
const seedBusiness = (client: QueryClient) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).business, BUSINESS);
const escaped = (text: string) => text.replaceAll("&", "&amp;");

describe("settings", () => {
  it("fills the business form from the profile and says in demo mode that a save is sample data", () => {
    const html = render(h(SettingsView), "demo", seedBusiness);
    expect(html).toContain(`value="${escaped(DEMO_BUSINESS)}"`);
    expect(html).toContain(`value="${escaped("Halden & Rowe Ltd")}"`);
    expect(html).toContain('value="+442079460000"');
    expect(html).toContain('value="12 Mill Lane"');
    expect(html).toMatch(/<option value="EUR" selected="">EUR · Euro<\/option>/);
    expect(html).toMatch(/<option value="GB" selected="">United Kingdom<\/option>/);
    expect(html).toContain(BUSINESS_DEMO_NOTE);
    expect(html).not.toContain("saved to your business");
    expect(html).not.toContain("+1 212 555 0142</");
    expect(html).not.toContain(BUSINESS_OWNER_ONLY);
    // Nothing is edited yet, so there is nothing to save.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Save changes/);
  });

  it("shows the form loading until the profile arrives, never an empty form that looks saved", () => {
    const html = render(h(SettingsView), "demo");
    expect(html).toContain('aria-label="Loading business details"');
    expect(html).not.toContain("Save changes");
  });

  it("keeps the form read-only for staff, with the reason", () => {
    const html = render(h(SettingsView), "demo", seedBusiness, (runtime) => runtime.demo!.actAs("staff"));
    expect(html).toContain(BUSINESS_OWNER_ONLY);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*aria-describedby="business-locked"/);
    expect(html).not.toContain(BUSINESS_DEMO_NOTE);
  });

  it("keeps the form read-only with a reason when the API has no profile yet (BP-10)", () => {
    const html = render(h(SettingsView), "demo", (client) => {
      // A failed query is retried on mount by default, which would show the loading rows instead.
      client.setDefaultOptions({ queries: { retryOnMount: false } });
      const query = client.getQueryCache().build(client, { queryKey: scopeKeys(DEMO_TENANT_ID).business });
      query.setState({ status: "error", error: new ApiError("not_found", "We could not find that.", 404), fetchStatus: "idle", errorUpdateCount: 1 });
    });
    expect(html).toContain(BUSINESS_NOT_AVAILABLE);
    expect(html).toContain(`value="${escaped(DEMO_BUSINESS)}"`);
    // The API gave no currency: none is invented.
    expect(html).toMatch(/<option value="" selected="">Not available<\/option>/);
    expect(html).not.toMatch(/<option value="USD" selected="">/);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("shows no notification settings, since nothing sends them", () => {
    for (const mode of ["demo", "live"] as const) {
      const html = render(h(SettingsView), mode);
      expect(html).not.toContain("Coming soon");
      expect(html).not.toContain("Notifications");
      expect(html).not.toMatch(/New booking|Agent needs approval|Monday results/);
      expect(html).not.toContain('role="switch"');
    }
  });
});
