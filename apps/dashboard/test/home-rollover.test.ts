import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMinute, groupByDay, needsModel, nextCutoff, subscribeMinute } from "../src/components/home/home-model";

const NEW_YORK = "America/New_York";
const quiet = { waiting: 0, statuses: ["success" as const], checklist: [], threads: [] };

describe("Home at midnight", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rolls headings and today's count over with the minute clock, and re-reads bookings once a day", () => {
    // Home opened at 3:00 PM Wednesday Oct 21 in New York.
    vi.setSystemTime(new Date("2026-10-21T19:00:00.000Z"));
    let cutoff = new Date().toISOString();
    let now = currentMinute();
    const cutoffs = new Set([cutoff]);
    const unsubscribe = subscribeMinute(() => {
      now = currentMinute();
      cutoff = nextCutoff(cutoff, now, NEW_YORK);
      cutoffs.add(cutoff);
    });
    // 9:00 AM Thursday in New York.
    const thursday = { startsAt: "2026-10-22T13:00:00.000Z" };
    const read = () => ({ days: groupByDay([thursday], now, NEW_YORK), needs: needsModel({ ...quiet, bookings: [thursday], now, zone: NEW_YORK }) });

    expect(read().days.map((day) => day.heading)).toEqual(["Tomorrow"]);
    expect(read().needs.count).toBe(0);

    // To 11:59 PM: the minute clock ticks, but the bookings read stays the same.
    vi.advanceTimersByTime(8 * 60 * 60_000 + 59 * 60_000);
    expect(cutoffs.size).toBe(1);
    expect(read().days.map((day) => day.heading)).toEqual(["Tomorrow"]);

    // Midnight: Thursday is today, and the bookings are read once more from then.
    vi.advanceTimersByTime(60_000);
    expect(read().days.map((day) => day.heading)).toEqual(["Later today"]);
    expect(read().needs.count).toBe(1);
    expect([...cutoffs]).toEqual(["2026-10-21T19:00:00.000Z", "2026-10-22T04:00:00.000Z"]);
    unsubscribe();
  });

  it("reads today from the live clock, not from when the bookings were read", () => {
    // Read at 3:00 PM Wednesday; the clock is now past midnight, before the cutoff moves.
    const thursday = { startsAt: "2026-10-22T13:00:00.000Z" };
    const needs = needsModel({ ...quiet, bookings: [thursday], now: Date.parse("2026-10-22T04:00:00.000Z"), zone: NEW_YORK });
    expect(needs.count).toBe(1);
  });

  it("keeps the cutoff until the display zone's day changes", () => {
    const cutoff = "2026-10-21T19:00:00.000Z";
    expect(nextCutoff(cutoff, null, NEW_YORK)).toBe(cutoff);
    expect(nextCutoff(cutoff, Date.parse("2026-10-22T03:59:00.000Z"), NEW_YORK)).toBe(cutoff);
    expect(nextCutoff(cutoff, Date.parse("2026-10-22T04:00:00.000Z"), NEW_YORK)).toBe("2026-10-22T04:00:00.000Z");
  });
});
