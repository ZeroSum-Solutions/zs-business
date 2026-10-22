// UI audit U2 (calendar): copy, past days, the week's day labels, offline, the embed box and
// the Google Calendar card's names, notices and waiting grant.
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarCard } from "../src/components/account/google-calendar-card";
import { firstBookableDay } from "../src/components/calendar/booking-dialog";
import { BookingPageCard } from "../src/components/calendar/booking-page-card";
import { CalendarView } from "../src/components/calendar/calendar-view";
import type { BookingPageSummary, CalendarConnection, ResourceSummary } from "../src/lib/api";
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
// Wednesday, Oct 21 2026, mid-morning in Chicago.
const NOW = new Date("2026-10-21T15:00:00.000Z");
const range = (from: string, days: number) => ({ resourceId: studio.id, from: startOfZonedDay(from, ZONE).toISOString(), to: startOfZonedDay(addDays(from, days), ZONE).toISOString() });
const slot = (iso: string) => ({ startsAt: iso, endsAt: new Date(Date.parse(iso) + 3_600_000).toISOString(), localStart: iso.slice(0, 19) });
const empty = { items: [], incomplete: false, loaded: 0 };

function calendar(fill: (client: QueryClient) => void, params: Record<string, string> = {}) {
  search.params = new URLSearchParams({ calendar: studio.id, ...params });
  return renderScreen(h(CalendarView), { fill: (client) => {
    client.setQueryData(keys.resources, [studio]);
    client.setQueryData(keys.bookingPages, []);
    fill(client);
  } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("calendar page", () => {
  it("does not describe every business as a showroom (U2-2)", () => {
    const html = calendar((client) => {
      client.setQueryData(keys.bookings(range("2026-10-21", 1)), empty);
      client.setQueryData(keys.slots({ ...range("2026-10-21", 1), zone: ZONE }), { resourceId: studio.id, timeZone: ZONE, zone: ZONE, slots: [] });
    });
    expect(html).not.toMatch(/showroom|repair intake/i);
  });

  it("says nothing was booked on a past day, without asking to book it (U2-11)", () => {
    const html = calendar((client) => {
      client.setQueryData(keys.bookings(range("2026-10-20", 1)), empty);
      client.setQueryData(keys.slots({ ...range("2026-10-20", 1), zone: ZONE }), { resourceId: studio.id, timeZone: ZONE, zone: ZONE, slots: [] });
    }, { date: "2026-10-20" });
    expect(html).toContain("Nothing was booked");
    expect(html).not.toContain("Pick an open time");
  });

  it("does not ask to pick an open time on a day that has none", () => {
    const html = calendar((client) => {
      client.setQueryData(keys.bookings(range("2026-10-22", 1)), empty);
      client.setQueryData(keys.slots({ ...range("2026-10-22", 1), zone: ZONE }), { resourceId: studio.id, timeZone: ZONE, zone: ZONE, slots: [] });
    }, { date: "2026-10-22" });
    expect(html).toContain("Nothing booked yet");
    expect(html).not.toContain("Pick an open time");
  });

  it("shows an offline note at once instead of loading bars that never end (V-5)", () => {
    onlineManager.setOnline(false);
    const html = calendar(() => undefined);
    expect(html).toContain("You look offline");
    expect(html).not.toContain('aria-label="Loading day"');
  });

  it("starts the booking sheet's days at today when the page shows a past day (U2-12)", () => {
    expect(firstBookableDay("2026-10-19", "2026-10-21")).toBe("2026-10-21");
    expect(firstBookableDay("2026-10-23", "2026-10-21")).toBe("2026-10-23");
  });
});

describe("calendar week", () => {
  // The week of Mon Oct 19: Mon and Tue are past, Wed has an open time, Thu-Sun have none.
  const week = (client: QueryClient) => {
    client.setQueryData(keys.bookings(range("2026-10-19", 7)), empty);
    client.setQueryData(keys.slots({ ...range("2026-10-19", 7), zone: ZONE }), { resourceId: studio.id, timeZone: ZONE, zone: ZONE, slots: [slot("2026-10-21T20:00:00.000Z")] });
  };

  it("does not call a closed or past day free (U2-10)", async () => {
    const { WeekView } = await import("../src/components/calendar/calendar-view");
    search.params = new URLSearchParams();
    const html = renderScreen(h(WeekView, { resource: studio, weekStart: "2026-10-19", today: "2026-10-21", onOpenDay: () => undefined }), { fill: week });
    const labels = [...html.matchAll(/data-day-status="([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual(["No bookings", "No bookings", "Open", "No open times", "No open times", "No open times", "No open times"]);
    expect(html).not.toContain(">Free<");
  });
});

describe("booking page card", () => {
  const page: BookingPageSummary = {
    id: uuid(9), title: "Book a visit", published: true, disclosureVersion: "1", resourceIds: [studio.id], publicKey: "pk",
    bookingUrl: "https://book.example/pk", embedScript: '<div data-zs-booking="pk"></div>\n<script src="https://book.example/embed.js" async></script>', embedIframe: "<iframe></iframe>",
  };

  it("sizes the embed box to its code instead of cutting it off (V-6)", () => {
    const html = renderScreen(h(BookingPageCard), { fill: (client) => client.setQueryData(keys.bookingPages, [page]) });
    expect(html).toMatch(/<textarea[^>]*class="[^"]*field-sizing-content/);
  });
});

describe("Google Calendar card", () => {
  const unnamed: ResourceSummary = { ...studio, id: uuid(2), name: null };
  const connection = (status: CalendarConnection["status"]): CalendarConnection => ({
    id: uuid(21), provider: "google", resourceId: unnamed.id, calendarId: "primary", accountEmail: "owner@example.com",
    status, lastSyncedAt: null, lastError: null, createdAt: "2026-10-20T12:00:00.000Z",
  });
  const card = (fill: (client: QueryClient) => void, notice: Parameters<typeof GoogleCalendarCard>[0]["notice"] = null, staff = false) =>
    renderScreen(h(GoogleCalendarCard, { notice, onNotice: () => undefined }), { staff, fill: (client) => {
      client.setQueryData(keys.resources, [studio, unnamed]);
      client.setQueryData(keys.calendarPending, null);
      fill(client);
    } });

  it("names a calendar saved without a name instead of printing nothing or null (U2-6)", () => {
    for (const status of ["active", "disconnecting"] as const) {
      const html = card((client) => client.setQueryData(keys.calendarConnections, [connection(status)]));
      expect(html).not.toMatch(/null|<h3[^>]*><\/h3>/);
      expect(html).toMatch(/<h3[^>]*>Unnamed calendar<\/h3>/);
    }
    const none = card((client) => client.setQueryData(keys.calendarConnections, []));
    expect(none).toContain('<span class="sr-only"> <!-- -->Unnamed calendar</span>');
  });

  it("lets the owner dismiss a notice from Google's return (V-3)", () => {
    const html = card((client) => client.setQueryData(keys.calendarConnections, []), { tone: "error", message: "That connection request expired. Connect again." });
    expect(html).toMatch(/<button[^>]*aria-label="Dismiss"/);
  });

  it("asks staff to get an owner instead of to try again (V-4)", () => {
    const html = card((client) => client.setQueryData(keys.calendarConnections, []), { tone: "error", message: "Google Calendar could not be connected. Try again from this page." }, true);
    expect(html).not.toContain("Try again from this page.");
    expect(html).toContain("Ask an owner to connect it.");
  });

  it("shows the calendar waiting for confirmation as waiting, without its own Connect (V-10)", () => {
    const html = card((client) => {
      client.setQueryData(keys.calendarConnections, []);
      client.setQueryData(keys.calendarPending, { grantId: "g".repeat(43), resourceId: studio.id, accountEmail: "owner@example.com", expiresAt: "2026-10-21T16:00:00.000Z" });
    });
    const row = /<li[^>]*aria-labelledby="gcal-[^"]*000000000001-name"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    expect(row).toContain("Waiting for confirmation");
    expect(row).not.toMatch(/>Connect<!-- -->|>Connect</);
  });
});
