"use client";

import { CaretLeft, CaretRight, Globe, Plus } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNote, IncompleteNote, LoadingRows, PageHeader } from "@/components/ui/states";
import { bookingCustomerName, defaultMessage, type BookingView, type ResourceSummary } from "@/lib/api";
import { resourceLabel } from "@/lib/resources";
import { useBookings, useResources, useSlots } from "@/lib/queries";
import { addDays, formatDateKey, formatTime, startOfZonedDay, weekdayOf, zonedDateKey } from "@/lib/time";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { BookingCustomerDialog } from "./booking-customer-dialog";
import { BookingDialog } from "./booking-dialog";
import { BookingPageCard } from "./booking-page-card";
import { SlotsError } from "./slots-error";

type View = "day" | "week";

const fromWebsite = (booking: BookingView) => booking.source === "website";

/** A read that waits for the browser to come back online: say so now, not after endless loading bars. */
const waitingOffline = (query: { isPending: boolean; fetchStatus: string }) => query.isPending && query.fetchStatus === "paused";

function OfflineNote() {
  return <ErrorNote error={null} message={defaultMessage("network")} />;
}

/** Website bookings say so; one still waiting for review says that too (public-intake.md P-12). */
function WebsiteBadge({ booking }: { booking: BookingView }) {
  if (!fromWebsite(booking)) return null;
  return (
    <Badge tone="accent" data-testid="website-badge">
      <Globe aria-hidden />Website{booking.customer?.status === "possible_match" ? " · to review" : ""}
    </Badge>
  );
}

function BookingRow({ booking, zone, onCustomer }: { booking: BookingView; zone: string; onCustomer?: ((id: string) => void) | undefined }) {
  const customer = bookingCustomerName(booking);
  const time = formatTime(booking.startsAt, zone);
  return (
    <li className="card flex items-center gap-4 p-4" data-source={booking.source ?? "owner"}>
      <div className="w-20 shrink-0">
        <p className="tabular text-sm font-bold text-fg">{formatTime(booking.startsAt, zone)}</p>
        <p className="tabular text-xs text-meta">to {formatTime(booking.endsAt, zone)}</p>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 border-l-2 border-primary pl-3">
        <Avatar name={customer} size="sm" />
        <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-body font-semibold text-fg">{booking.title ?? (fromWebsite(booking) ? "Website booking" : "Appointment")}</p>
          <WebsiteBadge booking={booking} />
        </div>
        <p className="truncate text-sm text-muted">{customer ?? "No customer linked"}</p>
        {/* A website booking takes its customer from the request; only owner-made ones can be linked (BC-2). */}
        {fromWebsite(booking) || !onCustomer ? null : (
          <button
            type="button"
            aria-label={`${booking.customer ? "Change customer" : "Link a customer"} for ${time}`}
            onClick={() => onCustomer(booking.id)}
            className="focus-inset -ml-1 mt-0.5 inline-flex min-h-11 items-center rounded-sm px-1 text-sm font-bold text-accent-ink underline-offset-4 hover:underline"
          >
            {booking.customer ? "Change customer" : "Link a customer"}
          </button>
        )}
        </div>
      </div>
    </li>
  );
}

