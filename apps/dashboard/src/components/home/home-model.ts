import type { BookingListQuery, BookingView, ListResult } from "@/lib/api";
import { addDays, formatDateKey, startOfZonedDay, zonedDateKey } from "@/lib/time";

/** Home's pure parts: what the screen decides, apart from how it draws it. */

export type QueryStatus = "pending" | "error" | "success";
export type NeedsState = "checking" | "unknown" | "settled";

/**
 * Whether the "needs you" count can be told: only once every read it counts has succeeded.
 * A failed read leaves it unknown, even while others still load: waiting will not fix it.
 */
export function needsState(statuses: QueryStatus[]): NeedsState {
  if (statuses.includes("error")) return "unknown";
  return statuses.includes("pending") ? "checking" : "settled";
}

/** Home's lede after the greeting, or nothing while the count is still coming in. */
export function needsLine(state: NeedsState, count: number): string | null {
  if (state === "checking") return null;
  if (state === "unknown") return "Couldn't check everything.";
  return count === 0 ? "Nothing needs you right now." : `${count === 1 ? "One thing needs" : `${count === 2 ? "Two" : "Three"} things need`} you today.`;
}

/** "Later today", "Tomorrow" or the weekday, for a day group of appointments. */
export function dayHeading(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Later today";
  if (dayKey === addDays(todayKey, 1)) return "Tomorrow";
  return formatDateKey(dayKey, "long").split(",")[0] ?? dayKey;
}

export interface DayGroup<T> {
  key: string;
  heading: string;
  items: T[];
}

/** Appointments in start order, grouped by local day under a "Later today" / "Tomorrow" heading. */
export function groupByDay<T extends { startsAt: string }>(items: T[], now: string | number, zone: string, zoneOf: (item: T) => string): DayGroup<T>[] {
  const todayKey = zonedDateKey(now, zone);
  const days: DayGroup<T>[] = [];
  for (const item of items) {
    const key = zonedDateKey(item.startsAt, zoneOf(item));
    const last = days.at(-1);
    if (last?.key === key) last.items.push(item);
    else days.push({ key, heading: dayHeading(key, todayKey), items: [item] });
  }
  return days;
}

/** Subscribes `onChange` to the wall clock's minute; returns the unsubscribe. */
export function subscribeMinute(_onChange: () => void): () => void {
  return () => {};
}

/** The current minute, as epoch ms. */
export function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

/** Monday to Sunday of the week holding `today`, read as one range of bookings. */
export function weekStripQuery(monday: string, zone: string): BookingListQuery {
  return {
    from: startOfZonedDay(monday, zone).toISOString(),
    to: startOfZonedDay(addDays(monday, 7), zone).toISOString(),
    limit: 100,
  };
}

export interface StripDay {
  key: string;
  count: number;
  /** `exact`: every booking that day is counted. `atLeast`: the list stopped during the day. `unknown`: it stopped before. */
  known: "exact" | "atLeast" | "unknown";
}

/** Bookings per local day of the week strip. */
export function weekStripDays(list: ListResult<BookingView>, days: string[], zone: string): StripDay[] {
  const counts = new Map<string, number>();
  for (const booking of list.items) {
    const key = zonedDateKey(booking.startsAt, zone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return days.map((key) => ({ key, count: counts.get(key) ?? 0, known: "exact" }));
}

/** ", 3 appointments" for a day's accessible name; nothing on a day with none. */
export function appointmentsPhrase(day: StripDay): string {
  return day.count > 0 ? `, ${day.count} appointment${day.count === 1 ? "" : "s"}` : "";
}
