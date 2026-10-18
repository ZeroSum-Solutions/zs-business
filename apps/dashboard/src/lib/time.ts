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

/** Convert a local wall-clock date and minute in `zone` to a UTC instant. */
export function zonedTimeToUtc(year: number, month: number, day: number, minute: number, zone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minute);
  const first = guess - offsetMs(guess, zone);
  const second = guess - offsetMs(first, zone);
  return new Date(second);
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

/** UTC instant of local midnight for a YYYY-MM-DD key in `zone`. */
export function startOfZonedDay(dateKey: string, zone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(y, m, d, 0, zone);
}

/** ISO weekday (1 = Monday) of a YYYY-MM-DD key. */
export function weekdayOf(dateKey: string): number {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function formatTime(instant: string, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}

export function formatDay(instant: string | Date, zone: string, style: "short" | "long" = "short"): string {
  return new Intl.DateTimeFormat("en-US", style === "long"
    ? { timeZone: zone, weekday: "long", month: "long", day: "numeric" }
    : { timeZone: zone, weekday: "short", month: "short", day: "numeric" }).format(new Date(instant));
}

export function formatDateKey(dateKey: string, style: "short" | "long" = "short"): string {
  return formatDay(`${dateKey}T12:00:00.000Z`, "UTC", style);
}
