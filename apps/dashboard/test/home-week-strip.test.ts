import { describe, expect, it } from "vitest";
import type { BookingView } from "../src/lib/api";
import { appointmentsPhrase, weekStripDays, weekStripQuery } from "../src/components/home/home-model";

const ZONE = "America/New_York";
const DAYS = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
const at = (startsAt: string) => ({ startsAt }) as BookingView;

describe("Home's week strip", () => {
  it("reads the whole week, paging past one request, instead of the first 100", () => {
    const query = weekStripQuery("2026-10-19", ZONE);
    expect(query).toEqual({ from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" });
    expect(query).not.toHaveProperty("limit");
  });

  it("counts exactly when the list is complete", () => {
    const days = weekStripDays({ items: [at("2026-10-20T14:00:00Z"), at("2026-10-20T15:00:00Z")], incomplete: false, loaded: 2 }, DAYS, ZONE);
    expect(days[1]).toEqual({ key: "2026-10-20", count: 2, known: "exact" });
    expect(days.every((day) => day.known === "exact")).toBe(true);
    expect(appointmentsPhrase(days[1]!)).toBe(", 2 appointments");
    expect(appointmentsPhrase(days[0]!)).toBe("");
  });

  it("says 'at least' on the day a capped list stopped and 'not checked' after it", () => {
    const list = { items: [at("2026-10-19T14:00:00Z"), at("2026-10-21T14:00:00Z"), at("2026-10-21T15:00:00Z")], incomplete: true, loaded: 3 };
    const days = weekStripDays(list, DAYS, ZONE);
    expect(days.map((day) => day.known)).toEqual(["exact", "exact", "atLeast", "unknown", "unknown", "unknown", "unknown"]);
    expect(appointmentsPhrase(days[2]!)).toBe(", 2+ appointments");
    expect(appointmentsPhrase(days[4]!)).toBe(", appointments not checked");
  });
});
