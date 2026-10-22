import { describe, expect, it } from "vitest";
import { needsLine, needsState } from "../src/components/home/home-model";

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
