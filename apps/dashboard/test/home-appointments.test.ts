import { describe, expect, it } from "vitest";
import { groupByDay } from "../src/components/home/home-model";

const NEW_YORK = "America/New_York";

describe("Next appointments grouped by day", () => {
  it("groups and labels calendars in several zones in the one display zone", () => {
    // 10:00 PM Wednesday Oct 21 in New York, already Thursday Oct 22 in Tokyo.
    const now = "2026-10-22T02:00:00.000Z";
    // Calendars in New York, Tokyo, New York and Tokyo, in start order.
    const bookings = [
      { id: "a", startsAt: "2026-10-22T02:30:00.000Z" },
      { id: "b", startsAt: "2026-10-22T03:00:00.000Z" },
      { id: "c", startsAt: "2026-10-22T03:30:00.000Z" },
      { id: "d", startsAt: "2026-10-22T16:00:00.000Z" },
    ];
    const days = groupByDay(bookings, now, NEW_YORK);
    expect(days.map((day) => [day.key, day.heading, day.items.map((item) => item.id)])).toEqual([
      ["2026-10-21", "Later today", ["a", "b", "c"]],
      ["2026-10-22", "Tomorrow", ["d"]],
    ]);
    expect(new Set(days.map((day) => day.key)).size).toBe(days.length);
  });

  it("names later days by weekday", () => {
    const days = groupByDay([{ startsAt: "2026-10-24T15:00:00.000Z" }], "2026-10-22T14:00:00.000Z", NEW_YORK);
    expect(days.map((day) => day.heading)).toEqual(["Saturday"]);
  });
});
