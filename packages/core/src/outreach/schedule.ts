// Outreach schedule (outreach-sequencer.md OS-11, OS-12): local dates, business days, the send window and the warm-up
// ramp. Everything is a pure function of an instant the caller read from the injected clock and a time zone name.
import { civilFromDays, DAY_MS, daysFromCivil, isoDate, isoWeekday, MINUTE_MS, offsetAt } from "../booking/time-zone.js";

export interface LocalMoment {
  /** `YYYY-MM-DD` in the tenant's zone. */
  readonly date: string;
  /** Days since 1970-01-01 of that local date. */
  readonly days: number;
  /** Minutes since local midnight, 0..1439. */
  readonly minutes: number;
}

/** The local date and wall-clock minute of an instant. */
export function localMoment(timeZone: string, instantMs: number): LocalMoment {
  const label = instantMs + offsetAt(timeZone, instantMs);
  const days = Math.floor(label / DAY_MS);
  return { date: isoDate(days), days, minutes: Math.floor((label - days * DAY_MS) / MINUTE_MS) };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Days since 1970-01-01 of a `YYYY-MM-DD` date; throws on anything else. */
export function dateToDays(date: string): number {
  const match = DATE.exec(date);
  if (!match) throw new RangeError(`Expected YYYY-MM-DD, got ${date}`);
  const days = daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
  const back = civilFromDays(days);
  if (back.year !== Number(match[1]) || back.month !== Number(match[2]) || back.day !== Number(match[3])) throw new RangeError(`Not a calendar date: ${date}`);
  return days;
}

/** Monday to Friday (OS-11). */
export const isBusinessDay = (date: string): boolean => isoWeekday(dateToDays(date)) <= 5;

/** D plus `count` business days: Friday + 1 is Monday; Wednesday + 3 is Monday. A weekend start counts from the next weekday. */
export function addBusinessDays(date: string, count: number): string {
  if (!Number.isInteger(count) || count < 0) throw new RangeError("Expected a whole number of business days of at least 0");
  let days = dateToDays(date);
  for (let left = count; left > 0; left -= 1) {
    days += 1;
    while (isoWeekday(days) > 5) days += 1;
  }
  return isoDate(days);
}

/** `HH:MM` as minutes after midnight. */
export function clockMinutes(clock: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) throw new RangeError(`Expected HH:MM, got ${clock}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The window is `[start, end)`: 10:30 exactly is outside a window that ends at 10:30. */
export const inWindow = (minutes: number, startMin: number, endMin: number): boolean => minutes >= startMin && minutes < endMin;

/**
 * OS-11: whether a send may start now. Today must be a business day and now in the window; a prospect is due when its
 * `next_due_on` is today or earlier.
 */
export function mayStartSend(input: { readonly timeZone: string; readonly nowMs: number; readonly windowStartMin: number; readonly windowEndMin: number }): boolean {
  const local = localMoment(input.timeZone, input.nowMs);
  return isBusinessDay(local.date) && inWindow(local.minutes, input.windowStartMin, input.windowEndMin);
}

export const isDue = (nextDueOn: string, today: string): boolean => nextDueOn <= today;

/** The first instant of the local day after the one `instantMs` falls in. */
export function nextLocalMidnight(timeZone: string, instantMs: number): number {
  const local = localMoment(timeZone, instantMs);
  const label = (local.days + 1) * DAY_MS;
  const guess = label - offsetAt(timeZone, label);
  return label - offsetAt(timeZone, guess);
}

export interface WarmupRamp {
  /** The cap on the first send day. */
  readonly start: number;
  /** How much the cap rises each period. */
  readonly step: number;
  /** Days in a period. */
  readonly periodDays: number;
}
/** OS-12: 5 on the first send day, 5 more every 7 days. */
export const DEFAULT_WARMUP: WarmupRamp = Object.freeze({ start: 5, step: 5, periodDays: 7 });

/**
 * OS-12: the most a mailbox may send on `today`, given the date of its first send, the cap it ramps toward and the
 * ramp. `min(cap, start + step * floor(days / periodDays))` with `days` whole local days from `firstSendDate` to
 * `today`. A `today` before the first send date is a caller error.
 */
export function warmupCap(firstSendDate: string, today: string, cap: number, ramp: WarmupRamp = DEFAULT_WARMUP): number {
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError("The cap must be a whole number of at least 1");
  if (!Number.isInteger(ramp.start) || ramp.start < 1 || !Number.isInteger(ramp.step) || ramp.step < 0 || !Number.isInteger(ramp.periodDays) || ramp.periodDays < 1)
    throw new RangeError("Invalid warm-up ramp");
  const days = dateToDays(today) - dateToDays(firstSendDate);
  if (days < 0) throw new RangeError("Today is before the first send date");
  return Math.min(cap, ramp.start + ramp.step * Math.floor(days / ramp.periodDays));
}
