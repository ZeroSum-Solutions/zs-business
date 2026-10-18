"use client";

import { CaretLeft, CaretRight, Plus } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorNote, LoadingRows, PageHeader } from "@/components/ui/states";
import type { BookingListItem, BookingResourceSummary } from "@/lib/api";
import { useBookings, useResources, useSlots } from "@/lib/queries";
import { addDays, formatDateKey, formatTime, startOfZonedDay, weekdayOf, zonedDateKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import { BookingDialog } from "./booking-dialog";

type View = "day" | "week";

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-sm bg-surface-warm p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-10 rounded-[4px] px-3 text-sm font-medium transition-quick",
            value === option.value ? "bg-surface text-fg shadow-ring" : "text-muted hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function BookingRow({ booking, zone }: { booking: BookingListItem; zone: string }) {
  return (
    <li className="flex gap-4 rounded-md bg-surface p-3 shadow-ring">
      <div className="w-20 shrink-0">
        <p className="tabular text-sm font-semibold text-fg">{formatTime(booking.startsAt, zone)}</p>
        <p className="tabular text-xs text-meta">to {formatTime(booking.endsAt, zone)}</p>
      </div>
      <div className="min-w-0 border-l-2 border-accent pl-3">
        <p className="truncate text-sm font-medium text-fg">{booking.title ?? "Appointment"}</p>
        <p className="truncate text-sm text-muted">{booking.contactName ?? "No customer linked"}</p>
      </div>
    </li>
  );
}

