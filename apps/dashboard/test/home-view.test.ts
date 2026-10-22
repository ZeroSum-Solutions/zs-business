// Home's words and states from the UI audit's visual review (UV-1, UV-22, UV-23, UV-25).
import { describe, expect, it } from "vitest";
import { formatWeekChange, needsState, nextTitle, readStatus, resourceTone } from "../src/components/home/home-model";

const NEW_YORK = "America/New_York";
// Thursday Oct 22, 9:00 AM in New York.
const NOW = Date.parse("2026-10-22T13:00:00.000Z");

describe("Home offline", () => {
  it("treats a read paused for want of a connection as failed, not as still loading", () => {
    expect(readStatus({ status: "pending", fetchStatus: "paused" })).toBe("error");
    expect(readStatus({ status: "pending", fetchStatus: "fetching" })).toBe("pending");
    // Cached data stays shown while a refetch waits for the connection.
    expect(readStatus({ status: "success", fetchStatus: "paused" })).toBe("success");
    // So the lede says it could not check, with Try again, instead of an endless "Checking".
    expect(needsState([readStatus({ status: "pending", fetchStatus: "paused" }), "success"])).toBe("unknown");
  });
});

describe("the next appointment's line", () => {
  it("says today or tomorrow, as Next appointments does", () => {
    expect(nextTitle("2026-10-22T15:00:00.000Z", NOW, NEW_YORK)).toBe("Next: today at 11:00 AM");
    expect(nextTitle("2026-10-23T14:30:00.000Z", NOW, NEW_YORK)).toBe("Next: tomorrow at 10:30 AM");
    expect(nextTitle("2026-10-29T15:00:00.000Z", NOW, NEW_YORK)).toBe("Next: Thu, Oct 29 at 11:00 AM");
  });
});

describe("week-on-week change", () => {
  it("groups thousands", () => {
    expect(formatWeekChange(1000)).toBe("1,000%");
    expect(formatWeekChange(-33)).toBe("33%");
  });
});

describe("calendar chips", () => {
  it("colour one calendar the same wherever it shows", () => {
    const resources = [{ id: "a" }, { id: "b" }];
    expect(resourceTone("a", resources)).toBe("accent");
    expect(resourceTone("b", resources)).toBe("neutral");
    expect(resourceTone("a", undefined)).toBe("neutral");
  });
});
