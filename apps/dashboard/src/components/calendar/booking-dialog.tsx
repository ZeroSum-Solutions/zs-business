"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isSlotTaken, type ResourceSummary } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { keys, useSlots } from "@/lib/queries";
import { addDays, formatDateKey, formatDay, formatTime, startOfZonedDay } from "@/lib/time";
import { newId } from "@/lib/id";
import { cn } from "@/lib/utils";

const CONFLICT_MESSAGE = "That time was just taken. Pick another slot.";

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
  const toast = useToast();
  const zone = resource.timeZone;
  const [dateKey, setDateKey] = useState(initialDate);
  const [selected, setSelected] = useState<string | null>(initialSlot ?? null);
  const [conflict, setConflict] = useState(false);
  // One write attempt = one idempotency key (the server derives the booking ID from it),
  // so a retry cannot double-book.
  const attempt = useRef<{ startsAt: string; key: string } | null>(null);

  useEffect(() => {
    if (open) {
      setDateKey(initialDate);
      setSelected(initialSlot ?? null);
      setConflict(false);
    }
  }, [open, initialDate, initialSlot]);

  const days = useMemo(() => Array.from({ length: 14 }, (_, index) => addDays(initialDate, index)), [initialDate]);
  const query = useMemo(() => ({
    resourceId: resource.id,
    from: startOfZonedDay(dateKey, zone).toISOString(),
    to: startOfZonedDay(addDays(dateKey, 1), zone).toISOString(),
    zone,
  }), [resource.id, dateKey, zone]);
  const slots = useSlots(open ? query : null);

  const book = useMutation({
    mutationFn: (startsAt: string) => {
      if (attempt.current?.startsAt !== startsAt) {
        attempt.current = { startsAt, key: newId() };
      }
      return api.createBooking({ resourceId: resource.id, startsAt }, { idempotencyKey: attempt.current.key });
    },
    onSuccess: (record) => {
      attempt.current = null;
      void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
      toast(`Booked ${formatDay(record.startsAt, zone)} at ${formatTime(record.startsAt, zone)}.`);
      onOpenChange(false);
    },
    onError: (error) => {
      if (isSlotTaken(error)) {
        attempt.current = null;
        setConflict(true);
        setSelected(null);
        void queryClient.invalidateQueries({ queryKey: keys.slotsAll });
        void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      }
    },
  });

  const otherError = book.isError && !isSlotTaken(book.error) ? book.error : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Book an appointment" description={resource.name ?? "Calendar"} data-resource-id={resource.id}>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-fg-2">Day</legend>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
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
            <ErrorNote error={slots.error} retry={() => slots.refetch()} />
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

        {otherError ? <div className="mt-4"><ErrorNote error={otherError} /></div> : null}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            disabled={!selected || book.isPending}
            aria-busy={book.isPending}
            onClick={() => selected && book.mutate(selected)}
          >
            {selected ? `Book ${formatTime(selected, zone)}` : "Pick a time"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
