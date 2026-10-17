import { describe, expect, it, vi } from "vitest";
import type { BookingBusyInterval, BookingResource, GetAvailableSlotsInput } from "@zs/contracts";
import { getAvailableSlots } from "../../src/index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";

function resource(overrides: Partial<BookingResource> = {}): BookingResource {
  return {
    tenantId, id: resourceId, timeZone: "UTC",
    // 2026-10-19 is a Monday.
    weekly: [{ weekday: 1, windows: [{ startMinute: 540, endMinute: 720 }] }],
    overrides: [], slotLengthMinutes: 30, slotStepMinutes: 30,
    bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0, bookingHorizonMinutes: 525600,
    ...overrides,
  };
}
function input(res: BookingResource, startsAt: string, endsAt: string, busy: BookingBusyInterval[] = []): GetAvailableSlotsInput {
  return { resource: res, range: { startsAt, endsAt }, busy };
}
const clockAt = (iso: string) => ({ clock: { now: () => new Date(iso) } });
const starts = (value: GetAvailableSlotsInput, now = "2026-10-01T00:00:00.000Z") =>
  getAvailableSlots(value, clockAt(now)).slots.map((slot) => slot.startsAt);
const day = (from: string, to: string) => input(resource(), from, to);
const external = (startsAt: string, endsAt: string): BookingBusyInterval =>
  ({ kind: "external", tenantId, resourceId, startsAt, endsAt });
const booked = (startsAt: string, endsAt: string, before: number, after: number): BookingBusyInterval =>
  ({ kind: "booking", tenantId, resourceId, startsAt, endsAt, bufferBeforeMinutes: before, bufferAfterMinutes: after });

function validationFailure(run: () => unknown) {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return "no error";
}

