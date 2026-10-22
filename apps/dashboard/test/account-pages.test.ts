// Account › Plan and Settings: dates in the viewer's zone, no promise the contracts do not keep
// (stripe.md, delivery.md D-4), and nothing in demo mode that looks saved when it was not.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cancelTerms, cancelledNote, PLAN_BADGE, planDateLine, PlanView } from "../src/components/account/plan-view";
import { DEMO_SAVE_NOTE, SettingsView } from "../src/components/account/settings-view";
import { ToastProvider } from "../src/components/ui/toast";
import { NOT_AVAILABLE } from "../src/components/ui/sample";
import { createApi } from "../src/lib/api";
import { DEMO_BUSINESS, DEMO_TENANT_ID } from "../src/lib/api/demo/seed";
import { createDemoWorkspace } from "../src/lib/api/demo/workspace";
import { ApiProvider } from "../src/lib/api/react";
import type { Plan } from "../src/lib/api/workspace-types";
import { scopeKeys } from "../src/lib/queries";
import { SessionProvider } from "../src/lib/session";

const NEAR_MIDNIGHT_UTC = "2026-11-21T03:30:00.000Z";
const plan = (change: Partial<Plan> = {}): Plan => ({
  name: "Studio", currency: "USD", pricePerMonth: 149, renewsOn: NEAR_MIDNIGHT_UTC, status: "active", endsOn: null,
  includes: ["Six areas"], caps: [], ...change,
});

function render(node: ReactNode, mode: "demo" | "live", seed?: (client: QueryClient) => void): string {
  const client = new QueryClient();
  seed?.(client);
  const toasts = h(ToastProvider, { children: node });
  const tree = h(ApiProvider, {
    runtime: createApi({ mode }),
    children: h(QueryClientProvider, { client, children: h(SessionProvider, { children: toasts }) }),
  });
  return renderToString(tree).replaceAll("<!-- -->", "");
}

describe("plan", () => {
  it("dates the renewal and the end in the zone it is given, not New York", () => {
    expect(planDateLine(plan(), "Pacific/Honolulu")).toBe("Renews Friday, November 20");
    expect(planDateLine(plan(), "Asia/Tokyo")).toBe("Renews Saturday, November 21");
    expect(planDateLine(plan({ status: "cancelled", endsOn: NEAR_MIDNIGHT_UTC }), "Pacific/Honolulu")).toBe("Ends Friday, November 20");
  });

  it("promises no wallet refund and no export the product does not offer", () => {
    expect(cancelTerms(NEAR_MIDNIGHT_UTC, "Asia/Tokyo")).toBe("Your plan stays on until Saturday, November 21. After that, nothing more is charged.");
    expect(cancelTerms(NEAR_MIDNIGHT_UTC, "UTC")).not.toMatch(/refund/i);
    expect(cancelledNote(NEAR_MIDNIGHT_UTC, "Asia/Tokyo")).toBe("Your plan is cancelled. It stays on until Saturday, November 21, and nothing more will be charged.");
  });

  it("calls a cancelled plan cancelled", async () => {
    expect(PLAN_BADGE.cancelled.label).toBe("Cancelled");
    const cancelled = await createDemoWorkspace().cancelPlan();
    const html = render(h(PlanView), "demo", (client) => client.setQueryData(scopeKeys(DEMO_TENANT_ID).plan, cancelled));
    expect(html).toContain(">Cancelled<");
    expect(html).not.toContain("Ends soon");
    expect(html).toMatch(/role="status"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="status"/);
  });

  it("describes the wallet and the providers as the contracts do", async () => {
    const workspace = createDemoWorkspace();
    const text = JSON.stringify([await workspace.getPlan(), await workspace.listConnections(), await workspace.getChecklist(), await workspace.getUsage()]);
    expect(text).not.toMatch(/deposit|payout|refund/i);
    // twilio.md: nothing in v1 sends texts; resend.md: email goes out through the email provider, not a mailbox.
    expect(text).not.toMatch(/text message|text number|\bsms\b|gmail/i);
    expect(text).not.toMatch(/pauses at \$0/i);
    expect(text).toMatch(/top-up/i);
  });
});

describe("settings", () => {
  it("shows the session's business and says plainly that the demo does not save", () => {
    const html = render(h(SettingsView), "demo");
    expect(html).toContain(`value="${DEMO_BUSINESS.replaceAll("&", "&amp;")}"`);
    expect(html).toContain(DEMO_SAVE_NOTE);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).not.toContain("+1 212");
  });

  it("offers no notification it cannot send", () => {
    for (const mode of ["demo", "live"] as const) {
      const html = render(h(SettingsView), mode);
      expect(html).toContain("Coming soon");
      expect(html).not.toMatch(/A text when someone books|A push when/);
      expect(html.match(/role="switch"[^>]*disabled=""/g)?.length).toBe(3);
      expect(html).not.toMatch(/aria-checked="true"/);
    }
  });

  it("keeps the save off in live mode with the not-available reason", () => {
    const html = render(h(SettingsView), "live");
    expect(html).toContain(NOT_AVAILABLE);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
