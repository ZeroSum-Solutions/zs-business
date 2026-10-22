# Booking customer link

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: let a member say who an owner-made booking is for, when booking it or later, and change
or clear that link. A website booking keeps its customer from the intake review
(`public-intake.md` P-12); this contract covers bookings with no intake item.

Out of scope: creating a contact from the booking dialog (the member picks an existing contact
or adds one in Customers first), messaging the customer, linking several people to one booking,
and changing `booking.create`.

## Evidence and decisions

- Audit U2-7 (2026-10-22, WARN): "Book appointment" never asks who the appointment is for.
  Every owner-made booking shows "No customer linked" with a "?" avatar, and nothing on the
  screen can link one later. Moved to the Phase 2 spec list (run plan, 2026-10-22).
- `booking.md` B-17 keeps the `booking.create` payload to `{bookingId, resourceId, startsAt}`,
  so the booking authority stays free of customer data. Decided 2026-10-22 (supervisor brief):
  the link is a separate action on its own table, and B-17 does not change.
- Bookings already carry a customer in list reads: `bookingSummarySchema.customer` is
  `{ contactId, name, status } | null` (`packages/contracts/src/intake.ts:188`). An owner link
  fills the same object, so the read shape and older dashboards need no change.
- Staff work the calendar and customers (`packages/contracts/src/members.ts`), so linking needs
  `calendar` and `customers`, not an owner permission.

## Rules

**BC-1. Table.** `booking_contacts(tenant_id, booking_id, contact_id, linked_by, linked_at,
revision)`, primary key `(tenant_id, booking_id)`, foreign keys to the tenant's booking and
contact, forced RLS by `tenant_id`. At most one contact per booking. `contact_id` is null while
the booking has no customer; the row, and its `revision`, stay once created, so the revision
only ever grows.

**BC-2. Only owner-made bookings.** A booking whose `source` is `website` (it has an intake item)
refuses a link with `Conflict` `details.reason = "intake_booking"`; its customer comes from the
intake review only (`public-intake.md` P-12).

**BC-3. Link.** `booking.contact.link` with `{ bookingId, contactId, expectedRevision }`, where
`expectedRevision` is 0 only when the booking has never had a row. It needs both `calendar` and `customers`. The
booking and the contact must belong to the caller's tenant; otherwise `NotFound`, never a hint
that the other tenant's row exists. A cancelled booking can still be linked, for the record.

**BC-4. Change and clear.** The same action with another `contactId` replaces the link;
`booking.contact.unlink` with `{ bookingId, expectedRevision }` sets `contact_id` to null.
Each change bumps `revision`; an unlink never deletes the row, so a revision read before an
unlink stays stale after a relink. A stale `expectedRevision` is `Conflict` `details.reason = "stale_revision"` with
`details.currentRevision`.

**BC-5. Idempotent.** Both actions run through the dispatcher with an idempotency key. A replay
returns the first result, even after a later change.

**BC-6. Read.** The bookings list and the booking detail return, for an owner-made booking with
a link, `customer: { contactId, name, status: "linked" }`, where `name` is the contact's current
name; with no link, `customer` stays null. Website bookings keep their P-12 customer.

**BC-7. Contact deletion.** Deleting or erasing a contact sets `contact_id` to null on its
`booking_contacts` rows and bumps their revisions in the same transaction; the bookings stay,
with no customer.

**BC-8. Book and link in one step.** The booking dialog has an optional "Who is it for?"
contact search. On submit it runs `booking.create`, then, when a contact was picked,
`booking.contact.link`. If the link fails, the booking stays booked: the dialog says the booking
was made but the customer was not linked, and offers "Link again". It never cancels or
re-creates the booking.

**BC-9. Link later.** The booking detail shows the customer with Change and Remove, or "Link a
customer" when none is set, for members who hold both permissions. After a change, the
calendar, the Home lists and the contact's page show the new name without a reload.

**BC-10. Tenancy.** A member of tenant B cannot link, read or unlink tenant A's booking
contacts through the actions, the reads or direct SQL as the runtime role: a two-tenant denial
test covers all three.

## First slice

Migration (`booking_contacts`, RLS, contact deletion clearing `contact_id`), both actions with their
contracts, the list and detail reads, the dialog's optional contact search and the detail's
Change and Remove.

Acceptance test: a staff member books 10:00 for "Ana Ruiz" in one step; the bookings list
returns `customer: { contactId, name: "Ana Ruiz", status: "linked" }`. Linking a website booking
is `Conflict` `intake_booking`. A second link with the old revision is `Conflict`
`stale_revision`. Unlink returns the booking to "No customer linked", and a link sent with the
revision read before the unlink, after a relink, is still `stale_revision`. Deleting the contact
removes the link and keeps the booking. Tenant B gets `NotFound` for tenant A's booking. The
e2e books with a customer on phone and desktop and sees the name on the calendar and on Home.

## Known limits

- One contact per booking; group bookings need a later revision.
- The link carries no consent: reminders still need the consent `delivery.md` D-6 checks.
