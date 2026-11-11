"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type BookingOutcome, type BookingView } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { refreshBookingCustomer, useKeys } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";

const OUTCOMES: readonly { value: BookingOutcome; label: string }[] = [
  { value: "completed", label: "Completed" },
  { value: "no_show", label: "No-show" },
];

export const outcomeLabel = (outcome: BookingOutcome): string => (outcome === "completed" ? "Completed" : "No-show");

/** B-39: the owner may mark a booking once its start time has passed, and never a cancelled one. */
export function canMarkOutcome(booking: BookingView, now: number): boolean {
  return booking.status === "confirmed" && Date.parse(booking.startsAt) <= now;
}

/** What the owner reads when a mark was refused (booking.md B-39). */
export function bookingOutcomeMessage(error: unknown): string | undefined {
  if (isApiError(error, "conflict") && error.reason === "booking_not_started") return "This appointment has not started yet, so it cannot be marked.";
  if (isApiError(error, "conflict") && error.reason === "booking_cancelled") return "This booking was cancelled, so it has no outcome.";
  if (isApiError(error, "not_found")) return "That booking is no longer on file.";
  return undefined;
}

/** The line the toast shows once a mark is saved (B-39: the same mark again changes nothing). */
export function outcomeToast(at: string, outcome: BookingOutcome, changed: boolean): string {
  if (!changed) return `${at} was already marked ${outcomeLabel(outcome).toLowerCase()}.`;
  return outcome === "completed"
    ? `Marked ${at} completed. A review request can follow.`
    : `Marked ${at} as a no-show. No review request will be sent.`;
}

/** The outcome on an appointment, once the owner has marked it (B-37). */
export function OutcomeBadge({ booking }: { booking: BookingView }) {
  if (!booking.outcome) return null;
  return (
    <Badge tone={booking.outcome === "completed" ? "success" : "warn"} data-testid="outcome-badge" data-outcome={booking.outcome}>
      {outcomeLabel(booking.outcome)}
    </Badge>
  );
}

/**
 * Mark a started appointment Completed or No-show (booking.md B-37..B-43). The pressed button is the current
 * mark; pressing the other one replaces it (B-39). Review requests go only to Completed bookings (B-43).
 */
export function BookingOutcomeControl({ booking, zone }: { booking: BookingView; zone: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const at = `${formatDay(booking.startsAt, zone)} at ${formatTime(booking.startsAt, zone)}`;

  const mark = useMutation({
    mutationFn: (attempt: { bookingId: string; outcome: BookingOutcome }) =>
      api.setBookingOutcome(attempt, { idempotencyKey: intents.keyFor(attempt) }),
    onSettled: (_result, error, attempt) => intents.settle(attempt, error),
    onSuccess: async (result) => {
      await refreshBookingCustomer(queryClient, keys);
      toast(outcomeToast(at, result.outcome, result.changed));
    },
    onError: (error) => {
      // The booking changed under us (cancelled, or not started by the server's clock): show the fresh list.
      if (bookingOutcomeMessage(error)) void refreshBookingCustomer(queryClient, keys);
    },
  });

  return (
    <div className="mt-1" data-testid="outcome-control">
      <div role="group" aria-label={`Outcome of the appointment at ${formatTime(booking.startsAt, zone)}`} className="flex flex-wrap items-center gap-2">
        {OUTCOMES.map((option) => {
          const active = booking.outcome === option.value;
          return (
            <Button
              key={option.value}
              variant={active ? "primary" : "secondary"}
              aria-pressed={active}
              aria-busy={mark.isPending && mark.variables?.outcome === option.value}
              disabled={mark.isPending}
              onClick={() => { if (!active) mark.mutate({ bookingId: booking.id, outcome: option.value }); }}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {mark.isError ? <ErrorNote error={mark.error} message={bookingOutcomeMessage(mark.error)} /> : null}
    </div>
  );
}