function DayView({ resource, dateKey, today, onPickSlot }: { resource: ResourceSummary; dateKey: string; today: string; onPickSlot: (startsAt: string) => void }) {
  const zone = resource.timeZone;
  const range = useMemo(() => ({
    from: startOfZonedDay(dateKey, zone).toISOString(),
    to: startOfZonedDay(addDays(dateKey, 1), zone).toISOString(),
  }), [dateKey, zone]);
  const bookings = useBookings({ resourceId: resource.id, ...range });
  const slots = useSlots({ resourceId: resource.id, ...range, zone });
  // Linking needs `customers` as well as `calendar` (booking-customer.md BC-3).
  const canLink = useCan("calendar") && useCan("customers");
  const [customerFor, setCustomerFor] = useState<{ id: string; open: boolean } | null>(null);
  // Looked up by ID on every render, so the sheet shows the booking as the list has it now.
  const customerBooking = bookings.data?.items.find((item) => item.id === customerFor?.id) ?? null;

  if (waitingOffline(bookings) || waitingOffline(slots)) return <OfflineNote />;
  if (bookings.isPending || slots.isPending) return <LoadingRows rows={4} label="Loading day" />;
  if (bookings.isError) return <ErrorNote error={bookings.error} retry={() => bookings.refetch()} />;

  const open = slots.data?.slots ?? [];
  const past = dateKey < today;
  return (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-4">
      {/* Busy while a cached day refetches too, e.g. after a website booking was linked elsewhere. */}
      <section aria-labelledby="day-booked" aria-busy={bookings.isFetching} className="tray">
        {/* Focus lands here after a booking takes the open time that opened the sheet. */}
        <h2 id="day-booked" tabIndex={-1} className="px-3 pt-2 pb-2.5 text-base font-bold outline-none lg:px-4">Booked</h2>
        <IncompleteNote list={bookings.data} />
        {bookings.data.items.length === 0 ? (
          <EmptyState title={past ? "Nothing was booked" : "Nothing booked yet"}>{!past && open.length > 0 ? "Pick an open time to book one." : null}</EmptyState>
        ) : (
          <ul className="grid gap-1.5 lg:gap-2">{bookings.data.items.map((booking) => <BookingRow key={booking.id} booking={booking} zone={zone} {...(canLink ? { onCustomer: (id: string) => setCustomerFor({ id, open: true }) } : {})} />)}</ul>
        )}
      </section>
      <section aria-labelledby="day-open" className="tray">
        <h2 id="day-open" className="px-3 pt-2 pb-2.5 text-base font-bold lg:px-4">Open times</h2>
        {slots.isError ? <SlotsError error={slots.error} retry={() => slots.refetch()} /> : open.length === 0 ? (
          <p className="card p-4 text-sm text-muted">No open times this day.</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3 lg:gap-2">
            {open.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                onClick={() => onPickSlot(slot.startsAt)}
                className="press tabular min-h-11 rounded-pill bg-surface text-sm font-bold text-fg shadow-card transition-quick hover:bg-accent-tint hover:text-accent-ink"
                aria-label={`Book ${formatTime(slot.startsAt, zone)}`}
              >
                {formatTime(slot.startsAt, zone)}
              </button>
            ))}
          </div>
        )}
      </section>
      {canLink && customerBooking ? (
        <BookingCustomerDialog booking={customerBooking} zone={zone} open={customerFor?.open ?? false} onOpenChange={(open) => setCustomerFor((state) => state && { ...state, open })} />
      ) : null}
    </div>
  );
}

