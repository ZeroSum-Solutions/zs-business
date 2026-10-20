import { describe, expect, it } from "vitest";
import { formatAmountInput, parseAmount } from "../src/components/customers/deal-details-dialog";
import { weekRanges } from "../src/lib/time";
import { formatMinor } from "../src/lib/utils";

describe("weekRanges (inbox-home.md H-3)", () => {
  it("compares this week so far with the same local span of last week across a DST change", () => {
    // Tuesday 2026-11-03, 10:00 in New York (EST); clocks fell back on Sunday 2026-11-01.
    const now = Date.parse("2026-11-03T15:00:00.000Z");
    const { thisWeek, lastWeek } = weekRanges(now, "America/New_York", "monday");
    expect(new Date(thisWeek.from).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(new Date(thisWeek.to).toISOString()).toBe("2026-11-09T05:00:00.000Z");
    // Last week was still on EDT: Monday 00:00 is 04:00Z and Tuesday 10:00 is 14:00Z.
    expect(new Date(lastWeek.from).toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(new Date(lastWeek.to).toISOString()).toBe("2026-10-27T14:00:00.000Z");
  });

  it("keeps seconds and milliseconds of now in last week's end", () => {
    const now = Date.parse("2026-10-20T13:04:05.678Z");
    expect(new Date(weekRanges(now, "UTC", "sunday").lastWeek.to).toISOString()).toBe("2026-10-13T13:04:05.678Z");
    expect(new Date(weekRanges(now, "UTC", "sunday").thisWeek.from).toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });
});

describe("money in minor units", () => {
  it("formats whole amounts without cents and keeps cents otherwise", () => {
    expect(formatMinor(640_000, "USD")).toBe("$6,400");
    expect(formatMinor(1_250, "USD")).toBe("$12.50");
    expect(formatMinor(5_000, "JPY")).toBe("¥5,000");
  });

  it("parses what an owner types into minor units for the currency", () => {
    expect(parseAmount("1,250.5", "USD")).toBe(125_050);
    expect(parseAmount("$ 6400", "USD")).toBe(640_000);
    expect(parseAmount("12.345", "USD")).toBeNull();
    expect(parseAmount("-5", "USD")).toBeNull();
    expect(parseAmount("abc", "USD")).toBeNull();
    expect(parseAmount("5000", "JPY")).toBe(5_000);
    expect(parseAmount("5000.5", "JPY")).toBeNull();
    expect(formatAmountInput(125_050, "USD")).toBe("1250.50");
    expect(formatAmountInput(640_000, "USD")).toBe("6400");
  });
});
