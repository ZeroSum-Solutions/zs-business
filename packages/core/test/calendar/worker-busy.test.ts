// G-7 busy rules: a pure function, no database.
import { describe, expect, it } from "vitest";
import { busySpan, localMidnight, type GoogleEvent } from "../../src/index.js";
import { daysFromCivil } from "../../src/booking/time-zone.js";

const ms = (iso: string) => Date.parse(iso);
const timed = (extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: "evt1",
  start: { dateTime: "2026-10-21T10:00:00-04:00" },
  end: { dateTime: "2026-10-21T11:30:00-04:00" },
  ...extra,
});
const allDay = (start: string, end: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: "evt2", start: { date: start }, end: { date: end }, ...extra,
});
const NY = "America/New_York";

describe("busySpan (G-7)", () => {
  it("a timed event blocks [start, end) whatever offset it is written in", () => {
    expect(busySpan(timed(), NY)).toEqual({ start: ms("2026-10-21T14:00:00Z"), end: ms("2026-10-21T15:30:00Z") });
    expect(busySpan(timed({ start: { dateTime: "2026-10-21T14:00:00Z" }, end: { dateTime: "2026-10-21T14:45:00.500Z" } }), "UTC"))
      .toEqual({ start: ms("2026-10-21T14:00:00Z"), end: ms("2026-10-21T14:45:00.500Z") });
    // Explicit status, opaque transparency, a busy event type and an accepting self count as busy.
    expect(busySpan(timed({ status: "confirmed", transparency: "opaque", eventType: "outOfOffice",
      attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "declined" }] }), NY)).not.toBeNull();
    expect(busySpan(timed({ status: "tentative", eventType: "default" }), NY)).not.toBeNull();
  });

  it("cancelled, transparent, workingLocation and birthday events are free", () => {
    expect(busySpan(timed({ status: "cancelled" }), NY)).toBeNull();
    expect(busySpan(timed({ transparency: "transparent" }), NY)).toBeNull();
    expect(busySpan(timed({ eventType: "workingLocation" }), NY)).toBeNull();
    expect(busySpan(allDay("2026-10-21", "2026-10-22", { eventType: "birthday" }), NY)).toBeNull();
  });

  it("an event the calendar's own attendee declined is free; another attendee declining is not", () => {
    expect(busySpan(timed({ attendees: [{ self: true, responseStatus: "declined" }] }), NY)).toBeNull();
    expect(busySpan(timed({ attendees: [{ self: false, responseStatus: "declined" }, { self: true, responseStatus: "needsAction" }] }), NY))
      .not.toBeNull();
  });

  it("events this system pushed never block", () => {
    expect(busySpan(timed({ extendedProperties: { private: { zs_booking: "b", zs_tenant: "t" } } }), NY)).toBeNull();
    expect(busySpan(timed({ extendedProperties: { private: { other: "x" } } }), NY)).not.toBeNull();
  });

  it("an all-day event blocks midnight to midnight in the resource's zone, across DST", () => {
    // EDT to EST: the weekend of 2026-11-01 is 49 hours long in New York.
    expect(busySpan(allDay("2026-10-31", "2026-11-02"), NY))
      .toEqual({ start: ms("2026-10-31T04:00:00Z"), end: ms("2026-11-02T05:00:00Z") });
    // EST to EDT: 2026-03-08 is 23 hours long.
    expect(busySpan(allDay("2026-03-08", "2026-03-09"), NY))
      .toEqual({ start: ms("2026-03-08T05:00:00Z"), end: ms("2026-03-09T04:00:00Z") });
    expect(busySpan(allDay("2026-10-21", "2026-10-22"), "UTC"))
      .toEqual({ start: ms("2026-10-21T00:00:00Z"), end: ms("2026-10-22T00:00:00Z") });
  });

  it("a day whose midnight is skipped starts at the transition", () => {
    // Santiago springs forward over midnight: 2026-09-06 begins at 01:00 local (-03), 04:00Z.
    expect(localMidnight("America/Santiago", daysFromCivil(2026, 9, 6))).toBe(ms("2026-09-06T04:00:00Z"));
    expect(localMidnight("America/Santiago", daysFromCivil(2026, 9, 5))).toBe(ms("2026-09-05T04:00:00Z"));
  });

  it("malformed or mixed times block nothing", () => {
    const { start: _start, ...noStart } = timed();
    const { end: _end, ...noEnd } = timed();
    expect(busySpan(noStart, NY)).toBeNull();
    expect(busySpan(noEnd, NY)).toBeNull();
    const bad: Array<Partial<GoogleEvent>> = [
      { start: { dateTime: "2026-10-21T10:00:00" } }, // no offset: would read in an ambient zone
      { start: { dateTime: "tomorrow" } },
      { start: { dateTime: "2026-13-21T10:00:00Z" } },
      { start: { dateTime: "2026-10-21T25:00:00Z" } },
      { start: { date: "2026-10-21" } }, // mixed all-day start and timed end
      { start: {}, end: {} },
    ];
    for (const extra of bad) expect(busySpan(timed(extra), NY)).toBeNull();
    expect(busySpan(allDay("2026-02-30", "2026-03-01"), NY)).toBeNull();
    expect(busySpan(allDay("2026-10-21T00:00", "2026-10-22"), NY)).toBeNull();
    expect(busySpan(allDay("10/21/2026", "2026-10-22"), NY)).toBeNull();
  });

  it("an end that is not after the start blocks nothing", () => {
    expect(busySpan(timed({ end: { dateTime: "2026-10-21T10:00:00-04:00" } }), NY)).toBeNull();
    expect(busySpan(timed({ end: { dateTime: "2026-10-21T09:00:00-04:00" } }), NY)).toBeNull();
    expect(busySpan(allDay("2026-10-21", "2026-10-21"), NY)).toBeNull();
    expect(busySpan(allDay("2026-10-22", "2026-10-21"), NY)).toBeNull();
  });
});
