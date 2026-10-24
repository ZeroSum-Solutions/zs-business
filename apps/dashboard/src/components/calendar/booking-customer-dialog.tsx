"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ErrorNote, LoadingRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, isStaleRevision, type BookingView } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { refreshBookingCustomer, useBooking, useKeys } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";
import { CustomerPicker, type PickedCustomer } from "./customer-picker";

/** What the owner reads when a customer change was refused (booking-customer.md BC-3, BC-9). */
export function customerChangeMessage(error: unknown): string | undefined {
  if (isStaleRevision(error)) return "This booking's customer changed since you opened it. The latest is shown. Try again.";
  if (isApiError(error, "conflict") && error.reason === "intake_booking") return "A website booking takes its customer from the website request.";
  if (isApiError(error, "not_found")) return "That booking or customer is no longer on file.";
  return undefined;
}

type Change = { kind: "link"; customer: PickedCustomer; expectedRevision: number } | { kind: "unlink"; name: string | null; expectedRevision: number };

/**
 * Who an owner-made booking is for: link a customer, change them, or remove them (BC-8, BC-9).
 * The revision comes from a fresh read of the booking, so two people changing it at once cannot
 * overwrite each other: the second gets the latest and tries again.
 */
export function BookingCustomerDialog({
  booking,
  zone,
  open,
  onOpenChange,
}: {
  booking: BookingView;
  zone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const detail = useBooking(open ? booking.id : null);
  const [changing, setChanging] = useState(false);
  const intents = useIntentKey();
  const generation = useDialogGeneration(open, booking.id);

  // The key covers the booking too: a lost answer for one booking must not tag another's request.
  const intentOf = (input: Change) => ({ bookingId: booking.id, ...input });
  const change = useMutation({
    mutationFn: (attempt: { change: Change; generation: number }) => {
      const input = attempt.change;
      const options = { idempotencyKey: intents.keyFor(intentOf(input)) };
      return input.kind === "link"
        ? api.linkBookingContact({ bookingId: booking.id, contactId: input.customer.id, expectedRevision: input.expectedRevision }, options)
        : api.unlinkBookingContact({ bookingId: booking.id, expectedRevision: input.expectedRevision }, options);
    },
    onSettled: (_result, error, attempt) => intents.settle(intentOf(attempt.change), error),
    onSuccess: async (result, attempt) => {
      // Calendar, Home and the customer page read the same bookings; refetch them before closing.
      await refreshBookingCustomer(queryClient, keys);
      const at = `${formatDay(booking.startsAt, zone)} at ${formatTime(booking.startsAt, zone)}`;
      const name = result.customer?.name ?? (attempt.change.kind === "unlink" ? attempt.change.name : null) ?? "the customer";
      if (generation.isCurrent(attempt.generation) || generation.isClosed()) {
        toast(attempt.change.kind === "link" ? `${at} is now booked for ${name}.` : `Removed ${name} from the booking on ${at}.`);
      }
      if (generation.isCurrent(attempt.generation)) onOpenChange(false);
    },
    onError: (error, attempt) => {
      if (!generation.isCurrent(attempt.generation)) return;
      // The booking moved on under us: show the latest customer and revision before another try.
      if (isStaleRevision(error)) void queryClient.invalidateQueries({ queryKey: keys.booking(booking.id) });
    },
  });
  const { reset } = change;

  useEffect(() => {
    if (open) {
      setChanging(false);
      reset();
    }
  }, [open, reset]);

  const customer = detail.data?.customer ?? null;
  const revision = detail.data?.customerRevision ?? 0;
  const run = (next: Change) => change.mutate({ change: next, generation: generation.current() });
  const pickerLabel = customer ? "Choose another customer" : "Who is it for?";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Customer for this booking"
        description={`${formatDay(booking.startsAt, zone)} at ${formatTime(booking.startsAt, zone)}`}
        footer={<div className="flex justify-end"><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button></div>}
      >
        {detail.isPending ? <LoadingRows rows={2} label="Loading customer" /> : detail.isError ? (
          <ErrorNote error={detail.error} retry={() => detail.refetch()} />
        ) : (
          <div className="space-y-4" aria-busy={change.isPending}>
            {customer && !changing ? (
              <>
                <div className="flex min-h-14 items-center gap-3 rounded-md bg-accent-tint px-3 py-2" data-testid="booking-customer">
                  <Avatar name={customer.name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-bold text-fg">{customer.name ?? "Unnamed customer"}</p>
                    {customer.contactId ? (
                      <Link href={`/customers/${customer.contactId}`} className="text-sm font-medium text-accent-ink underline-offset-4 hover:underline">View customer</Link>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button variant="secondary" disabled={change.isPending} onClick={() => { setChanging(true); change.reset(); }}>Change</Button>
                  <Button
                    variant="danger-outline"
                    disabled={change.isPending}
                    aria-busy={change.isPending}
                    onClick={() => run({ kind: "unlink", name: customer.name, expectedRevision: revision })}
                  >
                    Remove
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{customer ? "Pick the right customer. The booking moves to them." : "No customer linked. Pick one to link them to this booking."}</p>
                <CustomerPicker
                  browse
                  label={pickerLabel}
                  selected={null}
                  disabled={change.isPending}
                  onSelect={(picked) => run({ kind: "link", customer: picked, expectedRevision: revision })}
                />
                {customer ? <Button variant="ghost" disabled={change.isPending} onClick={() => { setChanging(false); change.reset(); }}>Keep {customer.name ?? "the current customer"}</Button> : null}
              </>
            )}
            {change.isError ? <ErrorNote error={change.error} message={customerChangeMessage(change.error)} /> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
