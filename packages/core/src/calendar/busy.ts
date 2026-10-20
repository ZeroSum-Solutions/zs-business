// G-7: which Google events are busy time, and when. Original code. Pure: no clock, no I/O.
import { civilFromDays, DAY_MS, daysFromCivil, offsetAt } from "../booking/time-zone.js";
import type { GoogleEvent } from "./types.js";

export interface BusySpan {
  /** UTC epoch milliseconds, inclusive. */
  readonly start: number;
  /** UTC epoch milliseconds, exclusive. */
  readonly end: number;
}

/** Event types that never block time (G-7). */
const FREE_EVENT_TYPES = new Set(["workingLocation", "birthday"]);
/** Year 1 to year 9999: every instant here has a plain ISO form Postgres reads back exactly. */
const MIN_INSTANT = -62135596800000;
const MAX_INSTANT = 253402300800000;
/** RFC 3339 date-time with an explicit offset; anything else would be read in an ambient zone. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|z|[+-](\d{2}):(\d{2}))$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An all-day `date` as days since 1970-01-01, or null when it is not a real calendar date. */
function civilDays(value: string): number | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const days = daysFromCivil(year, month, day);
  const back = civilFromDays(days);
  return back.year === year && back.month === month && back.day === day ? days : null;
}

function instantOf(value: string): number | null {
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const [month, day, hour, minute] = [Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])];
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

/**
 * The instant local midnight starts the given civil day in `timeZone`. When midnight happens
 * twice (a fall-back at midnight) the day starts at the first; when it does not happen at all (a
 * spring-forward over midnight) the day starts at the transition.
 */
export function localMidnight(timeZone: string, days: number): number {
  const label = days * DAY_MS;
  // At most one offset change within a day either side of a midnight (true of every tzdb zone).
  const before = offsetAt(timeZone, label - DAY_MS);
  const after = offsetAt(timeZone, label + DAY_MS);
  const candidates = [...new Set([label - before, label - after])].sort((x, y) => x - y);
  for (const instant of candidates) if (instant + offsetAt(timeZone, instant) === label) return instant;
  // A gap: the old offset's midnight is the instant the clock jumped past it.
  return label - before;
}

/**
 * G-7: the time an event blocks, or null when it blocks nothing. Cancelled, transparent,
 * working-location and birthday events are free, as is an event the calendar's own attendee
 * entry declined, and an event this system pushed (`extendedProperties.private.zs_booking`).
 * A timed event blocks [start, end); an all-day event blocks from midnight of its start date to
 * midnight of its (exclusive) end date in the resource's time zone. Malformed or mixed times,
 * and an end that is not after the start, block nothing.
 */
export function busySpan(event: GoogleEvent, timeZone: string): BusySpan | null {
  if (event.status === "cancelled") return null;
  if (event.transparency === "transparent") return null;
  if (event.eventType !== undefined && FREE_EVENT_TYPES.has(event.eventType)) return null;
  if (event.attendees?.some((attendee) => attendee?.self === true && attendee.responseStatus === "declined")) return null;
  if (event.extendedProperties?.private?.zs_booking !== undefined) return null;
  const start = event.start;
  const end = event.end;
  if (!start || !end) return null;
  let span: BusySpan;
  if (typeof start.dateTime === "string" && typeof end.dateTime === "string") {
    const from = instantOf(start.dateTime);
    const to = instantOf(end.dateTime);
    if (from === null || to === null) return null;
    span = { start: from, end: to };
  } else if (start.dateTime === undefined && end.dateTime === undefined
    && typeof start.date === "string" && typeof end.date === "string") {
    const from = civilDays(start.date);
    const to = civilDays(end.date);
    if (from === null || to === null) return null;
    span = { start: localMidnight(timeZone, from), end: localMidnight(timeZone, to) };
  } else return null;
  if (!(span.end > span.start) || span.start < MIN_INSTANT || span.end > MAX_INSTANT) return null;
  return span;
}
