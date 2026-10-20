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
/** The connection's own tenant and resource (G-7). */
const OWN = { tenantId: "8f9c2b1e-3d4a-4b5c-9e6f-7a8b9c0d1e2f", resourceId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" };
const span = (event: GoogleEvent, timeZone: string) => busySpan(event, timeZone, OWN);

describe("busySpan (G-7)", () => {
  it("a timed event blocks [start, end) whatever offset it is written in", () => {
    expect(span(timed(), NY)).toEqual({ start: ms("2026-10-21T14:00:00Z"), end: ms("2026-10-21T15:30:00Z") });
    expect(span(timed({ start: { dateTime: "2026-10-21T14:00:00Z" }, end: { dateTime: "2026-10-21T14:45:00.500Z" } }), "UTC"))
      .toEqual({ start: ms("2026-10-21T14:00:00Z"), end: ms("2026-10-21T14:45:00.500Z") });
    // Explicit status, opaque transparency, a busy event type and an accepting self count as busy.
    expect(span(timed({ status: "confirmed", transparency: "opaque", eventType: "outOfOffice",
      attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "declined" }] }), NY)).not.toBeNull();
    expect(span(timed({ status: "tentative", eventType: "default" }), NY)).not.toBeNull();
  });

  it("cancelled, transparent, workingLocation and birthday events are free", () => {
    expect(span(timed({ status: "cancelled" }), NY)).toBeNull();
    expect(span(timed({ transparency: "transparent" }), NY)).toBeNull();
    expect(span(timed({ eventType: "workingLocation" }), NY)).toBeNull();
    expect(span(allDay("2026-10-21", "2026-10-22", { eventType: "birthday" }), NY)).toBeNull();
  });

  it("an event the calendar's own attendee declined is free; another attendee declining is not", () => {
    expect(span(timed({ attendees: [{ self: true, responseStatus: "declined" }] }), NY)).toBeNull();
    expect(span(timed({ attendees: [{ self: false, responseStatus: "declined" }, { self: true, responseStatus: "needsAction" }] }), NY))
      .not.toBeNull();
  });

  it("an event this system pushed for the same tenant and resource is free; one for another blocks", () => {
    const pushed = (extra: Record<string, string>) => timed({ extendedProperties: { private: { zs_booking: "b", ...extra } } });
    expect(span(pushed({ zs_tenant: OWN.tenantId, zs_resource: OWN.resourceId }), NY)).toBeNull();
    // Another resource of the tenant, or another tenant, sharing the calendar (G-10: no double booking).
    expect(span(pushed({ zs_tenant: OWN.tenantId, zs_resource: "other-resource" }), NY)).not.toBeNull();
    expect(span(pushed({ zs_tenant: "other-tenant", zs_resource: OWN.resourceId }), NY)).not.toBeNull();
    // Pushed before zs_resource existed, or only partly marked: it blocks.
    expect(span(pushed({ zs_tenant: OWN.tenantId }), NY)).not.toBeNull();
    expect(span(timed({ extendedProperties: { private: { zs_tenant: OWN.tenantId, zs_resource: OWN.resourceId } } }), NY)).not.toBeNull();
    expect(span(timed({ extendedProperties: { private: { other: "x" } } }), NY)).not.toBeNull();
  });

  it("an all-day event blocks midnight to midnight in the resource's zone, across DST", () => {
    // EDT to EST: the weekend of 2026-11-01 is 49 hours long in New York.
    expect(span(allDay("2026-10-31", "2026-11-02"), NY))
      .toEqual({ start: ms("2026-10-31T04:00:00Z"), end: ms("2026-11-02T05:00:00Z") });
    // EST to EDT: 2026-03-08 is 23 hours long.
    expect(span(allDay("2026-03-08", "2026-03-09"), NY))
      .toEqual({ start: ms("2026-03-08T05:00:00Z"), end: ms("2026-03-09T04:00:00Z") });
    expect(span(allDay("2026-10-21", "2026-10-22"), "UTC"))
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
    expect(span(noStart, NY)).toBeNull();
    expect(span(noEnd, NY)).toBeNull();
    const bad: Array<Partial<GoogleEvent>> = [
      { start: { dateTime: "2026-10-21T10:00:00" } }, // no offset: would read in an ambient zone
      { start: { dateTime: "tomorrow" } },
      { start: { dateTime: "2026-13-21T10:00:00Z" } },
      { start: { dateTime: "2026-10-21T25:00:00Z" } },
      { start: { date: "2026-10-21" } }, // mixed all-day start and timed end
      { start: {}, end: {} },
    ];
    for (const extra of bad) expect(span(timed(extra), NY)).toBeNull();
    expect(span(allDay("2026-02-30", "2026-03-01"), NY)).toBeNull();
    expect(span(allDay("2026-10-21T00:00", "2026-10-22"), NY)).toBeNull();
    expect(span(allDay("10/21/2026", "2026-10-22"), NY)).toBeNull();
  });

  it("an end that is not after the start blocks nothing", () => {
    expect(span(timed({ end: { dateTime: "2026-10-21T10:00:00-04:00" } }), NY)).toBeNull();
    expect(span(timed({ end: { dateTime: "2026-10-21T09:00:00-04:00" } }), NY)).toBeNull();
    expect(span(allDay("2026-10-21", "2026-10-21"), NY)).toBeNull();
    expect(span(allDay("2026-10-22", "2026-10-21"), NY)).toBeNull();
  });
});
