// booking-customer.md BC-8, BC-9: the calendar names a booking's customer and offers to link or
// change one on owner-made bookings only; a website booking takes its customer from its request.
import type { QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarView } from "../src/components/calendar/calendar-view";
import { customerChangeMessage } from "../src/components/calendar/booking-customer-dialog";
import { ApiError, demoError, type BookingView, type ResourceSummary } from "../src/lib/api";
import { startOfZonedDay, addDays } from "../src/lib/time";
import { keys, renderScreen } from "./helpers/render";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/calendar",
}));

const uuid = (n: number) => `2a4c6e80-1b3d-4f5a-9c7e-${String(n).padStart(12, "0")}`;
const ZONE = "America/Chicago";
const studio: ResourceSummary = { id: uuid(1), name: "Studio", timeZone: ZONE, slotLengthMinutes: 60 };
const NOW = new Date("2026-10-21T15:00:00.000Z");
const day = { resourceId: studio.id, from: startOfZonedDay("2026-10-21", ZONE).toISOString(), to: startOfZonedDay(addDays("2026-10-21", 1), ZONE).toISOString() };

const booking = (n: number, extra: Partial<BookingView>): BookingView => ({
  id: uuid(100 + n), tenantId: uuid(2), resourceId: studio.id,
  startsAt: `2026-10-21T${15 + n}:00:00.000Z`, endsAt: `2026-10-21T${16 + n}:00:00.000Z`,
  occupiedStartsAt: `2026-10-21T${15 + n}:00:00.000Z`, occupiedEndsAt: `2026-10-21T${16 + n}:00:00.000Z`,
  bufferBeforeMinutes: 0, bufferAfterMinutes: 0, status: "confirmed", createdAt: "2026-10-20T12:00:00.000Z",
  source: "owner", intakeItemId: null, customer: null, ...extra,
});

function calendar(items: BookingView[]) {
  search.params = new URLSearchParams({ calendar: studio.id });
  return renderScreen(h(CalendarView), { fill: (client: QueryClient) => {
    client.setQueryData(keys.resources, [studio]);
    client.setQueryData(keys.bookingPages, []);
    client.setQueryData(keys.bookings(day), { items, incomplete: false, loaded: items.length });
    client.setQueryData(keys.slots({ ...day, zone: ZONE }), { resourceId: studio.id, timeZone: ZONE, zone: ZONE, slots: [] });
  } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("calendar day: who a booking is for", () => {
  it("says no customer is linked and offers to link one on an owner-made booking", () => {
    const html = calendar([booking(0, {})]);
    expect(html).toContain("No customer linked");
    expect(html).toContain("Link a customer");
    expect(html).not.toContain("Change customer");
  });

  it("tells the link buttons apart by time for a screen reader", () => {
    const html = calendar([booking(0, {}), booking(1, { customer: { contactId: uuid(7), name: "Ana Ruiz", status: "linked" } })]);
    expect(html).toMatch(/aria-label="Link a customer for \d{1,2}:\d{2} [AP]M"/);
    expect(html).toMatch(/aria-label="Change customer for \d{1,2}:\d{2} [AP]M"/);
  });

  it("shows a linked customer by name and offers to change them", () => {
    const html = calendar([booking(0, { customer: { contactId: uuid(7), name: "Ana Ruiz", status: "linked" } })]);
    expect(html).toContain("Ana Ruiz");
    expect(html).toContain("Change customer");
    expect(html).not.toContain("Link a customer");
    expect(html).not.toContain("No customer linked");
  });

  it("offers nothing to link on a website booking", () => {
    const html = calendar([booking(0, { source: "website", intakeItemId: uuid(9), customer: { contactId: uuid(7), name: "Linnea Castellanos", status: "linked" } })]);
    expect(html).toContain("Linnea Castellanos");
    expect(html).not.toContain("Link a customer");
    expect(html).not.toContain("Change customer");
  });
});

describe("customer change messages", () => {
  it("speaks about the booking, not a deal, on a stale revision", () => {
    const stale = demoError("Conflict", { reason: "stale_revision", currentRevision: 3 });
    expect(customerChangeMessage(stale)).toMatch(/customer changed/i);
    expect(customerChangeMessage(stale)).not.toMatch(/deal/i);
  });

  it("explains a website booking and a missing customer", () => {
    expect(customerChangeMessage(demoError("Conflict", { reason: "intake_booking" }))).toMatch(/website/i);
    expect(customerChangeMessage(demoError("NotFound"))).toMatch(/no longer on file/i);
    expect(customerChangeMessage(new ApiError("server", "x", 500))).toBeUndefined();
  });
});
