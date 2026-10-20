import { describe, expect, it } from "vitest";
import { forEachLimited } from "../src/sites/limit.js";

describe("forEachLimited", () => {
  it("runs every item with at most the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimited(Array.from({ length: 40 }, (_, index) => index), 12, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      done.push(item);
    });
    expect(peak).toBe(12);
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index));
  });

  it("rejects with the first error", async () => {
    await expect(forEachLimited([1, 2, 3], 2, async (item) => { if (item === 2) throw new Error("two"); })).rejects.toThrow("two");
  });
});
