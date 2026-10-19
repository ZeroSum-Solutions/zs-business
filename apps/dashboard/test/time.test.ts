import { describe, expect, it } from "vitest";
import { addDays, formatTime, startOfZonedDay, zonedDateKey, zonedTimeToUtc } from "../src/lib/time";

const MINUTE = 60_000;

describe("startOfZonedDay", () => {
  // These zones move their clocks at local midnight, so 00:00 does not exist (or repeats).
  it.each([
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z"],
    ["America/Santiago", "2027-09-05", "2027-09-05T04:00:00.000Z"],
    ["America/Havana", "2026-03-08", "2026-03-08T05:00:00.000Z"],
    // Fall back at midnight: 23:00-24:00 of the day before repeats; 00:00 itself exists once.
    ["America/Santiago", "2026-04-05", "2026-04-05T04:00:00.000Z"],
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z"],
    ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z"],
  ])("%s %s starts at the first instant of that local date", (zone, day, expected) => {
    const start = startOfZonedDay(day, zone);
    expect(start.toISOString()).toBe(expected);
    expect(zonedDateKey(start, zone)).toBe(day);
    expect(zonedDateKey(start.getTime() - MINUTE, zone)).toBe(addDays(day, -1));
  });

  it.each(["America/Santiago", "America/Havana", "America/Asuncion", "Asia/Beirut", "America/New_York", "Europe/London", "Australia/Lord_Howe", "UTC"])(
    "every day of 2026 and 2027 in %s starts on that day and the minute before is the day before",
    (zone) => {
      for (let day = "2026-01-01"; day < "2028-01-01"; day = addDays(day, 1)) {
        const start = startOfZonedDay(day, zone).getTime();
        expect(zonedDateKey(start, zone), `${zone} ${day}`).toBe(day);
        expect(zonedDateKey(start - MINUTE, zone), `${zone} ${day}`).toBe(addDays(day, -1));
      }
    },
  );

  it("keeps zonedTimeToUtc exact for ordinary times and takes the earlier of repeated ones", () => {
    expect(zonedTimeToUtc(2026, 10, 20, 10 * 60, "America/New_York").toISOString()).toBe("2026-10-20T14:00:00.000Z");
    expect(zonedTimeToUtc(2026, 11, 1, 90, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // 02:30 does not exist on 2026-03-08 in New York: the first instant after the gap.
    expect(zonedTimeToUtc(2026, 3, 8, 150, "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });
});

describe("formatTime", () => {
  it("tells the two 1:30 AMs of a fall-back night apart", () => {
    const first = formatTime("2026-11-01T05:30:00.000Z", "America/New_York");
    const second = formatTime("2026-11-01T06:30:00.000Z", "America/New_York");
    expect(first).not.toBe(second);
    expect(first).toBe("1:30 AM EDT");
    expect(second).toBe("1:30 AM EST");
  });

  it("names the offset in zones without an abbreviation", () => {
    // Santiago repeats 23:00-24:00 on 2026-04-04.
    expect(formatTime("2026-04-05T02:30:00.000Z", "America/Santiago")).toBe("11:30 PM GMT-3");
    expect(formatTime("2026-04-05T03:30:00.000Z", "America/Santiago")).toBe("11:30 PM GMT-4");
  });

  it("leaves times that happen once unlabelled", () => {
    expect(formatTime("2026-11-01T07:30:00.000Z", "America/New_York")).toBe("2:30 AM");
    expect(formatTime("2026-10-20T14:00:00.000Z", "America/New_York")).toBe("10:00 AM");
  });
});
