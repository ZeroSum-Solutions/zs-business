// Outreach holiday calendar (outreach-sequencer.md OS-11): the US federal holidays plus the day after Thanksgiving, as
// pure functions of a local `YYYY-MM-DD` date. Nothing here reads a clock or a table: every date is computed from the
// year by the rules below, so no year needs a hand-kept list.
import { civilFromDays, daysFromCivil, isoDate, isoWeekday } from "../booking/time-zone.js";

const MONDAY = 1;
const THURSDAY = 4;
const SATURDAY = 6;
const SUNDAY = 7;

/** Days since 1970-01-01 of the `n`th (1-based) `weekday` (ISO, Monday = 1) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = daysFromCivil(year, month, 1);
  return first + ((weekday - isoWeekday(first) + 7) % 7) + (n - 1) * 7;
}

/** Days since 1970-01-01 of the last `weekday` of a month. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = daysFromCivil(year, month + 1, 1) - 1;
  return last - ((isoWeekday(last) - weekday + 7) % 7);
}

/** A fixed-date holiday as observed: a Saturday holiday is kept on Friday, a Sunday holiday on Monday (5 U.S.C. 6103(b)). */
function observed(year: number, month: number, day: number): number {
  const days = daysFromCivil(year, month, day);
  const weekday = isoWeekday(days);
  if (weekday === SATURDAY) return days - 1;
  if (weekday === SUNDAY) return days + 1;
  return days;
}

/**
 * The days since 1970-01-01 of every outreach holiday that falls in calendar year `year`, observed dates included. A
 * holiday of the next year can be observed in this one (1 January on a Saturday is observed on 31 December).
 * Federal holidays: New Year's Day, Martin Luther King Jr. Day (third Monday of January), Washington's Birthday (third
 * Monday of February), Memorial Day (last Monday of May), Juneteenth (19 June), Independence Day (4 July), Labor Day
 * (first Monday of September), Columbus Day (second Monday of October), Veterans Day (11 November), Thanksgiving (fourth
 * Thursday of November) and Christmas Day (25 December). Added: the day after Thanksgiving.
 * Inauguration Day is left out: it is a holiday for the Washington, DC area only.
 */
function holidayDays(year: number): ReadonlySet<number> {
  const thanksgiving = nthWeekday(year, 11, THURSDAY, 4);
  const days = [
    observed(year, 1, 1),
    observed(year + 1, 1, 1),
    nthWeekday(year, 1, MONDAY, 3),
    nthWeekday(year, 2, MONDAY, 3),
    lastWeekday(year, 5, MONDAY),
    observed(year, 6, 19),
    observed(year, 7, 4),
    nthWeekday(year, 9, MONDAY, 1),
    nthWeekday(year, 10, MONDAY, 2),
    observed(year, 11, 11),
    thanksgiving,
    thanksgiving + 1,
    observed(year, 12, 25),
  ];
  return new Set(days.filter((day) => civilFromDays(day).year === year));
}

const cache = new Map<number, ReadonlySet<number>>();
function holidaysOf(year: number): ReadonlySet<number> {
  let found = cache.get(year);
  if (found === undefined) {
    found = holidayDays(year);
    cache.set(year, found);
  }
  return found;
}

/** Whether `days` (since 1970-01-01, a local date) is a US federal holiday, an observed one, or the day after Thanksgiving. */
export function isHolidayDays(days: number): boolean {
  return holidaysOf(civilFromDays(days).year).has(days);
}

/** The outreach holidays of `year` as `YYYY-MM-DD` dates, in order (for tests and documentation). */
export function holidayDates(year: number): string[] {
  return [...holidaysOf(year)].sort((a, b) => a - b).map(isoDate);
}
