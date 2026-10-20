// The M5 billing runner as the API deploys it (docs/requirements/stripe.md S-8): GET /cron/billing
// on the shared cron route, and the run loop over worker passes. Stub workers, injected clock.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingWorker } from "@zs/core";
import { createBillingRunner, type BillingRunner, type BillingRunSummary } from "../src/billing/runner.js";
import { cronRoutes } from "../src/delivery/cron.js";

/** Synthetic secret, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "b".repeat(32)].join("-");

const summary = (overrides: Partial<BillingRunSummary> = {}): BillingRunSummary => ({
  passes: 1, claimed: 0, outcomes: {}, budgetSpent: false, ...overrides,
});
const stubRunner = (run: () => Promise<BillingRunSummary>) => {
  const fn = vi.fn(run);
  return { runner: { run: fn } satisfies BillingRunner, run: fn };
};
type CronConfig = Parameters<typeof cronRoutes>[0];
const billingCron = (config: Omit<CronConfig, "path" | "killSwitch" | "name">) =>
  cronRoutes({ ...config, path: "/cron/billing", killSwitch: "BILLING_WORKER", name: "Billing" });
const cron = (config: Omit<CronConfig, "path" | "killSwitch" | "name">, authorization?: string, path = "/cron/billing") =>
  billingCron(config).request(path, authorization === undefined ? {} : { headers: { Authorization: authorization } });

describe("GET /cron/billing", () => {
  it("is not found while CRON_SECRET is unset, and never runs", async () => {
    const { runner, run } = stubRunner(async () => summary());
    const response = await cron({ cronSecret: null, runner }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NotFound" } });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", undefined],
    ["the bare secret", CRON_SECRET],
    ["a wrong secret", `Bearer ${CRON_SECRET.slice(0, -1)}x`],
    ["a longer secret", `Bearer ${CRON_SECRET}x`],
    ["a lower-case scheme", `bearer ${CRON_SECRET}`],
  ])("answers 401 to %s, never cached, and never runs", async (_label, authorization) => {
    const { runner, run } = stubRunner(async () => summary());
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner, onError }, authorization);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: { code: "Unauthorized" } });
    expect(run).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("answers 200 without running while BILLING_WORKER is off", async () => {
    const response = await cron({ cronSecret: CRON_SECRET, runner: null }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: false, reason: "BILLING_WORKER is off" });
  });

  it("runs once and answers the summary, never cached", async () => {
    const result = summary({ passes: 2, claimed: 3, outcomes: { credited: 2, ignored: 1 } });
    const { runner, run } = stubRunner(async () => result);
    const response = await cron({ cronSecret: CRON_SECRET, runner }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: true, ...result });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers 503 and reports the error when a run throws, without its message", async () => {
    const failure = new Error("service pool went away");
    const { runner, run } = stubRunner(async () => { throw failure; });
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner, onError }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "Unavailable" } });
    expect(JSON.stringify(body)).not.toContain("service pool went away");
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("serves only its own path: /cron/delivery and others are 404 on the billing function", async () => {
    const { runner, run } = stubRunner(async () => summary());
    for (const path of ["/cron/delivery", "/cron/other", "/"]) {
      const response = await cron({ cronSecret: CRON_SECRET, runner }, `Bearer ${CRON_SECRET}`, path);
      expect(response.status, path).toBe(404);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the delivery defaults when no path, switch or name is given", async () => {
    const off = await cronRoutes({ cronSecret: CRON_SECRET, runner: null })
      .request("/cron/delivery", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(await off.json()).toEqual({ ran: false, reason: "DELIVERY_WORKER is off" });
    const billingPath = await cronRoutes({ cronSecret: CRON_SECRET, runner: null })
      .request("/cron/billing", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
    expect(billingPath.status).toBe(404);
  });
});

describe("createBillingRunner", () => {
  const START = Date.parse("2026-10-20T09:00:00.000Z");
  let now = START;
  const clock = { now: () => new Date(now) };
  beforeEach(() => { now = START; });

  type Pass = { claimed: number; outcomes?: Record<string, number>; takesMs?: number };
  /** A worker that answers the given passes in order, moving the clock by each pass's `takesMs`. */
  function stubWorker(passes: Pass[]) {
    const limits: number[] = [];
    const worker = {
      config: {},
      async runOnce(limit = 50) {
        limits.push(limit);
        const pass = passes[limits.length - 1];
        if (!pass) throw new Error("runOnce called more often than the test expected");
        now += pass.takesMs ?? 0;
        return { claimed: pass.claimed, outcomes: pass.outcomes ?? {} };
      },
    };
    return { worker: worker as unknown as BillingWorker, limits };
  }

  it("stops after a pass that claims fewer than the limit", async () => {
    const { worker, limits } = stubWorker([{ claimed: 2, outcomes: { credited: 2 } }]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 3 }).run())
      .toEqual(summary({ passes: 1, claimed: 2, outcomes: { credited: 2 } }));
    expect(limits).toEqual([3]);
  });

  it("runs one pass when nothing is due", async () => {
    const { worker, limits } = stubWorker([{ claimed: 0 }]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 50 }).run()).toEqual(summary());
    expect(limits).toHaveLength(1);
  });

  it("keeps going while passes come back full, and sums the outcomes", async () => {
    const { worker, limits } = stubWorker([
      { claimed: 2, outcomes: { credited: 1, ignored: 1 } },
      { claimed: 2, outcomes: { refund_debited: 1, credited: 1 } },
      { claimed: 1, outcomes: { orphaned: 1 } },
    ]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run()).toEqual({
      passes: 3, claimed: 5, outcomes: { credited: 2, ignored: 1, refund_debited: 1, orphaned: 1 }, budgetSpent: false,
    });
    expect(limits).toEqual([2, 2, 2]);
  });

  it("stops at the budget with budgetSpent true, though passes still come back full", async () => {
    const { worker, limits } = stubWorker([
      { claimed: 2, outcomes: { credited: 2 }, takesMs: 3_000 },
      { claimed: 2, outcomes: { credited: 2 }, takesMs: 2_000 }, // 5s in: the budget is spent
      { claimed: 2, outcomes: { credited: 2 } },
    ]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 5_000, claimLimit: 2 }).run())
      .toEqual({ passes: 2, claimed: 4, outcomes: { credited: 4 }, budgetSpent: true });
    expect(limits).toHaveLength(2);
  });

  it("always runs a first pass, even when it alone outlasts the budget", async () => {
    const { worker, limits } = stubWorker([{ claimed: 1, outcomes: { credited: 1 }, takesMs: 9_000 }]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 1_000, claimLimit: 1 }).run())
      .toEqual({ passes: 1, claimed: 1, outcomes: { credited: 1 }, budgetSpent: true });
    expect(limits).toHaveLength(1);
  });

  it("does not call budgetSpent when the last pass was short", async () => {
    const { worker } = stubWorker([
      { claimed: 2, takesMs: 4_000 },
      { claimed: 1, takesMs: 4_000 },
    ]);
    expect(await createBillingRunner({ worker, clock, budgetMs: 5_000, claimLimit: 2 }).run())
      .toMatchObject({ passes: 2, claimed: 3, budgetSpent: false });
  });

  it("lets a throwing pass fail the run", async () => {
    const worker = { config: {}, runOnce: async () => { throw new Error("pool closed"); } } as unknown as BillingWorker;
    await expect(createBillingRunner({ worker, clock, budgetMs: 20_000, claimLimit: 2 }).run()).rejects.toThrow("pool closed");
  });
});
