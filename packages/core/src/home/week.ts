// Week ranges for Home (inbox-home.md H-3). Original code. Pure: the caller passes the instant
// it read from the injected clock, so results never depend on the host's date.
import type { WeekStart } from "@zs/contracts";
import { DAY_MS, isoWeekday, offsetAt, offsetSegments } from "../booking/time-zone.js";

export interface Range {
  readonly from: number;
  readonly to: number;
}

/**
 * The first instant whose wall clock in `zone` reads `label` or later: the instant itself when
 * the label exists, the earlier one when clocks fall back over it, and the moment clocks jump
 * when it falls in a spring-forward gap.
 */
export function firstInstantAtOrAfter(zone: string, label: number): number {
  for (const segment of offsetSegments(zone, label - 2 * DAY_MS, label + 2 * DAY_MS)) {
    if (segment.end + segment.offset > label) return Math.max(segment.start, label - segment.offset);
  }
  throw new RangeError(`No instant near label ${label} in ${zone}`);
}

/**
 * This week runs from local midnight of the week's first day to the next week's; nothing after
 * `now` exists yet, so it holds the week so far, including writes stamped at `now` itself.
 * Last week runs from its own first local midnight to the same wall-clock moment as `now`, seven
 * local days earlier, so both cover the same span and a DST change between them does not
 * shift it.
 */
export function weekRanges(now: number, zone: string, weekStart: WeekStart): { thisWeek: Range; lastWeek: Range } {
  const label = now + offsetAt(zone, now);
  const day = Math.floor(label / DAY_MS);
  const weekday = isoWeekday(day);
  const startDay = day - (weekStart === "monday" ? weekday - 1 : weekday % 7);
  const weekLabel = startDay * DAY_MS;
  return {
    thisWeek: { from: firstInstantAtOrAfter(zone, weekLabel), to: firstInstantAtOrAfter(zone, weekLabel + 7 * DAY_MS) },
    lastWeek: {
      from: firstInstantAtOrAfter(zone, weekLabel - 7 * DAY_MS),
      to: firstInstantAtOrAfter(zone, label - 7 * DAY_MS),
    },
  };
}
