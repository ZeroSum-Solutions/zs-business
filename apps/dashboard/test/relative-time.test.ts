// How long ago a thread or a deal last moved, in calendar days of the display zone (U1-9).
import { describe, expect, it } from "vitest";
import { relativeTime } from "../src/lib/utils";

const NEW_YORK = "America/New_York";
// Thursday Oct 22, 9:00 AM in New York.
const NOW = Date.parse("2026-10-22T13:00:00.000Z");

describe("relativeTime", () => {
  it("counts minutes, then hours within the same day", () => {
    expect(relativeTime("2026-10-22T12:59:40.000Z", NOW, NEW_YORK)).toBe("Just now");
    expect(relativeTime("2026-10-22T12:15:00.000Z", NOW, NEW_YORK)).toBe("45 min ago");
    expect(relativeTime("2026-10-22T05:00:00.000Z", NOW, NEW_YORK)).toBe("8 h ago");
  });

  it("counts calendar days, not 24-hour spans", () => {
    // Wednesday 7:00 PM, 14 hours ago, is yesterday.
    expect(relativeTime("2026-10-21T23:00:00.000Z", NOW, NEW_YORK)).toBe("Yesterday");
    // Tuesday 10:30 PM, 34.5 hours ago, is two calendar days back.
    expect(relativeTime("2026-10-21T02:30:00.000Z", NOW, NEW_YORK)).toBe("2 days ago");
  });

  it("says yesterday for anything on yesterday's date, even 38 hours back", () => {
    // Thursday Oct 22, 11:30 PM in New York; Wednesday Oct 21, 9:00 AM is 38.5 hours earlier.
    const late = Date.parse("2026-10-23T03:30:00.000Z");
    expect(relativeTime("2026-10-21T13:00:00.000Z", late, NEW_YORK)).toBe("Yesterday");
  });

  it("reads days in the zone it is given", () => {
    // 11:30 PM Wednesday in New York is already Thursday in Tokyo.
    const at = "2026-10-22T03:30:00.000Z";
    expect(relativeTime(at, NOW, NEW_YORK)).toBe("Yesterday");
    expect(relativeTime(at, NOW, "Asia/Tokyo")).toBe("10 h ago");
  });
});
