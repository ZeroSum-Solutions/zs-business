import { describe, expect, it } from "vitest";
import { needsLine, needsModel, needsState } from "../src/components/home/home-model";

describe("Home's needs-you count", () => {
  it("is still checking while any read it counts is loading", () => {
    expect(needsState(["success", "pending", "success", "success", "success"])).toBe("checking");
    expect(needsLine("checking", 0)).toBeNull();
  });

  it("is settled only when every read it counts succeeded", () => {
    expect(needsState(["success", "success", "success", "success", "success"])).toBe("settled");
    expect(needsLine("settled", 0)).toBe("Nothing needs you right now.");
    expect(needsLine("settled", 2)).toBe("Two things need you today.");
  });

  it("never says nothing needs you after a read failed", () => {
    // The inbox read failed; the others came back empty.
    const state = needsState(["error", "success", "success", "success", "success"]);
    expect(state).toBe("unknown");
    expect(needsLine(state, 0)).toBe("Couldn't check everything.");
    // A failure wins over a read still loading: waiting will not fix it.
    expect(needsState(["pending", "error", "success", "success", "success"])).toBe("unknown");
  });
});

const NEW_YORK = "America/New_York";

/** Nothing but the next appointment counts, so the count says whether it is "today". */
const quiet = { waiting: 0, statuses: ["success" as const], checklist: [], threads: [] };

describe("Home's next appointment in the needs-you count", () => {
  it("reads the summary time and today in the display zone, not the booking calendar's", () => {
    // 10:00 PM Wednesday Oct 21 in New York, already Thursday in Tokyo.
    const now = "2026-10-22T02:00:00.000Z";
    // A Tokyo calendar's booking at 2:00 AM Thursday in New York, 3:00 PM Thursday in Tokyo.
    const next = { startsAt: "2026-10-22T06:00:00.000Z" };
    const model = needsModel({ ...quiet, bookings: [next], from: now, zone: NEW_YORK });
    expect(model.zone).toBe(NEW_YORK);
    // Tomorrow in New York, where Next appointments shows it: not one of today's needs.
    expect(model.count).toBe(0);
  });
});
