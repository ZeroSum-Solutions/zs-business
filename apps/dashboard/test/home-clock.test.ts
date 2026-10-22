import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMinute, subscribeMinute } from "../src/components/home/home-model";

describe("Home's minute clock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("notifies at each minute boundary, so an idle Home rolls over at midnight", () => {
    vi.setSystemTime(new Date("2026-10-21T23:59:30.000"));
    const onChange = vi.fn();
    const unsubscribe = subscribeMinute(onChange);
    vi.advanceTimersByTime(29_999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(new Date(currentMinute()).getDate()).toBe(22);
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    vi.advanceTimersByTime(5 * 60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