function DayView({ resource, dateKey, onPickSlot }: { resource: BookingResourceSummary; dateKey: string; onPickSlot: (startsAt: string) => void }) {
  const zone = resource.timeZone;
  const range = useMemo(() => ({
    from: startOfZonedDay(dateKey, zone).toISOString(),
    to: startOfZonedDay(addDays(dateKey, 1), zone).toISOString(),
  }), [dateKey, zone]);
  const bookings = useBookings({ resourceId: resource.id, ...range });
  const slots = useSlots({ resourceId: resource.id, ...range, zone });

  if (bookings.isPending || slots.isPending) return <LoadingRows rows={4} label="Loading day" />;
  if (bookings.isError) return <ErrorNote error={bookings.error} retry={() => bookings.refetch()} />;

  const open = slots.data?.slots ?? [];
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-labelledby="day-booked">
        <h2 id="day-booked" className="mb-3 text-sm font-medium text-fg-2">Booked</h2>
        {bookings.data.length === 0 ? (
          <EmptyState title="Nothing booked yet">Pick an open time to book one.</EmptyState>
        ) : (
          <ul className="space-y-2">{bookings.data.map((booking) => <BookingRow key={booking.id} booking={booking} zone={zone} />)}</ul>
        )}
      </section>
      <section aria-labelledby="day-open">
        <h2 id="day-open" className="mb-3 text-sm font-medium text-fg-2">Open times</h2>
        {slots.isError ? <ErrorNote error={slots.error} retry={() => slots.refetch()} /> : open.length === 0 ? (
          <p className="rounded-md bg-surface-warm p-4 text-sm text-muted">No open times this day.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
            {open.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                onClick={() => onPickSlot(slot.startsAt)}
                className="tabular min-h-11 rounded-sm bg-surface text-sm font-medium text-fg shadow-[inset_0_0_0_1px_var(--border)] transition-quick hover:bg-surface-warm hover:shadow-[inset_0_0_0_1px_var(--border-strong)]"
                aria-label={`Book ${formatTime(slot.startsAt, zone)}`}
              >
                {formatTime(slot.startsAt, zone)}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WeekView({ resource, weekStart, today, onOpenDay }: {
  resource: BookingResourceSummary;
  weekStart: string;
  today: string;
  onOpenDay: (dateKey: string) => void;
}) {
  const zone = resource.timeZone;
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const bookings = useBookings({
    resourceId: resource.id,
    from: startOfZonedDay(weekStart, zone).toISOString(),
    to: startOfZonedDay(addDays(weekStart, 7), zone).toISOString(),
  });
  if (bookings.isPending) return <LoadingRows rows={5} label="Loading week" />;
  if (bookings.isError) return <ErrorNote error={bookings.error} retry={() => bookings.refetch()} />;

  return (
    <ol className="grid grid-cols-1 gap-2 lg:grid-cols-7">
      {days.map((day) => {
        const items = bookings.data.filter((booking) => zonedDateKey(booking.startsAt, zone) === day);
        const [weekday, rest] = formatDateKey(day).split(", ");
        return (
          <li key={day} className={cn("rounded-md bg-surface p-3 shadow-ring lg:min-h-48", day === today && "shadow-[inset_0_0_0_2px_var(--accent)]")}>
            <button type="button" onClick={() => onOpenDay(day)} className="-m-1 flex min-h-11 w-[calc(100%+8px)] items-baseline justify-between rounded-sm p-1 text-left hover:bg-surface-warm">
              <span className="text-sm font-semibold text-fg">{weekday} <span className="font-normal text-muted">{rest}</span></span>
              <span className="text-xs text-meta">{items.length === 0 ? "Free" : `${items.length} booked`}</span>
            </button>
            {items.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {items.map((booking) => (
                  <li key={booking.id} className="rounded-sm bg-accent/8 px-2 py-1.5 text-xs">
                    <span className="tabular font-semibold text-fg">{formatTime(booking.startsAt, zone)}</span>{" "}
                    <span className="text-fg-2">{booking.contactName ?? booking.title ?? "Appointment"}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function CalendarView() {
  const resources = useResources();
  const [resourceId, setResourceId] = useState<string | null>(null);
  const [view, setView] = useState<View>("day");
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; slot: string | null }>({ open: false, slot: null });

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
        description="Showroom appointments and repair intake."
        actions={<Button onClick={() => setDialog({ open: true, slot: null })}><Plus aria-hidden />Book appointment</Button>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          label="Calendar"
          value={resource.id}
          options={resources.data.map((item) => ({ value: item.id, label: item.kind === "showroom" ? "Showroom" : "Repair intake" }))}
          onChange={setResourceId}
        />
        <Segmented label="View" value={view} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} onChange={setView} />
      </div>
      <div className="mb-4 flex items-center gap-2">
        <Button variant="secondary" size="icon" aria-label={view === "day" ? "Previous day" : "Previous week"} onClick={() => setDateKey(addDays(current, -step))}><CaretLeft aria-hidden /></Button>
        <Button variant="secondary" size="icon" aria-label={view === "day" ? "Next day" : "Next week"} onClick={() => setDateKey(addDays(current, step))}><CaretRight aria-hidden /></Button>
        <h2 className="ml-2 flex-1 text-base font-semibold text-fg" aria-live="polite">
          {view === "day" ? formatDateKey(current, "long") : `Week of ${formatDateKey(weekStart)}`}
        </h2>
        {current !== today ? <Button variant="ghost" onClick={() => setDateKey(today)}>Today</Button> : null}
      </div>

      {view === "day" ? (
        <DayView resource={resource} dateKey={current} onPickSlot={(slot) => setDialog({ open: true, slot })} />
      ) : (
        <WeekView resource={resource} weekStart={weekStart} today={today} onOpenDay={(day) => { setDateKey(day); setView("day"); }} />
      )}

      <Card className="mt-6 bg-surface-warm shadow-none">
        <p className="text-sm text-muted">Times show in {resource.timeZone.split("/").pop()?.replaceAll("_", " ")} time. A slot is only booked once it is saved, so two people can never take the same time.</p>
      </Card>

      <BookingDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((state) => ({ ...state, open }))}
        resource={resource}
        initialDate={dialog.slot ? zonedDateKey(dialog.slot, resource.timeZone) : current}
        initialSlot={dialog.slot}
      />
    </>
  );
}
