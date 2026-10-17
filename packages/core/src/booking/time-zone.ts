// Time-zone arithmetic for F1 slots. Original code; uses only the runtime's Intl data.
// Instants are UTC epoch milliseconds. A "label" is the local wall clock expressed as
// epoch milliseconds of the same Y-M-D h:m:s read as if it were UTC.

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
const SAMPLE_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", era: "short",
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** Days since 1970-01-01 for a proleptic Gregorian civil date (no Date year quirks). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: era * 400 + yoe + (month <= 2 ? 1 : 0), month, day };
}

/** ISO weekday, 1 = Monday through 7 = Sunday. 1970-01-01 was a Thursday. */
export function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

export function isoDate(days: number): string {
  const { year, month, day } = civilFromDays(days);
  const pad = (value: number, size: number) => String(value).padStart(size, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Zone offset (label minus instant) in effect at the instant, whole seconds. */
export function offsetAt(timeZone: string, instant: number): number {
  const second = Math.floor(instant / 1000) * 1000;
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(second)) parts[part.type] = part.value;
  let year = Number(parts.year);
  if (parts.era === "BC" || parts.era === "B") year = 1 - year;
  const days = daysFromCivil(year, Number(parts.month), Number(parts.day));
  const label = days * DAY_MS +
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return label - second;
}

export interface OffsetSegment {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

/**
 * Split [from,to) into maximal pieces with one constant offset. Offsets are sampled
 * hourly and each change is located to the second, so at most one transition per hour
 * is assumed (true of every tzdb zone).
 */
export function offsetSegments(timeZone: string, from: number, to: number): OffsetSegment[] {
  const segments: OffsetSegment[] = [];
  let start = from;
  let offset = offsetAt(timeZone, from);
  let probe = from;
  while (probe < to) {
    const next = Math.min(probe + SAMPLE_MS, to);
    const sample = next === to ? to - 1 : next;
    const nextOffset = offsetAt(timeZone, sample);
    if (nextOffset !== offset) {
      // Smallest whole second after probe's second whose offset differs.
      let lo = Math.floor(probe / 1000);
      let hi = Math.floor(sample / 1000);
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(timeZone, mid * 1000) === offset) lo = mid;
        else hi = mid;
      }
      const change = Math.min(Math.max(hi * 1000, from), to);
      if (change > start) segments.push({ start, end: change, offset });
      start = change;
      offset = offsetAt(timeZone, change);
      probe = change;
      continue;
    }
    probe = next;
  }
  if (to > start) segments.push({ start, end: to, offset });
  return segments;
}
