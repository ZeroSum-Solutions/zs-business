"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import type { CreateBookingRequest } from "@zs/contracts";
import { CALENDAR_UNAVAILABLE, isApiError, isSlotTaken, type ResourceSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useKeys, useSlots } from "@/lib/queries";
import { addDays, formatDateKey, formatDay, formatTime, startOfZonedDay } from "@/lib/time";
import { useIntentKey } from "@/lib/intent-key";
import { cn } from "@/lib/utils";
import { SlotsError } from "./slots-error";

const CONFLICT_MESSAGE = "That time was just taken. Pick another slot.";

type Attempt = { request: CreateBookingRequest; generation: number };

export function BookingDialog({
  open,
  onOpenChange,
  resource,
  initialDate,
  initialSlot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: ResourceSummary;
  initialDate: string;
  initialSlot?: string | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const zone = resource.timeZone;
  const [dateKey, setDateKey] = useState(initialDate);
  const [selected, setSelected] = useState<string | null>(initialSlot ?? null);
  const [conflict, setConflict] = useState(false);
  // One key per request body (the server derives the booking ID from it), so a retry after a
  // lost answer cannot double-book, and another calendar at the same time is a new booking.
  const intents = useIntentKey();
  // Bumped when the dialog opens, closes or switches calendar. An answer from an earlier
  // generation still refreshes the lists, but must not close, toast or flag the newer one.
  const generation = useRef(0);
  const isOpen = useRef(open);
  useEffect(() => {
    generation.current += 1;
    isOpen.current = open;
  }, [open, resource.id]);

  const book = useMutation({
    mutationFn: ({ request }: Attempt) => api.createBooking(request, { idempotencyKey: intents.keyFor(request) }),
    onSettled: (_record, error, attempt) => intents.settle(attempt.request, error),
    onSuccess: (record, attempt) => {
      void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
      const current = attempt.generation === generation.current;
      // A late answer for a dialog that is now closed can still confirm the booking it made.
      if (current || !isOpen.current) toast(`Booked ${formatDay(record.startsAt, zone)} at ${formatTime(record.startsAt, zone)}.`);
      if (current) onOpenChange(false);
    },
    onError: (error, attempt) => {
      if (attempt.generation !== generation.current) return;
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
      setDateKey(initialDate);
      setSelected(initialSlot ?? null);
      setConflict(false);
      reset();
    }
  }, [open, initialDate, initialSlot, reset]);

  const days = useMemo(() => Array.from({ length: 14 }, (_, index) => addDays(initialDate, index)), [initialDate]);
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
      <DialogContent title="Book an appointment" description={resource.name ?? "Calendar"} data-resource-id={resource.id}>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg-2">Day</legend>
          <div className="flex gap-2 overflow-x-auto pb-1 sm:flex-wrap">
            {days.map((day) => {
              const active = day === dateKey;
              const [weekday, rest] = formatDateKey(day).split(", ");
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => { setDateKey(day); setSelected(null); setConflict(false); }}
                  className={cn(
                    "flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center rounded-sm px-2 text-xs transition-quick",
                    active ? "bg-accent text-accent-on" : "bg-surface text-fg-2 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-surface-warm",
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
          <div role="alert" className="mt-4 flex items-start gap-3 rounded-md bg-warn/12 p-3 text-sm text-fg">
            <WarningCircle size={20} aria-hidden className="mt-px shrink-0 text-warn" />
            <p>{CONFLICT_MESSAGE}</p>
          </div>
        ) : null}

        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium text-fg-2">Open times on {formatDateKey(dateKey, "long")}</legend>
          {slots.isPending ? <LoadingRows rows={2} label="Loading open times" /> : slots.isError ? (
            <SlotsError error={slots.error} retry={() => slots.refetch()} />
          ) : slots.data.slots.length === 0 ? (
            <p className="rounded-md bg-surface-warm p-4 text-sm text-muted">No open times this day. Try another day.</p>
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
                      active ? "bg-accent text-accent-on" : "bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-warm",
                    )}
                  >
                    {formatTime(slot.startsAt, zone)}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>

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
            onClick={() => selected && book.mutate({ request: { resourceId: resource.id, startsAt: selected }, generation: generation.current })}
          >
            {selected ? `Book ${formatTime(selected, zone)}` : "Pick a time"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
