"use client";

import { Globe } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorNote } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { isApiError, type ContactRecord, type IntakeItemRecord } from "@/lib/api";
import { useApi } from "@/lib/api/react";
import { useIntentKey } from "@/lib/intent-key";
import { useContactNames, useIntakeItems, useKeys, useResources } from "@/lib/queries";
import { formatDay, formatTime } from "@/lib/time";
import { formatPhone } from "@/lib/utils";

type Review = { kind: "link"; itemId: string; contactId: string } | { kind: "reject"; itemId: string };

/**
 * Website bookings whose email or phone is already on a customer record (public-intake.md P-7).
 * The booking already holds the slot; the owner only decides who the visitor is. Nothing the
 * visitor typed changes a customer until the owner links it, and even then recorded consent stays.
 */
export function WebsiteRequests() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys } = useKeys();
  const toast = useToast();
  const intents = useIntentKey();
  const items = useIntakeItems("possible_match");
  // Only the customers these requests name, however long the customer list is.
  const matched = useMemo(() => items.data?.items.flatMap((item) => item.matchedContactIds) ?? [], [items.data]);
  const contacts = useContactNames(matched);
  const resources = useResources();

  const review = useMutation({
    mutationFn: (input: Review) => {
      const options = { idempotencyKey: intents.keyFor(input) };
      return input.kind === "link"
        ? api.linkIntakeItem({ itemId: input.itemId, contactId: input.contactId }, options)
        : api.rejectIntakeItem(input.itemId, options);
    },
    onSettled: (_result, error, input) => {
      intents.settle(input, error);
      void queryClient.invalidateQueries({ queryKey: keys.intakeAll });
      void queryClient.invalidateQueries({ queryKey: keys.bookingsAll });
      void queryClient.invalidateQueries({ queryKey: keys.contactsAll });
      // Linking moves the request into that customer's Inbox thread (inbox-home.md I-1).
      void queryClient.invalidateQueries({ queryKey: keys.inboxAll });
    },
    onSuccess: (item, input) => {
      const name = input.kind === "link" ? contactName(contacts.data, input.contactId) : null;
      toast(input.kind === "link" ? `Linked the booking to ${name ?? "the customer"}.` : `Kept ${item.submitted.name} apart from your customers.`);
    },
    onError: (error) => {
      if (isApiError(error, "conflict") && error.reason === "already_reviewed") toast("Someone already reviewed this request.", "info");
    },
  });

  if (items.isPending || items.isError || items.data.items.length === 0) {
    return items.isError ? <div className="mb-5"><ErrorNote error={items.error} retry={() => items.refetch()} /></div> : null;
  }

  const zoneFor = (item: IntakeItemRecord) =>
    resources.data?.find((resource) => resource.id === item.booking?.resourceId)?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section aria-labelledby="website-requests-title" className="tray mb-4">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 lg:px-4">
        <h2 id="website-requests-title" className="text-base leading-6 font-bold text-fg">Website bookings to review</h2>
        <Badge tone="warn">{items.data.items.length}</Badge>
      </div>
      <p className="mb-2.5 px-3 text-caption text-muted lg:px-4">
        These people booked on your website with an email or phone you already have. The time is held. Confirm who they are, or keep them separate.
      </p>
      {review.isError && !(isApiError(review.error, "conflict") && review.error.reason === "already_reviewed") ? (
        <div className="mb-2"><ErrorNote error={review.error} /></div>
      ) : null}
      <ul className="grid gap-1.5 lg:gap-2">
        {items.data.items.map((item) => {
          const zone = zoneFor(item);
          const busy = review.isPending && review.variables?.itemId === item.id;
          return (
            <li key={item.id} data-testid="website-request" className="card p-4 lg:px-6 lg:py-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Avatar name={item.submitted.name} size="sm" />
                <p className="font-bold text-fg">{item.submitted.name}</p>
                <Badge tone="accent"><Globe aria-hidden />Website</Badge>
                {item.booking ? (
                  <p className="tabular text-sm text-muted">{formatDay(item.booking.startsAt, zone)}, {formatTime(item.booking.startsAt, zone)}</p>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-fg-2">
                {[item.submitted.email, formatPhone(item.submitted.phone)].filter(Boolean).join(" · ")}
              </p>
              {item.submitted.notes ? <p className="mt-1 text-sm text-muted">“{item.submitted.notes}”</p> : null}
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                {item.matchedContactIds.map((contactId) => {
                  const name = contactName(contacts.data, contactId) ?? "this customer";
                  return (
                    <Button
                      key={contactId}
                      variant="secondary"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => review.mutate({ kind: "link", itemId: item.id, contactId })}
                    >
                      Same person as {name}
                    </Button>
                  );
                })}
                <Button variant="ghost" disabled={busy} onClick={() => review.mutate({ kind: "reject", itemId: item.id })}>
                  Different person
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function contactName(contacts: ContactRecord[] | undefined, id: string): string | null {
  const contact = contacts?.find((item) => item.id === id);
  return contact ? contact.displayName ?? contact.email ?? formatPhone(contact.phone) : null;
}
