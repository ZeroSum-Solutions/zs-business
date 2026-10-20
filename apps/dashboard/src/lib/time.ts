/** Small time-zone helpers built on Intl. All instants are ISO strings in UTC. */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. */
  weekday: number;
  /** Minutes since local midnight. */
  minute: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

export function zonedParts(instant: Date | string | number, zone: string): ZonedParts {
  const parts = partsFormatter(zone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS[get("weekday")] ?? 1,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function offsetMs(utcMs: number, zone: string): number {
  const p = zonedParts(utcMs, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minute);
  return asUtc - Math.floor(utcMs / 60000) * 60000;
}

const HOUR_MS = 3_600_000;

/** Wall clock of an instant in `zone`, as epoch milliseconds read as if it were UTC (whole minutes). */
function wallMs(utcMs: number, zone: string): number {
  return Math.floor(utcMs / 60000) * 60000 + offsetMs(utcMs, zone);
}

/**
 * Every instant whose wall clock in `zone` reads this date and minute, earliest first: one
 * on an ordinary day, two when clocks fall back across it, none when it falls in a gap.
 * Offsets are sampled 36 hours either side, so at most one transition a day is assumed
 * (true of every tzdb zone).
 */
export function wallTimeInstants(year: number, month: number, day: number, minute: number, zone: string): number[] {
  const wall = Date.UTC(year, month - 1, day, 0, minute);
  const offsets = new Set([offsetMs(wall - 36 * HOUR_MS, zone), offsetMs(wall, zone), offsetMs(wall + 36 * HOUR_MS, zone)]);
  return [...offsets].map((offset) => wall - offset).filter((instant) => wallMs(instant, zone) === wall).sort((a, b) => a - b);
}

/**
 * Convert a local wall-clock date and minute in `zone` to a UTC instant. A time that occurs
 * twice (clocks fall back) gives the earlier one. A time that does not exist (clocks spring
 * forward over it) gives the first instant after the gap, so local midnight in a zone that
 * skips it is the first instant of that date, never the evening before.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, minute: number, zone: string): Date {
  const exact = wallTimeInstants(year, month, day, minute, zone);
  if (exact.length > 0) return new Date(exact[0]!);
  const wall = Date.UTC(year, month - 1, day, 0, minute);
  const before = offsetMs(wall - 36 * HOUR_MS, zone);
  const after = offsetMs(wall + 36 * HOUR_MS, zone);
  // In a gap the wall clock only moves forward: find the first minute it reaches `wall`.
  let lo = Math.floor((wall - Math.max(before, after)) / 60000);
  let hi = Math.ceil((wall - Math.min(before, after)) / 60000);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallMs(mid * 60000, zone) >= wall) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 60000);
}

/** Wall-clock time of an instant in `zone`, ISO 8601 without an offset (the slots `localStart`). */
export function localIso(instant: number, zone: string): string {
  return new Date(instant + offsetMs(instant, zone)).toISOString().slice(0, 19);
}

/** Local calendar date (YYYY-MM-DD) of an instant in `zone`. */
export function zonedDateKey(instant: Date | string | number, zone: string): string {
  const p = zonedParts(instant, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Add whole days to a YYYY-MM-DD key. */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** The first instant of a local date (YYYY-MM-DD) in `zone`: local midnight, or the end of a gap over it. */
export function startOfZonedDay(dateKey: string, zone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(y, m, d, 0, zone);
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD key. */
export function weekdayOf(dateKey: string): number {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * "1:30 PM". When the same wall time happens twice that day (the night clocks fall back),
 * the zone abbreviation or offset is added ("1:30 AM EDT", "1:30 AM EST"), so slots, their
 * accessible names and the confirmation say which of the two they mean.
 */
export function formatTime(instant: string, zone: string): string {
  const date = new Date(instant);
  const p = zonedParts(date, zone);
  const repeated = wallTimeInstants(p.year, p.month, p.day, p.minute, zone).length > 1;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "numeric", minute: "2-digit", ...(repeated ? { timeZoneName: "short" } : {}),
  }).format(date);
}

export function formatDay(instant: string | Date, zone: string, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat("en-US", style === "long"
    ? { timeZone: zone, weekday: "long", month: "long", day: "numeric" }
    : { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(new Date(instant));
}

export function formatDateKey(dateKey: string, style: "short" | "long" = "short"): string {
  return formatDay(`${dateKey}T12:00:00.000Z`, "UTC", style);
}

export interface InstantRange {
  /** Inclusive, epoch ms. */
  from: number;
  /** Exclusive, epoch ms. */
  to: number;
}

/**
 * This week so far and the same span of last week, as inbox-home.md H-3 defines them: this
 * week runs from the local start of the current week to the start of the next; last week from
 * its own local start to the same local moment as `now`, seven days earlier. The demo adapter
 * uses it to count like the API does.
 */
export function weekRanges(now: number, zone: string, weekStart: "monday" | "sunday"): { thisWeek: InstantRange; lastWeek: InstantRange } {
  const today = zonedDateKey(now, zone);
  const weekday = weekdayOf(today);
  const back = weekStart === "monday" ? weekday - 1 : weekday % 7;
  const start = addDays(today, -back);
  const thisFrom = startOfZonedDay(start, zone).getTime();
  const thisTo = startOfZonedDay(addDays(start, 7), zone).getTime();
  const lastFrom = startOfZonedDay(addDays(start, -7), zone).getTime();
  const p = zonedParts(now, zone);
  const [y, m, d] = addDays(today, -7).split("-").map(Number) as [number, number, number];
  // The same wall clock a week ago, to the millisecond (zonedParts is whole minutes).
  const lastTo = zonedTimeToUtc(y, m, d, p.minute, zone).getTime() + (now % 60000 + 60000) % 60000;
  return { thisWeek: { from: thisFrom, to: thisTo }, lastWeek: { from: lastFrom, to: Math.max(lastFrom, lastTo) } };
}

/** A local range in plain words, `to` exclusive: "Mon, Oct 19, 12:00 AM until Mon, Oct 26, 12:00 AM". */
export function formatRange(fromIso: string, toIso: string, zone: string): string {
  return `${formatDay(fromIso, zone)}, ${formatTime(fromIso, zone)} until ${formatDay(toIso, zone)}, ${formatTime(toIso, zone)}`;
}
