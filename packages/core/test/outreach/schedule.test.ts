import { describe, expect, it } from "vitest";
import {
  addBusinessDays, clockMinutes, DEFAULT_WARMUP, inWindow, isBusinessDay, isDue, localMoment, mayStartSend, nextLocalMidnight, warmupCap,
} from "../../src/outreach/schedule.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("business days (OS-11)", () => {
  it("counts Monday to Friday", () => {
    expect(addBusinessDays("2026-11-06", 1)).toBe("2026-11-09"); // Friday + 1 = Monday
    expect(addBusinessDays("2026-11-04", 3)).toBe("2026-11-09"); // Wednesday + 3 = Monday
    expect(addBusinessDays("2026-11-09", 0)).toBe("2026-11-09");
    expect(addBusinessDays("2026-11-09", 5)).toBe("2026-11-16");
    expect(addBusinessDays("2026-11-07", 1)).toBe("2026-11-09"); // Saturday + 1 = Monday
    expect(addBusinessDays("2026-11-13", 8)).toBe("2026-11-25");
    expect(isBusinessDay("2026-11-07")).toBe(false);
    expect(isBusinessDay("2026-11-08")).toBe(false);
    expect(isBusinessDay("2026-11-09")).toBe(true);
    expect(() => addBusinessDays("2026-11-09", -1)).toThrow(RangeError);
    expect(() => isBusinessDay("2026-02-30")).toThrow(RangeError);
  });

  it("uses the tenant's local date across the daylight-saving change", () => {
    // 2026-11-01 02:00 PDT falls back to 01:00 PST. 09:00 local is 17:00 UTC after it and 16:00 UTC before it.
    expect(localMoment(LA, at("2026-10-31T16:00:00Z"))).toMatchObject({ date: "2026-10-31", minutes: 9 * 60 });
    expect(localMoment(LA, at("2026-11-02T17:00:00Z"))).toMatchObject({ date: "2026-11-02", minutes: 9 * 60 });
    expect(localMoment(LA, at("2026-11-02T07:59:00Z"))).toMatchObject({ date: "2026-11-01", minutes: 23 * 60 + 59 });
    // Spring forward: 2027-03-14 02:00 PST becomes 03:00 PDT.
    expect(localMoment(LA, at("2027-03-15T16:00:00Z"))).toMatchObject({ date: "2027-03-15", minutes: 9 * 60 });
    expect(localMoment(LA, at("2027-03-15T15:00:00Z"))).toMatchObject({ date: "2027-03-15", minutes: 8 * 60 });
  });

  it("takes the send window as [start, end) in local time", () => {
    const start = clockMinutes("08:00");
    const end = clockMinutes("10:30");
    const may = (iso: string) => mayStartSend({ timeZone: LA, nowMs: at(iso), windowStartMin: start, windowEndMin: end });
    expect(may("2026-11-09T15:59:00Z")).toBe(false); // 07:59 PST Monday
    expect(may("2026-11-09T16:00:00Z")).toBe(true); // 08:00
    expect(may("2026-11-09T18:29:00Z")).toBe(true); // 10:29
    expect(may("2026-11-09T18:30:00Z")).toBe(false); // 10:30 exactly is outside
    // The same wall-clock window before and after the fall-back uses local time, not a fixed UTC hour.
    expect(may("2026-10-30T15:00:00Z")).toBe(true); // 08:00 PDT Friday
    expect(may("2026-10-30T16:00:00Z")).toBe(true); // 09:00 PDT Friday
    expect(may("2026-11-02T16:00:00Z")).toBe(true); // 08:00 PST Monday
    expect(may("2026-11-02T15:00:00Z")).toBe(false); // 07:00 PST Monday
    expect(inWindow(630, start, end)).toBe(false);
  });

  it("sends nothing on a Saturday or Sunday", () => {
    const may = (iso: string) => mayStartSend({ timeZone: LA, nowMs: at(iso), windowStartMin: 480, windowEndMin: 630 });
    expect(may("2026-11-07T17:00:00Z")).toBe(false); // Saturday 09:00 PST
    expect(may("2026-11-08T17:00:00Z")).toBe(false); // Sunday
    expect(may("2026-11-06T17:00:00Z")).toBe(true); // Friday
    // 23:30 Friday in Los Angeles is already Saturday in UTC; the local day decides.
    expect(may("2026-11-07T07:30:00Z")).toBe(false);
  });

  it("is due on or after next_due_on", () => {
    expect(isDue("2026-11-09", "2026-11-09")).toBe(true);
    expect(isDue("2026-11-10", "2026-11-09")).toBe(false);
    expect(isDue("2026-11-06", "2026-11-09")).toBe(true);
  });

  it("finds the next local midnight", () => {
    expect(nextLocalMidnight(LA, at("2026-11-09T18:00:00Z"))).toBe(at("2026-11-10T08:00:00Z"));
    // The night of the fall-back is 25 hours long.
    expect(nextLocalMidnight(LA, at("2026-11-01T12:00:00Z"))).toBe(at("2026-11-02T08:00:00Z"));
  });
});

describe("warm-up ramp (OS-12)", () => {
  const first = "2026-11-02";
  const on = (offsetDays: number) => {
    const days = Date.UTC(2026, 10, 2 + offsetDays) / 86_400_000;
    return new Date(days * 86_400_000).toISOString().slice(0, 10);
  };

  it("starts at 5 and rises by 5 every 7 days up to the cap", () => {
    expect(warmupCap(first, first, 20)).toBe(5);
    expect(warmupCap(first, on(6), 20)).toBe(5);
    expect(warmupCap(first, on(7), 20)).toBe(10);
    expect(warmupCap(first, on(13), 20)).toBe(10);
    expect(warmupCap(first, on(14), 20)).toBe(15);
    expect(warmupCap(first, on(21), 20)).toBe(20);
    expect(warmupCap(first, on(400), 20)).toBe(20);
    expect(warmupCap(first, on(400), 12)).toBe(12);
  });

  it("never passes a cap below the start", () => {
    expect(warmupCap(first, first, 3)).toBe(3);
    expect(warmupCap(first, on(30), 1)).toBe(1);
  });

  it("takes the ramp as a parameter and defaults to 5, 5, 7", () => {
    expect(DEFAULT_WARMUP).toEqual({ start: 5, step: 5, periodDays: 7 });
    expect(warmupCap(first, first, 20, { start: 50, step: 0, periodDays: 7 })).toBe(20);
    expect(warmupCap(first, on(2), 20, { start: 2, step: 3, periodDays: 2 })).toBe(5);
  });

  it("rejects a today before the first send and a bad cap or date", () => {
    expect(() => warmupCap(first, "2026-11-01", 20)).toThrow(RangeError);
    expect(() => warmupCap(first, first, 0)).toThrow(RangeError);
    expect(() => warmupCap("2026-13-01", first, 20)).toThrow(RangeError);
    expect(() => warmupCap(first, first, 20, { start: 0, step: 5, periodDays: 7 })).toThrow(RangeError);
  });
});
