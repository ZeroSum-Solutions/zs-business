// The M5 calendar runner as the API deploys it (docs/requirements/google-calendar.md G-6..G-10):
// GET /cron/calendar on the shared cron route, and the run loop over worker passes. Stub workers,
// injected clock.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarRunner, type CalendarPassWorker, type CalendarRunner, type CalendarRunSummary } from "../src/calendar/runner.js";
import { cronRoutes } from "../src/delivery/cron.js";

/** Synthetic secret, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");

const summary = (overrides: Partial<CalendarRunSummary> = {}): CalendarRunSummary => ({ passes: 1, counts: {}, budgetSpent: false, ...overrides });
const stubRunner = (run: () => Promise<CalendarRunSummary>) => {
  const fn = vi.fn(run);
  return { runner: { run: fn } satisfies CalendarRunner, run: fn };
};
type CronConfig = Parameters<typeof cronRoutes>[0];
const cron = (config: Omit<CronConfig, "path" | "killSwitch" | "name">, authorization?: string, path = "/cron/calendar") =>
  cronRoutes({ ...config, path: "/cron/calendar", killSwitch: "CALENDAR_WORKER", name: "Calendar" })
    .request(path, authorization === undefined ? {} : { headers: { Authorization: authorization } });

describe("GET /cron/calendar", () => {
  it("is not found while CRON_SECRET is unset, and never runs", async () => {
    const { runner, run } = stubRunner(async () => summary());
    expect((await cron({ cronSecret: null, runner }, `Bearer ${CRON_SECRET}`)).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", undefined],
    ["the bare secret", CRON_SECRET],
    ["a wrong secret", `Bearer ${CRON_SECRET.slice(0, -1)}x`],
    ["a longer secret", `Bearer ${CRON_SECRET}x`],
  ])("answers 401 to %s, never cached, and never runs", async (_label, authorization) => {
    const { runner, run } = stubRunner(async () => summary());
    const response = await cron({ cronSecret: CRON_SECRET, runner }, authorization);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(run).not.toHaveBeenCalled();
  });

  it("answers 200 without running while CALENDAR_WORKER is off", async () => {
    const response = await cron({ cronSecret: CRON_SECRET, runner: null }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: false, reason: "CALENDAR_WORKER is off" });
  });

  it("runs once and answers the summary, never cached", async () => {
    const result = summary({ passes: 2, counts: { synced: 3, pushed: 1 } });
    const { runner, run } = stubRunner(async () => result);
    const response = await cron({ cronSecret: CRON_SECRET, runner }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ran: true, ...result });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers 503 and reports the error when a run throws, without its message", async () => {
    const failure = new Error("service pool went away");
    const { runner } = stubRunner(async () => { throw failure; });
    const onError = vi.fn();
    const response = await cron({ cronSecret: CRON_SECRET, runner, onError }, `Bearer ${CRON_SECRET}`);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("service pool went away");
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("serves only its own path on the calendar function", async () => {
    const { runner, run } = stubRunner(async () => summary());
    for (const path of ["/cron/delivery", "/cron/billing", "/"])
      expect((await cron({ cronSecret: CRON_SECRET, runner }, `Bearer ${CRON_SECRET}`, path)).status, path).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("createCalendarRunner", () => {
  const START = Date.parse("2026-10-20T09:00:00.000Z");
  let now = START;
  const clock = { now: () => new Date(now) };
  beforeEach(() => { now = START; });

  type Pass = { counts: Record<string, unknown>; takesMs?: number };
  function stubWorker(passes: Pass[]): { worker: CalendarPassWorker; calls: () => number } {
    let calls = 0;
    return {
      worker: {
        async runOnce() {
          const pass = passes[calls++];
          if (!pass) throw new Error("runOnce called more often than the test expected");
          now += pass.takesMs ?? 0;
          return pass.counts;
        },
      },
      calls: () => calls,
    };
  }
  const idle = { synced: 0, pushed: 0, notifications: 0 };

  it("runs one pass when nothing is due", async () => {
    const { worker, calls } = stubWorker([{ counts: idle }]);
    expect(await createCalendarRunner({ worker, clock, budgetMs: 20_000 }).run()).toEqual(summary({ counts: idle }));
    expect(calls()).toBe(1);
  });

  it("keeps going while passes move work, sums the counts, and stops after an idle pass", async () => {
    const { worker, calls } = stubWorker([
      { counts: { synced: 2, pushed: 1, notifications: 0 } },
      { counts: { synced: 1, pushed: 0, notifications: 3 } },
      { counts: idle },
    ]);
    expect(await createCalendarRunner({ worker, clock, budgetMs: 20_000 }).run())
      .toEqual({ passes: 3, counts: { synced: 3, pushed: 1, notifications: 3 }, budgetSpent: false });
    expect(calls()).toBe(3);
  });

  it("ignores fields that are not counts", async () => {
    const { worker } = stubWorker([{ counts: { synced: 1, label: "x", nested: { a: 1 }, bad: Number.NaN } }, { counts: { synced: 0, label: "y" } }]);
    expect(await createCalendarRunner({ worker, clock, budgetMs: 20_000 }).run()).toEqual({ passes: 2, counts: { synced: 1 }, budgetSpent: false });
  });

  it("stops at the budget with budgetSpent true, though passes still move work", async () => {
    const { worker, calls } = stubWorker([
      { counts: { synced: 1 }, takesMs: 3_000 },
      { counts: { synced: 1 }, takesMs: 2_000 },
      { counts: { synced: 1 } },
    ]);
    expect(await createCalendarRunner({ worker, clock, budgetMs: 5_000 }).run()).toEqual({ passes: 2, counts: { synced: 2 }, budgetSpent: true });
    expect(calls()).toBe(2);
  });

  it("always runs a first pass, even when it alone outlasts the budget", async () => {
    const { worker } = stubWorker([{ counts: { synced: 1 }, takesMs: 9_000 }]);
    expect(await createCalendarRunner({ worker, clock, budgetMs: 1_000 }).run()).toEqual({ passes: 1, counts: { synced: 1 }, budgetSpent: true });
  });

  it("lets a throwing pass fail the run", async () => {
    const worker: CalendarPassWorker = { runOnce: async () => { throw new Error("pool closed"); } };
    await expect(createCalendarRunner({ worker, clock, budgetMs: 20_000 }).run()).rejects.toThrow("pool closed");
  });
});
