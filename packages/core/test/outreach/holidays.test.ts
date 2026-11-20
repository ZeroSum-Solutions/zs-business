import { describe, expect, it } from "vitest";
import { holidayDates } from "../../src/outreach/holidays.js";
import { isHoliday, isSendDay, mayStartSend, nextSendDay } from "../../src/outreach/schedule.js";

const LA = "America/Los_Angeles";
const at = (iso: string) => Date.parse(iso);

describe("the outreach holiday calendar (OS-11)", () => {
  it("lists the federal holidays and the day after Thanksgiving for 2026, computed from the rules", () => {
    expect(holidayDates(2026)).toEqual([
      "2026-01-01", // New Year's Day (Thursday)
      "2026-01-19", // Martin Luther King Jr. Day, third Monday
      "2026-02-16", // Washington's Birthday, third Monday
      "2026-05-25", // Memorial Day, last Monday
      "2026-06-19", // Juneteenth (Friday)
      "2026-07-03", // Independence Day falls on Saturday 4 July: observed Friday
      "2026-09-07", // Labor Day
      "2026-10-12", // Columbus Day, second Monday
      "2026-11-11", // Veterans Day (Wednesday)
      "2026-11-26", // Thanksgiving, fourth Thursday
      "2026-11-27", // the day after Thanksgiving
      "2026-12-25", // Christmas Day (Friday)
    ]);
  });

  it("computes other years, not a 2026 list, with observed dates", () => {
    // 2027: 19 June is Saturday (observed Friday 18), 4 July is Sunday (observed Monday 5), 25 December is Saturday
    // (observed Friday 24), and 1 January 2028 is Saturday, so it is observed on Friday 31 December 2027.
    expect(holidayDates(2027)).toEqual([
      "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11",
      "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31",
    ]);
    // 2028: 11 November is Saturday (observed Friday 10); 1 January 2028 moved to 2027, so 2028 has none in January 1.
    expect(holidayDates(2028)).toEqual([
      "2028-01-17", "2028-02-21", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-10-09", "2028-11-10", "2028-11-23", "2028-11-24", "2028-12-25",
    ]);
    expect(isHoliday("2027-12-31")).toBe(true);
    expect(isHoliday("2028-01-03")).toBe(false);
    expect(isHoliday("2028-11-11")).toBe(false); // the Saturday itself is a weekend, not a listed holiday
  });

  it("separates holidays from send days", () => {
    expect(isHoliday("2026-11-26")).toBe(true);
    expect(isHoliday("2026-11-27")).toBe(true);
    expect(isHoliday("2026-11-25")).toBe(false);
    expect(isHoliday("2026-12-25")).toBe(true);
    expect(isSendDay("2026-12-25")).toBe(false);
    expect(isSendDay("2026-11-28")).toBe(false); // Saturday
    expect(isSendDay("2026-11-30")).toBe(true);
    expect(nextSendDay("2026-11-26")).toBe("2026-11-30");
    expect(nextSendDay("2026-11-27")).toBe("2026-11-30");
    expect(nextSendDay("2026-11-30")).toBe("2026-11-30");
    expect(nextSendDay("2026-12-25")).toBe("2026-12-28");
    expect(nextSendDay("2026-07-03")).toBe("2026-07-06");
  });

  it("never sends on Thanksgiving 2026, the day after, or Christmas, inside the window", () => {
    const may = (iso: string) => mayStartSend({ timeZone: LA, nowMs: at(iso), windowStartMin: 480, windowEndMin: 630 });
    expect(may("2026-11-25T17:00:00Z")).toBe(true); // Wednesday 09:00 PST
    expect(may("2026-11-26T17:00:00Z")).toBe(false); // Thanksgiving 09:00 PST
    expect(may("2026-11-27T17:00:00Z")).toBe(false); // the Friday after
    expect(may("2026-11-30T17:00:00Z")).toBe(true); // Monday
    expect(may("2026-12-24T17:00:00Z")).toBe(true); // Christmas Eve is not a federal holiday
    expect(may("2026-12-25T17:00:00Z")).toBe(false); // Christmas Day 09:00 PST
    expect(may("2026-12-28T17:00:00Z")).toBe(true);
  });

  it("takes the holiday from the tenant's local date, not the UTC date", () => {
    const all = { windowStartMin: 0, windowEndMin: 1440 };
    // 2026-11-27T03:00Z is still Thanksgiving evening (19:00) in Los Angeles.
    expect(mayStartSend({ timeZone: LA, nowMs: at("2026-11-27T03:00:00Z"), ...all })).toBe(false);
    // 2026-11-26T05:00Z is Wednesday evening (21:00) in Los Angeles: not a holiday yet.
    expect(mayStartSend({ timeZone: LA, nowMs: at("2026-11-26T05:00:00Z"), ...all })).toBe(true);
    // The same instant is Thanksgiving morning (09:30) in Auckland, and the tenant's local date decides, so it is held too.
    expect(mayStartSend({ timeZone: "Pacific/Auckland", nowMs: at("2026-11-25T20:30:00Z"), ...all })).toBe(false);
    // 2026-11-28T07:00Z is Friday 23:00 in Los Angeles (a holiday) and Saturday elsewhere.
    expect(mayStartSend({ timeZone: LA, nowMs: at("2026-11-28T07:00:00Z"), ...all })).toBe(false);
    // 2026-11-30T00:00Z is Sunday afternoon in Los Angeles but Monday 09:00 in Tokyo, a send day there.
    expect(mayStartSend({ timeZone: "Asia/Tokyo", nowMs: at("2026-11-30T00:00:00Z"), ...all })).toBe(true);
    expect(mayStartSend({ timeZone: LA, nowMs: at("2026-11-30T00:00:00Z"), ...all })).toBe(false);
  });
});
