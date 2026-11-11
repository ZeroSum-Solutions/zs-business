// Account › Plan and Settings: dates in the viewer's zone, no promise the contracts do not keep
// (stripe.md, delivery.md D-4), and nothing in demo mode that looks saved when it was not.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { billingNotice, grantSummary, PLAN_BADGE, planDateLine, PlanView, SHOPIFY_ADMIN_HINT } from "../src/components/account/plan-view";
import { BUSINESS_DEMO_NOTE, BUSINESS_NOT_AVAILABLE, BUSINESS_OWNER_ONLY, SettingsView } from "../src/components/account/settings-view";
import { ToastProvider } from "../src/components/ui/toast";
import type { BillingPlan, BusinessProfile } from "@zs/contracts";
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
  postalAddress: { line1: "12 Mill Lane", city: "Leeds", country: "GB" }, revision: 2, updatedAt: "2026-10-23T10:00:00.000Z",
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
