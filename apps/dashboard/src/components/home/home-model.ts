import type { BookingListQuery, BookingView, ListResult } from "@/lib/api";
import { addDays, formatDateKey, formatDay, formatTime, startOfZonedDay, zonedDateKey } from "@/lib/time";
import { formatMoney, formatNumber } from "@/lib/utils";

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

/**
 * A read's status as Home counts it. Offline, React Query pauses a read that has nothing cached:
 * it stays "pending" with no answer coming, so it counts as failed and Home says it could not check.
 */
export function readStatus(query: { status: QueryStatus; fetchStatus: "fetching" | "paused" | "idle" }): QueryStatus {
  return query.status === "pending" && query.fetchStatus === "paused" ? "error" : query.status;
}

/** Home's lede after the greeting, or nothing while the count is still coming in. */
export function needsLine(state: NeedsState, count: number): string | null {
  if (state === "checking") return null;
  if (state === "unknown") return "Couldn't check everything.";
  return count === 0 ? "Nothing needs you right now." : `${count === 1 ? "One thing needs" : `${count === 2 ? "Two" : "Three"} things need`} you today.`;
}

export interface NeedsInput<A, B> {
  /** Threads waiting for a reply or a review, on the inbox's first page. */
  waiting: number;
  /** The status of every read the count rests on. */
  statuses: QueryStatus[];
  checklist: A[] | undefined;
  threads: { name: string; needsReply: boolean; needsReview: boolean }[] | undefined;
  /** The next appointments, in start order. */
  bookings: B[] | undefined;
  /** The live clock: what "today" is, apart from when the bookings were read. */
  now: string | number;
  /** The display zone: Next appointments reads days and times in it too, so they agree. */
  zone: string;
}

/** Who and what needs the owner now: Home's lede counts the same items as the tray shows. */
export function needsModel<A extends { status: string }, B extends { startsAt: string }>(input: NeedsInput<A, B>) {
  const { zone } = input;
  const next = input.bookings?.[0];
  const actions = input.checklist?.filter((item) => item.status === "action") ?? [];
  const people = input.threads?.filter((thread) => thread.needsReply || thread.needsReview).map((thread) => thread.name) ?? [];
  const nextToday = next ? zonedDateKey(next.startsAt, zone) === zonedDateKey(input.now, zone) : false;
  const count = (input.waiting > 0 ? 1 : 0) + (actions.length > 0 ? 1 : 0) + (nextToday ? 1 : 0);
  return { next, zone, actions, people, state: needsState(input.statuses), count };
}

/** "Next: today at 11:00 AM": the same day words as Next appointments, in the display zone. */
export function nextTitle(startsAt: string, now: string | number, zone: string): string {
  const today = zonedDateKey(now, zone);
  const day = zonedDateKey(startsAt, zone);
  const when = day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : formatDay(startsAt, zone);
  return `Next: ${when} at ${formatTime(startsAt, zone)}`;
}

/** A week-on-week change as the tile shows it, beside an arrow that gives the direction. */
export function formatWeekChange(percent: number): string {
  return `${formatNumber(Math.abs(percent))}%`;
}

/** One chip colour per calendar on Home: the first calendar is the accent, the rest neutral. */
export function resourceTone(resourceId: string, resources: { id: string }[] | undefined): "accent" | "neutral" {
  return resources?.[0]?.id === resourceId ? "accent" : "neutral";
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

/**
 * Appointments grouped by local day under a "Later today" / "Tomorrow" heading. Days, headings
 * and today are all read in the one display zone, so calendars in other zones never split a
 * day in two or call tomorrow today. One group per day, in the order the days first appear.
 */
export function groupByDay<T extends { startsAt: string }>(items: T[], now: string | number, zone: string): DayGroup<T>[] {
  const todayKey = zonedDateKey(now, zone);
  const days = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const key = zonedDateKey(item.startsAt, zone);
    const day = days.get(key);
    if (day) day.items.push(item);
    else days.set(key, { key, heading: dayHeading(key, todayKey), items: [item] });
  }
  return [...days.values()];
}

/**
 * Calls `onChange` at each minute boundary of the wall clock, so an idle Home rolls its date
 * and week over at midnight. The timer is re-armed from the clock each time, so it never
 * drifts; the returned function stops it.
 */
export function subscribeMinute(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      arm();
      onChange();
    }, 60_000 - (Date.now() % 60_000));
  };
  arm();
  return () => clearTimeout(timer);
}

/**
 * When Home reads its next appointments from. It stays put while the minute clock ticks, so the
 * read is not repeated every minute, and moves to `now` once the display zone's day changes.
 */
export function nextCutoff(cutoff: string, now: number | null, zone: string): string {
  if (now === null || zonedDateKey(now, zone) === zonedDateKey(cutoff, zone)) return cutoff;
  return new Date(now).toISOString();
}

/** The current minute, as epoch ms. */
export function currentMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

/**
 * Monday to Sunday from `monday`, as one range of bookings. No `limit`: the client pages through
 * the whole week by cursor and flags the list incomplete only if it reaches its page cap.
 */
export function weekStripQuery(monday: string, zone: string): BookingListQuery {
  return {
    from: startOfZonedDay(monday, zone).toISOString(),
    to: startOfZonedDay(addDays(monday, 7), zone).toISOString(),
  };
}

export interface StripDay {
  key: string;
  count: number;
  /** `exact`: every booking that day is counted. `atLeast`: the list stopped during the day. `unknown`: it stopped before. */
  known: "exact" | "atLeast" | "unknown";
}

/**
 * Bookings per local day of the week strip. The list comes in start order, so when it stopped
 * early, days before its last booking are whole, that day is a floor and later days are unread.
 */
export function weekStripDays(list: ListResult<BookingView>, days: string[], zone: string): StripDay[] {
  const counts = new Map<string, number>();
  for (const booking of list.items) {
    const key = zonedDateKey(booking.startsAt, zone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lastBooking = list.items.at(-1);
  const lastKey = list.incomplete ? (lastBooking ? zonedDateKey(lastBooking.startsAt, zone) : "") : null;
  return days.map((key) => ({
    key,
    count: counts.get(key) ?? 0,
    known: lastKey === null || key < lastKey ? "exact" : key === lastKey ? "atLeast" : "unknown",
  }));
}

/** ", 3 appointments" for a day's accessible name; nothing on a day with none. */
export function appointmentsPhrase(day: StripDay): string {
  if (day.known === "unknown") return ", appointments not checked";
  if (day.count === 0) return "";
  return `, ${day.count}${day.known === "atLeast" ? "+" : ""} appointment${day.count === 1 && day.known === "exact" ? "" : "s"}`;
}

/**
 * The wallet's caption (delivery.md D-5): a send waits whenever the balance cannot cover its
 * price, not only at zero, and after the attempt cap it fails instead of overdrawing.
 */
export function walletCaption(topUp: number, currency: string): string {
  return `Of your ${formatMoney(topUp, currency)} top-up. Prepaid, so no surprise bills: a message the balance can't cover waits for a top-up, and fails if none comes in time.`;
}
