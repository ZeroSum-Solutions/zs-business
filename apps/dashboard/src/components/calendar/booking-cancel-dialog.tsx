"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { bookingCustomerName, isApiError, type BookingView, type CancelBookingResult } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useDialogGeneration } from "@/lib/dialog-generation";
import { useIntentKey } from "@/lib/intent-key";
import { refreshBookingCustomer, useKeys } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";

const REASON_MAX = 500;

/** What the owner reads when a cancel was refused (booking.md B-30). */
export function cancelBookingMessage(error: unknown): string | undefined {
  if (isApiError(error, "conflict") && error.reason === "booking_over") return "This appointment is already over, so it cannot be cancelled.";
  if (isApiError(error, "not_found")) return "That booking is no longer on file.";
  return undefined;
}

/** The line the toast shows once the booking is cancelled (booking.md B-33). */
export function cancelledToast(at: string, name: string | null, notice: CancelBookingResult["customerNotice"]): string {
  const who = name ?? "The customer";
  switch (notice) {
    case "queued": return `Cancelled ${at}. An email to ${who} is queued.`;
    case "off": return `Cancelled ${at}. No email was sent.`;
    case "no_email": return `Cancelled ${at}. ${who} has no email on file, so nothing was sent.`;
    case "already_cancelled": return `${at} was already cancelled.`;
    default: return `Cancelled ${at}.`;
  }
}

/**
 * Cancel one booking: free its time and, if the owner wants, tell the customer (booking.md B-29..B-35).
 * The reason is the team's own note; the email never carries it. It is one line (B-29).
 */
export function BookingCancelDialog({
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
  const intents = useIntentKey();
  const generation = useDialogGeneration(open, booking.id);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const notifyId = useId();
  const reasonId = useId();
  const name = bookingCustomerName(booking);
  const hasCustomer = booking.customer?.contactId != null;
  const at = `${formatDay(booking.startsAt, zone)} at ${formatTime(booking.startsAt, zone)}`;

  const cancel = useMutation({
    // The booking travels with the attempt: a send that waits offline must not follow a later dialog to another booking.
    mutationFn: (attempt: { bookingId: string; reason: string | null; notify: boolean; generation: number }) => {
      const input = { bookingId: attempt.bookingId, reason: attempt.reason, notifyCustomer: attempt.notify };
      return api.cancelBooking(input, { idempotencyKey: intents.keyFor(input) });
    },
    onSettled: (_result, error, attempt) =>
      intents.settle({ bookingId: attempt.bookingId, reason: attempt.reason, notifyCustomer: attempt.notify }, error),
    onSuccess: async (result, attempt) => {
      // The calendar, the open times and Home's counts all change with a freed time.
      await Promise.all([
        refreshBookingCustomer(queryClient, keys),
        queryClient.invalidateQueries({ queryKey: keys.slotsAll }),
        // A website request shows its booking; the Inbox and the intake list read the same row.
        queryClient.invalidateQueries({ queryKey: keys.intakeAll }),
        queryClient.invalidateQueries({ queryKey: keys.inboxAll }),
      ]);
      if (generation.isCurrent(attempt.generation) || generation.isClosed()) toast(cancelledToast(at, name, result.customerNotice));
      if (generation.isCurrent(attempt.generation)) onOpenChange(false);
    },
    onError: (error, attempt) => {
      if (!generation.isCurrent(attempt.generation)) return;
      // The booking is gone or over: the lists are stale, so refresh them under the message.
      if (cancelBookingMessage(error)) void refreshBookingCustomer(queryClient, keys);
    },
  });
  const { reset } = cancel;

  useEffect(() => {
    if (open) {
      setReason("");
      setNotify(true);
      reset();
    }
  }, [open, reset]);

  const trimmed = reason.trim();
  const tooLong = [...trimmed].length > REASON_MAX;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Cancel this booking?"
        description={`${at}${name ? ` · ${name}` : ""}`}
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={cancel.isPending} onClick={() => onOpenChange(false)}>Keep booking</Button>
            <Button
              variant="danger"
              disabled={cancel.isPending || tooLong}
              aria-busy={cancel.isPending}
              onClick={() => cancel.mutate({ bookingId: booking.id, reason: trimmed === "" ? null : trimmed, notify, generation: generation.current() })}
            >
              Cancel booking
            </Button>
          </div>
        }
      >
        <div className="space-y-4" aria-busy={cancel.isPending}>
          <p className="text-sm text-muted">The time opens up again for new bookings.</p>
          {hasCustomer ? (
            <div className="flex items-center justify-between gap-3 rounded-md bg-inset px-3 py-1">
              <Label id={notifyId} className="mb-0">Email {name ?? "the customer"} that it is cancelled</Label>
              <Switch checked={notify} onCheckedChange={setNotify} aria-labelledby={notifyId} disabled={cancel.isPending} />
            </div>
          ) : (
            <p className="rounded-md bg-inset px-3 py-2 text-sm text-muted">No customer is linked to this booking, so no email will be sent.</p>
          )}
          <div>
            <Label htmlFor={reasonId}>Reason (your team sees it, the customer does not)</Label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={REASON_MAX * 2 + 100}
              aria-invalid={tooLong || undefined}
              disabled={cancel.isPending}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional"
            />
            {tooLong ? <p role="alert" className="mt-1 text-sm text-danger">Keep it to {REASON_MAX} characters.</p> : null}
          </div>
          {cancel.isError ? <ErrorNote error={cancel.error} message={cancelBookingMessage(cancel.error)} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
