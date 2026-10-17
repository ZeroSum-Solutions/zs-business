// F1 slot engine (B-5..B-16). Original code written from docs/requirements/booking.md;
// no cal.diy code is ported. All instants are UTC epoch milliseconds.
import {
  getAvailableSlotsInputSchema,
  ValidationFailed,
  type BookingResource,
  type GetAvailableSlots,
  type LocalAvailabilityWindow,
} from "@zs/contracts";
import { DAY_MS, MINUTE_MS, isoDate, isoWeekday, offsetSegments } from "./time-zone.js";

export interface Span {
  readonly start: number;
  readonly end: number;
}

/** Sort a copy and join overlapping or touching spans (B-5, B-13 union semantics). */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/** Index of the last span whose start is <= value, or -1. Spans are sorted and disjoint. */
function lastStartingAtOrBefore(spans: readonly Span[], value: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.start <= value) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

function overlapsAny(spans: readonly Span[], start: number, end: number): boolean {
  // The only candidate is the last span starting before `end` (spans are disjoint).
  const index = lastStartingAtOrBefore(spans, end - 1);
  return index >= 0 && spans[index]!.end > start;
}

export interface SlotRules {
  readonly timeZone: string;
  readonly weekly: ReadonlyMap<number, readonly Span[]>;
  readonly overrides: ReadonlyMap<string, readonly Span[]>;
  readonly slotLengthMinutes: number;
  readonly slotStepMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly minimumNoticeMinutes: number;
  readonly bookingHorizonMinutes: number;
}

const minuteSpans = (windows: readonly LocalAvailabilityWindow[]) =>
  mergeSpans(windows.map((window) => ({ start: window.startMinute, end: window.endMinute })));

/** Compile a schema-validated resource; duplicates were already rejected by the schema (B-6). */
export function compileRules(resource: BookingResource): SlotRules {
  return {
    timeZone: resource.timeZone,
    weekly: new Map(resource.weekly.map((rule) => [rule.weekday, minuteSpans(rule.windows)])),
    overrides: new Map(resource.overrides.map((rule) => [rule.date, minuteSpans(rule.windows)])),
    slotLengthMinutes: resource.slotLengthMinutes,
    slotStepMinutes: resource.slotStepMinutes,
    bufferBeforeMinutes: resource.bufferBeforeMinutes,
    bufferAfterMinutes: resource.bufferAfterMinutes,
    minimumNoticeMinutes: resource.minimumNoticeMinutes,
    bookingHorizonMinutes: resource.bookingHorizonMinutes,
  };
}

/** Effective local windows (minutes) for a local date given as days since epoch (B-5/B-6). */
function windowsOn(rules: SlotRules, days: number): readonly Span[] {
  return rules.overrides.get(isoDate(days)) ?? rules.weekly.get(isoWeekday(days)) ?? [];
}

/**
 * Starts of every bookable slot whose appointment lies inside [from,to), sorted and unique.
 * `busy` holds already-expanded occupied spans; they are merged here, never re-buffered.
 */
export function evaluateSlots(rules: SlotRules, from: number, to: number, busy: readonly Span[], now: number): number[] {
  const length = rules.slotLengthMinutes * MINUTE_MS;
  const earliest = Math.max(from, now + rules.minimumNoticeMinutes * MINUTE_MS); // B-11 inclusive
  const horizon = now + rules.bookingHorizonMinutes * MINUTE_MS; // B-12 exclusive
  if (earliest >= to || earliest >= horizon) return [];

  // B-7: availability is wall-clock membership mapped through each constant-offset piece.
  const available: Span[] = [];
  const candidates = new Set<number>();
  const step = rules.slotStepMinutes;
  for (const segment of offsetSegments(rules.timeZone, earliest, to)) {
    const firstDay = Math.floor((segment.start + segment.offset) / DAY_MS);
    const lastDay = Math.floor((segment.end - 1 + segment.offset) / DAY_MS);
    for (let day = firstDay; day <= lastDay; day++) {
      const midnight = day * DAY_MS - segment.offset;
      for (const window of windowsOn(rules, day)) {
        const start = Math.max(midnight + window.start * MINUTE_MS, segment.start);
        const end = Math.min(midnight + window.end * MINUTE_MS, segment.end);
        if (start < end) available.push({ start, end });
        // B-8: grid on local minute-of-day, reset each local date.
        for (let minute = Math.ceil(window.start / step) * step; minute < window.end; minute += step) {
          const instant = midnight + minute * MINUTE_MS;
          if (instant >= segment.start && instant < segment.end) candidates.add(instant);
        }
      }
    }
  }
  const availability = mergeSpans(available);
  const occupied = mergeSpans(busy);
  const before = rules.bufferBeforeMinutes * MINUTE_MS;
  const after = rules.bufferAfterMinutes * MINUTE_MS;
  return [...candidates].sort((a, b) => a - b).filter((start) => {
    const end = start + length;
    if (start < earliest || start >= horizon || end > to) return false; // B-10/B-11/B-12
    const container = availability[lastStartingAtOrBefore(availability, start)];
    if (!container || container.end < end) return false; // B-9 whole interval available
    return !overlapsAny(occupied, start - before, end + after); // B-14 touching allowed
  });
}

const iso = (instant: number) => new Date(instant).toISOString();

export function readClock(clock: { now(): Date }): number {
  const value: unknown = clock.now();
  const instant = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(instant)) throw new ValidationFailed("Clock returned an invalid instant");
  return instant;
}

export const getAvailableSlots: GetAvailableSlots = (input, deps) => {
  const parsed = getAvailableSlotsInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationFailed(parsed.error.message);
  const now = readClock(deps.clock);
  const { resource, range } = parsed.data;
  const busy = parsed.data.busy.map((entry) => entry.kind === "booking"
    ? {
      start: Date.parse(entry.startsAt) - entry.bufferBeforeMinutes * MINUTE_MS,
      end: Date.parse(entry.endsAt) + entry.bufferAfterMinutes * MINUTE_MS,
    }
    : { start: Date.parse(entry.startsAt), end: Date.parse(entry.endsAt) });
  const rules = compileRules(resource);
  const length = rules.slotLengthMinutes * MINUTE_MS;
  const starts = evaluateSlots(rules, Date.parse(range.startsAt), Date.parse(range.endsAt), busy, now);
  return {
    resourceId: resource.id,
    timeZone: resource.timeZone,
    slots: starts.map((start) => ({ startsAt: iso(start), endsAt: iso(start + length) })),
  };
};