export function WeekView({ resource, weekStart, today, onOpenDay }: {
  resource: ResourceSummary;
  weekStart: string;
  today: string;
  onOpenDay: (dateKey: string) => void;
}) {
  const zone = resource.timeZone;
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const range = useMemo(() => ({
    from: startOfZonedDay(weekStart, zone).toISOString(),
    to: startOfZonedDay(addDays(weekStart, 7), zone).toISOString(),
  }), [weekStart, zone]);
  const bookings = useBookings({ resourceId: resource.id, ...range });
  // Open times tell a free day from a closed one; until they load, a day just has no bookings.
  const slots = useSlots({ resourceId: resource.id, ...range, zone });
  if (waitingOffline(bookings)) return <OfflineNote />;
  if (bookings.isPending) return <LoadingRows rows={5} label="Loading week" />;
  if (bookings.isError) return <ErrorNote error={bookings.error} retry={() => bookings.refetch()} />;

  const dayStatus = (day: string, booked: number) => {
    if (booked > 0) return `${booked} booked`;
    if (day < today || !slots.data) return "No bookings";
    return slots.data.slots.some((slot) => zonedDateKey(slot.startsAt, zone) === day) ? "Open" : "No open times";
  };

  return (
    <>
    <IncompleteNote list={bookings.data} />
    <ol className="tray grid grid-cols-1 gap-1.5 lg:grid-cols-7 lg:gap-2" aria-busy={bookings.isFetching}>
      {days.map((day) => {
        const items = bookings.data.items.filter((booking) => zonedDateKey(booking.startsAt, zone) === day);
        const [weekday, rest] = formatDateKey(day).split(", ");
        const status = dayStatus(day, items.length);
        return (
          <li key={day} className={cn("rounded-lg bg-surface p-3 lg:min-h-48", day === today ? "shadow-[0_0_0_2px_var(--accent),var(--elev-card)]" : "shadow-card")}>
            <button type="button" onClick={() => onOpenDay(day)} className="-m-1 flex min-h-11 w-[calc(100%+8px)] items-baseline justify-between rounded-md p-1 text-left hover:bg-inset">
              <span className="text-sm font-bold text-fg">{weekday} <span className="font-normal text-muted">{rest}</span></span>
              <span className="text-xs text-meta" data-day-status={status}>{status}</span>
            </button>
            {items.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {items.map((booking) => (
                  <li key={booking.id} className="rounded-[10px] bg-accent-tint px-2 py-1.5 text-xs" data-source={booking.source ?? "owner"}>
                    <span className="tabular font-bold text-accent-ink">{formatTime(booking.startsAt, zone)}</span>{" "}
                    <span className="text-fg-2">{bookingCustomerName(booking) ?? booking.title ?? "Appointment"}</span>
                    {fromWebsite(booking) ? <span className="ml-1 inline-flex align-middle text-accent" title="Booked on your website"><Globe size={14} aria-label="Website" /></span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
    </>
  );
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function CalendarView() {
  const resources = useResources();
  // `?date=YYYY-MM-DD&calendar=<id>` opens that day, as the Inbox's booking links do.
  const params = useSearchParams();
  const linkedDate = params.get("date");
  const [resourceId, setResourceId] = useState<string | null>(params.get("calendar"));
  const [view, setView] = useState<View>("day");
  const [dateKey, setDateKey] = useState<string | null>(linkedDate && DATE_KEY.test(linkedDate) && !Number.isNaN(Date.parse(linkedDate)) ? linkedDate : null);
  const [dialog, setDialog] = useState<{ open: boolean; slot: string | null }>({ open: false, slot: null });

  if (waitingOffline(resources)) return <><PageHeader title="Calendar" /><OfflineNote /></>;
  if (resources.isPending) return <><PageHeader title="Calendar" /><LoadingRows rows={4} /></>;
  if (resources.isError) return <><PageHeader title="Calendar" /><ErrorNote error={resources.error} retry={() => resources.refetch()} /></>;
  if (resources.data.length === 0) return <><PageHeader title="Calendar" /><EmptyState title="No calendars yet">Add a bookable calendar to start taking appointments.</EmptyState></>;

  const resource = resources.data.find((item) => item.id === resourceId) ?? resources.data[0]!;
  const today = zonedDateKey(new Date(), resource.timeZone);
  const current = dateKey ?? today;
  const weekStart = addDays(current, 1 - weekdayOf(current));
  const step = view === "day" ? 1 : 7;

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your appointments and open times."
        actions={<Button onClick={() => setDialog({ open: true, slot: null })}><Plus aria-hidden />Book appointment</Button>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          label="Calendar"
          value={resource.id}
          options={resources.data.map((item) => ({ value: item.id, label: resourceLabel(item) }))}
          onChange={setResourceId}
        />
        <Segmented label="View" value={view} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} onChange={setView} />
      </div>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="secondary" size="icon" aria-label={view === "day" ? "Previous day" : "Previous week"} onClick={() => setDateKey(addDays(current, -step))}><CaretLeft aria-hidden /></Button>
        <Button variant="secondary" size="icon" aria-label={view === "day" ? "Next day" : "Next week"} onClick={() => setDateKey(addDays(current, step))}><CaretRight aria-hidden /></Button>
        {current !== today ? <Button variant="secondary" onClick={() => setDateKey(today)}>Today</Button> : null}
        <h2 className="ml-2 min-w-0 flex-1 text-lg font-bold text-fg" aria-live="polite">
          {view === "day" ? (
            // The short date fits on one line beside the buttons on a phone.
            <><span className="sm:hidden">{formatDateKey(current)}</span><span className="hidden sm:inline">{formatDateKey(current, "long")}</span></>
          ) : `Week of ${formatDateKey(weekStart)}`}
        </h2>
      </div>

      {view === "day" ? (
        <DayView resource={resource} dateKey={current} today={today} onPickSlot={(slot) => setDialog({ open: true, slot })} />
      ) : (
        <WeekView resource={resource} weekStart={weekStart} today={today} onOpenDay={(day) => { setDateKey(day); setView("day"); }} />
      )}

      <BookingPageCard />

      <p className="mt-6 text-sm text-meta">Times show in {resource.timeZone.split("/").pop()?.replaceAll("_", " ")} time. A slot is only booked once it is saved, so two people can never take the same time.</p>

      <BookingDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((state) => ({ ...state, open }))}
        resource={resource}
        initialDate={dialog.slot ? zonedDateKey(dialog.slot, resource.timeZone) : current}
        initialSlot={dialog.slot}
        onOpenerGone={() => document.getElementById("day-booked")?.focus()}
      />
    </>
  );
}
