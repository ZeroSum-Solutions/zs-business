"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { CreateBookingRequest } from "@zs/contracts";
import { CALENDAR_UNAVAILABLE, isApiError, isSlotTaken, type BookingRecord, type ResourceSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { dropBookedTime, refreshBookingCustomer, useKeys, useSlots } from "@/lib/queries";
import { addDays, formatDateKey, formatDay, formatTime, startOfZonedDay, zonedDateKey } from "@/lib/time";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { cn, revealOnFocus } from "@/lib/utils";
import { customerChangeMessage } from "./booking-customer-dialog";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";
import { SlotsError } from "./slots-error";

const CONFLICT_MESSAGE = "That time was just taken. Pick another slot.";

type Attempt = { request: CreateBookingRequest; customer: PickedCustomer | null; generation: number };
/** A booking that exists while its customer is still being linked (booking-customer.md BC-8). */
type Booked = { record: BookingRecord; customer: PickedCustomer };

/** The sheet's first day: the day in view, or today when the page shows a past day. */
export function firstBookableDay(dateKey: string, today: string): string {
  return dateKey < today ? today : dateKey;
}

export function BookingDialog({
  open,
  onOpenChange,
  resource,
  initialDate,
  initialSlot,
  onOpenerGone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ResourceSummary;
  initialDate: string;
  initialSlot?: string | null;
  /** Moves focus on when the control that opened the sheet is gone, as an open time just booked is. */
  onOpenerGone?: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const zone = resource.timeZone;
  const firstDay = firstBookableDay(initialDate, zonedDateKey(new Date(), zone));
  const [dateKey, setDateKey] = useState(firstDay);
  const opener = useRef<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSlot ?? null);
  const [conflict, setConflict] = useState(false);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  // One key per request body (the server derives the booking ID from it), so a retry after a
  // lost answer cannot double-book, and another calendar at the same time is a new booking.
  const intents = useIntentKey();
  // Moves on when the dialog opens, closes or switches calendar. An answer from an earlier
  // generation still refreshes the lists, but must not close, toast or flag the newer one.
  const generation = useDialogGeneration(open, resource.id);

  const bookedAt = (record: BookingRecord) => `${formatDay(record.startsAt, zone)} at ${formatTime(record.startsAt, zone)}`;

  // The link is its own write: the booking authority never holds customer data (B-17). A failed
  // link leaves the booking in place and offers "Link again" with the same key, so a lost answer
  // cannot link twice.
  const linkIntents = useIntentKey();
  const link = useMutation({
    mutationFn: ({ target }: { target: Booked; generation: number }) => {
      const input = { bookingId: target.record.id, contactId: target.customer.id, expectedRevision: 0 };
      return api.linkBookingContact(input, { idempotencyKey: linkIntents.keyFor(input) });
    },
    onSettled: (_result, error, { target }) =>
      linkIntents.settle({ bookingId: target.record.id, contactId: target.customer.id, expectedRevision: 0 }, error),
    onSuccess: async (_result, { target, generation: tag }) => {
      await refreshBookingCustomer(queryClient, keys);
      const current = generation.isCurrent(tag);
      if (current || generation.isClosed()) toast(`Booked ${bookedAt(target.record)} for ${target.customer.name ?? "the customer"}.`);
      if (current) onOpenChange(false);
    },
    onError: (_error, { target, generation: tag }) => {
      // The panel that offers "Link again" is gone; say where the booking stands instead.
      if (!generation.isCurrent(tag)) toast(`Booked ${bookedAt(target.record)}, but the customer was not linked. Open the booking to link them.`);
    },
  });
  const { reset: resetLink } = link;

  const book = useMutation({
    mutationFn: ({ request }: Attempt) => api.createBooking(request, { idempotencyKey: intents.keyFor(request) }),
    onSettled: (_record, error, attempt) => intents.settle(attempt.request, error),
    onSuccess: (record, attempt) => {
      dropBookedTime(queryClient, keys.slotsAll, record);
      void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
      // Home counts bookings taken this week.
      void queryClient.invalidateQueries({ queryKey: keys.resultsAll });
      const current = generation.isCurrent(attempt.generation);
      if (attempt.customer) {
        // Booked; the customer is a second step that may fail without undoing the booking.
        const target = { record, customer: attempt.customer };
        if (current) setBooked(target);
        link.mutate({ target, generation: attempt.generation });
        return;
      }
      // A late answer for a dialog that is now closed can still confirm the booking it made.
      if (current || generation.isClosed()) toast(`Booked ${formatDay(record.startsAt, zone)} at ${formatTime(record.startsAt, zone)}.`);
      if (current) onOpenChange(false);
    },
    onError: (error, attempt) => {
      if (!generation.isCurrent(attempt.generation)) return;
      if (isSlotTaken(error)) {
        setConflict(true);
        setSelected(null);
        void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
        void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      }
    },
  });
  const { reset } = book;

  useEffect(() => {
    if (open) {
      setDateKey(firstDay);
      setSelected(initialSlot ?? null);
      setConflict(false);
      setCustomer(null);
      setBooked(null);
      reset();
      resetLink();
    }
  }, [open, firstDay, initialSlot, reset, resetLink]);

  const days = useMemo(() => Array.from({ length: 14 }, (_, index) => addDays(firstDay, index)), [firstDay]);
  const query = useMemo(() => ({
    resourceId: resource.id,
    from: startOfZonedDay(dateKey, zone).toISOString(),
    to: startOfZonedDay(addDays(dateKey, 1), zone).toISOString(),
    zone,
  }), [resource.id, dateKey, zone]);
  const slots = useSlots(open ? query : null);

  const otherError = book.isError && !isSlotTaken(book.error) ? book.error : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Book an appointment"
        description={resource.name ?? "Calendar"}
        data-resource-id={resource.id}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        onCloseAutoFocus={(event) => {
          const gone = opener.current !== null && !opener.current.isConnected;
          opener.current = null;
          if (!gone || !onOpenerGone) return;
          event.preventDefault();
          onOpenerGone();
        }}
      >
        {booked ? (
          <div className="space-y-4" data-testid="booked-panel" aria-busy={link.isPending}>
            <p role="status" className="rounded-md bg-accent-tint p-3 text-sm text-fg">
              Booked {bookedAt(booked.record)}.{link.isPending ? ` Adding ${booked.customer.name ?? "the customer"}…` : ""}
            </p>
            {link.isError ? (
              <>
                <ErrorNote
                  error={link.error}
                  message={customerChangeMessage(link.error) ?? `The booking is saved, but we could not add ${booked.customer.name ?? "the customer"} to it.`}
                />
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    variant="ghost"
                    onClick={() => { toast(`Booked ${bookedAt(booked.record)} without a customer.`); onOpenChange(false); }}
                  >
                    Keep without a customer
                  </Button>
                  <Button onClick={() => link.mutate({ target: booked, generation: generation.current() })}>Link again</Button>
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg-2">Day</legend>
            <div className="-m-1 flex scroll-px-2 gap-2 overflow-x-auto p-1 sm:flex-wrap">
              {days.map((day) => {
                const active = day === dateKey;
                const [weekday, rest] = formatDateKey(day).split(", ");
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { setDateKey(day); setSelected(null); setConflict(false); }}
                    onFocus={revealOnFocus}
                    className={cn(
                      "flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center rounded-sm px-2 text-xs transition-quick",
                      active ? "bg-accent-tint text-accent-ink shadow-[inset_0_0_0_2px_var(--accent)]" : "bg-surface text-fg-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-inset",
                    )}
                  >
                    <span className="font-medium">{weekday}</span>
                    <span className={active ? "" : "text-meta"}>{rest}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {conflict ? (
            <div role="alert" className="mt-4 flex items-start gap-3 rounded-md bg-warn-tint p-3 text-sm text-fg">
              <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-warn" />
              <p>{CONFLICT_MESSAGE}</p>
            </div>
          ) : null}

          <fieldset className="mt-5">
            <legend className="mb-2 text-sm font-medium text-fg-2">Open times on {formatDateKey(dateKey, "long")}</legend>
            {slots.isPending ? <LoadingRows rows={2} label="Loading open times" /> : slots.isError ? (
              <SlotsError error={slots.error} retry={() => slots.refetch()} />
            ) : slots.data.slots.length === 0 ? (
              <p className="rounded-md bg-inset p-4 text-sm text-muted">No open times this day. Try another day.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="slot-list">
                {slots.data.slots.map((slot) => {
                  const active = selected === slot.startsAt;
                  return (
                    <button
                      key={slot.startsAt}
                      type="button"
                      aria-pressed={active}
                      data-starts-at={slot.startsAt}
                      onClick={() => { setSelected(slot.startsAt); setConflict(false); }}
                      className={cn(
                        "tabular min-h-11 rounded-sm text-sm font-medium transition-quick",
                        active ? "bg-accent-tint text-accent-ink shadow-[inset_0_0_0_2px_var(--accent)]" : "bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent-tint hover:shadow-[inset_0_0_0_1px_var(--accent)]",
                      )}
                    >
                      {formatTime(slot.startsAt, zone)}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className="mt-5">
            <CustomerPicker
              label="Who is it for? (optional)"
              selected={customer}
              onSelect={setCustomer}
              onClear={() => setCustomer(null)}
              disabled={book.isPending}
              hint="Add a customer to see their name on the calendar. You can also do this later."
            />
          </div>

          {otherError ? (
            <div className="mt-4">
              <ErrorNote error={otherError} {...(isApiError(otherError, "forbidden") ? { message: CALENDAR_UNAVAILABLE } : {})} />
            </div>
          ) : null}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              disabled={!selected || book.isPending}
              aria-busy={book.isPending}
              onClick={() => selected && book.mutate({ request: { resourceId: resource.id, startsAt: selected }, customer, generation: generation.current() })}
            >
              {selected ? `Book ${formatTime(selected, zone)}${customer ? ` for ${customer.name ?? "customer"}` : ""}` : "Pick a time"}
            </Button>
          </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
