// The plan page asks the API for its feature switches (plans.md PL-26). The API adds `features` only when the
// request says `?features=1`, because its response schema is strict: an old dashboard never gets an unknown key,
// so the dashboard must send the query for the lines to appear.
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

describe("plan read", () => {
  it("opts in to the feature switches", async () => {
    const requests: URL[] = [];
    const api = createHttpClient({
      baseUrl: "https://api.example.test",
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return new Response(JSON.stringify({ error: { code: "NotFound", message: "Not found", details: {} } }), { status: 404, headers: { "Content-Type": "application/json" } });
      },
    });
    await api.getBillingPlan().catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v1/billing/plan");
    expect(requests[0]?.searchParams.get("features")).toBe("1");
  });
});

// plans.md PL-26: an open plan page must not keep naming a feature after its switch changed elsewhere. (The timers
// themselves belong to TanStack Query, which does not run them outside a browser; the page's settings are checked.)
describe("plan page refresh", () => {
  it("reads the plan again on focus and every minute while open, and faster while a checkout settles", async () => {
    const { PLAN_IDLE_REFRESH_MS, PLAN_POLL_MS, planReadBehavior } = await import("../src/lib/queries");
    expect(PLAN_IDLE_REFRESH_MS).toBeLessThanOrEqual(60_000);
    const behavior = planReadBehavior();
    expect(behavior.staleTime).toBe(0);
    expect(behavior.refetchOnWindowFocus).toBe(true);
    expect(behavior.refetchInterval({ state: { data: undefined } })).toBe(PLAN_IDLE_REFRESH_MS);
    expect(planReadBehavior({ poll: true }).refetchInterval({ state: { data: { status: "none" } as never } })).toBe(PLAN_POLL_MS);
  });
});