describe("B-2/B-3/B-4 boundary", () => {
  it.each(["utc", "GMT", "EST5EDT", "+05:00", "Mars/Olympus", "America/Nowhere"])("rejects zone %s", (timeZone) => {
    expect(validationFailure(() => getAvailableSlots(
      input(resource({ timeZone }), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z"),
      clockAt("2026-10-01T00:00:00.000Z"),
    ))).toBe("ValidationFailed");
  });

  it("accepts a lowercase IANA name and echoes the input identifier", () => {
    const out = getAvailableSlots(
      input(resource({ timeZone: "america/new_york" }), "2026-10-19T13:00:00.000Z", "2026-10-19T14:00:00.000Z"),
      clockAt("2026-10-01T00:00:00.000Z"),
    );
    expect(out.timeZone).toBe("america/new_york");
    expect(out.slots.map((slot) => slot.startsAt)).toEqual(["2026-10-19T13:00:00.000Z", "2026-10-19T13:30:00.000Z"]);
  });

  it("supports Etc/GMT+5 (UTC-5)", () => {
    expect(starts(input(resource({ timeZone: "Etc/GMT+5" }), "2026-10-19T14:00:00.000Z", "2026-10-19T15:00:00.000Z")))
      .toEqual(["2026-10-19T14:00:00.000Z", "2026-10-19T14:30:00.000Z"]);
  });

  it("normalizes IDs to lowercase", () => {
    const upper = { ...resource(), tenantId: tenantId.toUpperCase(), id: resourceId.toUpperCase() };
    const out = getAvailableSlots(input(upper, "2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"), clockAt("2026-10-01T00:00:00.000Z"));
    expect(out.resourceId).toBe(resourceId);
  });

  it("reads the clock exactly once and rejects a non-finite instant", () => {
    const now = vi.fn(() => new Date("2026-10-01T00:00:00.000Z"));
    getAvailableSlots(day("2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z"), { clock: { now } });
    expect(now).toHaveBeenCalledTimes(1);
    expect(validationFailure(() => getAvailableSlots(day("2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z"),
      { clock: { now: () => new Date(Number.NaN) } }))).toBe("ValidationFailed");
  });

  it.each([
    ["unknown field", { ...day("2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z"), extra: 1 }],
    ["range over 31 days", day("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.001Z")],
    ["impossible override date", input(resource({ overrides: [{ date: "2026-02-30", windows: [] }] }), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")],
    ["duplicate weekday", input(resource({ weekly: [{ weekday: 1, windows: [] }, { weekday: 1, windows: [] }] }), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")],
    ["zero step", input(resource({ slotStepMinutes: 0 }), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")],
    ["fractional length", input(resource({ slotLengthMinutes: 1.5 }), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")],
    ["instant without milliseconds", day("2026-10-19T00:00:00Z", "2026-10-20T00:00:00.000Z")],
    ["foreign busy entry", input(resource(), "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z",
      [{ ...external("2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"), tenantId: resourceId }])],
  ])("rejects %s with ValidationFailed", (_name, value) => {
    expect(validationFailure(() => getAvailableSlots(value as GetAvailableSlotsInput, clockAt("2026-10-01T00:00:00.000Z"))))
      .toBe("ValidationFailed");
  });

  it("accepts exactly 31 days with a 1-minute step quickly", () => {
    const value = input(resource({
      slotLengthMinutes: 1, slotStepMinutes: 1,
      weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })),
      timeZone: "America/New_York",
    }), "2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z");
    const began = globalThis.performance.now();
    const out = getAvailableSlots(value, clockAt("2026-10-01T00:00:00.000Z"));
    expect(out.slots).toHaveLength(31 * 1440);
    expect(globalThis.performance.now() - began).toBeLessThan(2000);
  });
});

describe("B-5/B-6 schedule", () => {
  it("merges overlapping windows regardless of order", () => {
    const res = resource({ slotLengthMinutes: 60, weekly: [{ weekday: 1, windows: [
      { startMinute: 600, endMinute: 660 }, { startMinute: 540, endMinute: 610 },
    ] }] });
    expect(starts(input(res, "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")))
      .toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z", "2026-10-19T10:00:00.000Z"]);
  });

  it("joins windows touching across midnight into one interval", () => {
    const res = resource({ slotLengthMinutes: 60, weekly: [
      { weekday: 2, windows: [{ startMinute: 0, endMinute: 60 }] },
      { weekday: 1, windows: [{ startMinute: 1380, endMinute: 1440 }] },
    ] });
    expect(starts(input(res, "2026-10-19T00:00:00.000Z", "2026-10-21T00:00:00.000Z")))
      .toEqual(["2026-10-19T23:00:00.000Z", "2026-10-19T23:30:00.000Z", "2026-10-20T00:00:00.000Z"]);
  });

  it("closes a date with an empty override and leaves other dates on weekly rules", () => {
    const res = resource({
      weekly: [1, 2].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 600 }] })),
      overrides: [{ date: "2026-10-19", windows: [] }],
    });
    expect(starts(input(res, "2026-10-19T00:00:00.000Z", "2026-10-21T00:00:00.000Z")))
      .toEqual(["2026-10-20T09:00:00.000Z", "2026-10-20T09:30:00.000Z"]);
  });

  it("returns a successful empty list for a missing weekday", () => {
    expect(getAvailableSlots(day("2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"), clockAt("2026-10-01T00:00:00.000Z")))
      .toEqual({ resourceId, timeZone: "UTC", slots: [] });
  });
});

describe("B-7/B-8/B-9 time zones and DST", () => {
  it("aligns a 45-minute step to local minutes in a half-hour zone", () => {
    const res = resource({ timeZone: "Asia/Kolkata", slotStepMinutes: 45, weekly: [{ weekday: 1, windows: [{ startMinute: 540, endMinute: 690 }] }] });
    // Local 09:00, 09:45 and 10:30 (IST is UTC+05:30); 11:15 would end after 11:30.
    expect(starts(input(res, "2026-10-19T00:00:00.000Z", "2026-10-20T00:00:00.000Z")))
      .toEqual(["2026-10-19T03:30:00.000Z", "2026-10-19T04:15:00.000Z", "2026-10-19T05:00:00.000Z"]);
  });

  it("keeps elapsed duration across the spring gap and never shifts a missing label", () => {
    const res = resource({ timeZone: "America/New_York", slotLengthMinutes: 90, weekly: [{ weekday: 7, windows: [{ startMinute: 60, endMinute: 240 }] }] });
    // Local 01:00-04:00 on 2026-03-08 is 06:00Z-08:00Z (two elapsed hours); 02:xx does not exist.
    expect(starts(input(res, "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z"), "2026-03-01T00:00:00.000Z"))
      .toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T06:30:00.000Z"]);
  });

  it("emits both occurrences of a repeated label in a European fall overlap", () => {
    const res = resource({ timeZone: "Europe/London", weekly: [{ weekday: 7, windows: [{ startMinute: 60, endMinute: 90 }] }] });
    expect(starts(input(res, "2026-10-25T00:00:00.000Z", "2026-10-26T00:00:00.000Z"), "2026-10-01T00:00:00.000Z"))
      .toEqual(["2026-10-25T00:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
  });
});

describe("B-10/B-11/B-12 bounds", () => {
  it("allows an appointment ending exactly at the range end and rejects one a millisecond over", () => {
    expect(starts(day("2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"))).toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"]);
    expect(starts(day("2026-10-19T09:00:00.000Z", "2026-10-19T09:59:59.999Z"))).toEqual(["2026-10-19T09:00:00.000Z"]);
  });

  it("accepts a start exactly at the notice bound and rejects one millisecond less notice", () => {
    const res = resource({ minimumNoticeMinutes: 60 });
    const value = input(res, "2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z");
    expect(starts(value, "2026-10-19T08:00:00.000Z")).toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"]);
    expect(starts(value, "2026-10-19T08:00:00.001Z")).toEqual(["2026-10-19T09:30:00.000Z"]);
  });

  it("allows a start equal to now with zero notice", () => {
    expect(starts(day("2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"), "2026-10-19T09:00:00.000Z"))
      .toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"]);
  });

  it("treats the horizon as an exclusive start bound", () => {
    const value = input(resource({ bookingHorizonMinutes: 90 }), "2026-10-19T09:00:00.000Z", "2026-10-19T12:00:00.000Z");
    expect(starts(value, "2026-10-19T08:00:00.000Z")).toEqual(["2026-10-19T09:00:00.000Z"]);
    expect(starts(value, "2026-10-19T07:59:59.999Z")).toEqual(["2026-10-19T09:00:00.000Z"]);
    expect(starts(value, "2026-10-19T07:30:00.000Z")).toEqual([]);
  });

  it("returns no slots for horizon zero or notice at the horizon", () => {
    const range = ["2026-10-19T09:00:00.000Z", "2026-10-19T12:00:00.000Z"] as const;
    expect(starts(input(resource({ bookingHorizonMinutes: 0 }), ...range), "2026-10-19T09:00:00.000Z")).toEqual([]);
    expect(starts(input(resource({ bookingHorizonMinutes: 60, minimumNoticeMinutes: 60 }), ...range), "2026-10-19T08:00:00.000Z")).toEqual([]);
  });
});

describe("B-13/B-14/B-15/B-16 busy data", () => {
  it("lets preparation time extend before working hours and the query window", () => {
    const res = resource({ bufferBeforeMinutes: 30 });
    const range = ["2026-10-19T09:00:00.000Z", "2026-10-19T10:00:00.000Z"] as const;
    expect(starts(input(res, ...range, [external("2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z")])))
      .toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"]);
    expect(starts(input(res, ...range, [external("2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.001Z")])))
      .toEqual(["2026-10-19T09:30:00.000Z"]);
  });

  it("blocks a candidate whose after-buffer reaches a next-day external block", () => {
    const res = resource({ bufferAfterMinutes: 15, weekly: [{ weekday: 1, windows: [{ startMinute: 1380, endMinute: 1440 }] }] });
    const range = ["2026-10-19T23:00:00.000Z", "2026-10-20T00:00:00.000Z"] as const;
    expect(starts(input(res, ...range, [external("2026-10-20T00:10:00.000Z", "2026-10-20T00:20:00.000Z")])))
      .toEqual(["2026-10-19T23:00:00.000Z"]);
  });

  it("uses a booking's saved buffers and never the resource's current buffers", () => {
    const res = resource({ bufferBeforeMinutes: 15, slotStepMinutes: 15 });
    const busy = [booked("2026-10-19T10:00:00.000Z", "2026-10-19T10:30:00.000Z", 0, 0)];
    expect(starts(input(res, "2026-10-19T10:00:00.000Z", "2026-10-19T11:15:00.000Z", busy)))
      .toEqual(["2026-10-19T10:45:00.000Z"]);
    const saved = [booked("2026-10-19T10:00:00.000Z", "2026-10-19T10:30:00.000Z", 0, 30)];
    expect(starts(input(res, "2026-10-19T10:00:00.000Z", "2026-10-19T11:45:00.000Z", saved)))
      .toEqual(["2026-10-19T11:15:00.000Z"]);
  });

  it("blocks with a previous-day booking's after-buffer", () => {
    const res = resource({ weekly: [{ weekday: 2, windows: [{ startMinute: 0, endMinute: 120 }] }] });
    const busy = [booked("2026-10-19T23:30:00.000Z", "2026-10-20T00:00:00.000Z", 0, 45)];
    expect(starts(input(res, "2026-10-20T00:00:00.000Z", "2026-10-20T02:00:00.000Z", busy)))
      .toEqual(["2026-10-20T01:00:00.000Z", "2026-10-20T01:30:00.000Z"]);
  });

  it("unions duplicate and unsorted busy entries without mutating them", () => {
    const busy = [
      external("2026-10-19T11:00:00.000Z", "2026-10-19T11:30:00.000Z"),
      external("2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"),
      external("2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"),
      external("2026-10-19T09:15:00.000Z", "2026-10-19T10:00:00.000Z"),
    ];
    const value = input(resource(), "2026-10-19T09:00:00.000Z", "2026-10-19T12:00:00.000Z", busy);
    const before = structuredClone(value);
    expect(starts(value)).toEqual(["2026-10-19T10:00:00.000Z", "2026-10-19T10:30:00.000Z", "2026-10-19T11:30:00.000Z"]);
    expect(value).toEqual(before);
  });
});
