# Booking self-service: the customer's own link

Status: revision 1 (2026-11-10, first-client week). Code follows this file; a change to a numbered
rule needs a new revision of this file first.

Scope: a visitor who booked through the hosted booking page or the widget gets a confirmation
email with a private link. On that link they see their booking, cancel it, or move it to another
free time, with no account. This file adds three anonymous writes beside `booking.public_request`
(`public-intake.md` P-1, revision 8 there).

Out of scope: bookings an owner made by hand (no link is sent for them), a cancellation window or
fee, changing the service or the details, a "cancel all" for several bookings, telling the owner by
email or push, and SMS.

## Evidence and decisions

- Gap: a paying client's customers can book on the website but cannot cancel or move the booking
  without phoning the owner (first-client week plan, 2026-11-10). `booking.md` B-29..B-36 gave the
  owner a cancel; `booking.md` B-1 points here for the customer's side.
- Booking authority is unchanged: a cancel is `cancelBookingRow` (B-30, B-31) and a new time is
  `checkBookingSlot` plus `insertBooking` (B-19..B-21), all under the B-21 resource lock.
- Link style follows the unsubscribe token (`delivery.md` D-9): the tenant travels inside a signed
  token, so the route needs no cross-tenant lookup and a forged token costs only HMAC work.
- Why a second action sends the email: the dispatcher records one outbox event per action and the
  public request's own event feeds the automation events (`lead.created`, `booking.created`,
  `automation/events.ts`). Replacing it with a message event would silence automations, so the
  confirmation is its own action, dispatched right after the request commits.

## Numbered rules

**BS-1. Token.** `zsm1_` followed by 70 base64url characters that encode the tenant UUID (16
bytes), the booking UUID (16 bytes), an expiry (4 bytes, big-endian seconds since the Unix epoch)
and a 16-byte tag: HMAC-SHA-256 over `zsm1:<tenantId>:<bookingId>:<expiry>`, first 16 bytes. The
signing key is `HMAC-SHA-256(PUBLIC_BOOKING_KEY_SECRET, "zs:booking-manage:v1")`, so there is no
new secret to deploy and a leaked token key does not reveal the booking-key secret. The previous
booking-key secret still verifies during a rotation (`PUBLIC_BOOKING_KEY_PREVIOUS_SECRET`); only
the current one signs. The tag is compared in constant time. A token that is malformed, has a bad
tag, or names a booking the database does not hold for that tenant answers 404 `NotFound` with one
fixed body. The expiry is the booking's `starts_at`: after it the token answers 409 `Conflict`
with `details.reason = "link_expired"` and no data, before any database work.

**BS-2. Scope.** A token names one booking and nothing else. Every read and write takes the tenant
and booking from the verified token, never from the path, query or body (a body that carries
`tenantId`, `bookingId` or any unknown field is refused by the strict schema). A token never
authorizes another booking, another tenant, a list, or any owner route. Only a booking whose
`source` is `website` can be managed; any other booking answers 404.

**BS-3. Confirmation email.** After `booking.public_request` commits (and after BS-8's reschedule),
the server dispatches `booking.confirmation_send` for the new booking as the same synthetic public
actor. The idempotency key is `confirm:<bookingId>`, so a retry of the visitor's request, or a
second attempt, replays. The handler:
- needs the booking to be `confirmed`, `website` and not started; otherwise the result says
  `not_confirmed` and nothing is sent;
- picks the recipient: the intake item's contact when the outcome was `new_contact` or `linked`;
  for `possible_match`, only a matched contact whose email equals the address the visitor typed
  (lowest ID if several). With no such contact the result says `no_customer`; with no usable email
  (`usableEmail`), `no_email`. A suppressed address is dropped later by delivery (D-6);
- signs a token (BS-1) and emits the action's one outbox event, `message.send_requested`
  (`delivery.md` D-1): `transactional`, message ID derived from the tenant, the booking ID and the
  purpose `booking-confirmation`, so a booking is confirmed once. The body names the business, the
  local start time with its zone, and the private link; it never carries notes or contact details;
- is skipped when the server has no booking-key secret or public base URL (no link can be built).
A failure of this action never fails the visitor's booking: the public request still answers 201.
The cost of the second transaction is that a crash between the two loses the email for that
attempt; the visitor's retry with the same key sends it. A confirmation is an ordinary charged
message: an empty wallet or a suppressed address drops it later (D-6), and `queued` means handed to
delivery.

**BS-4. View.** `GET /public/v1/manage/:token` returns `{ state, businessName, serviceName,
startsAt, endsAt, timeZone, slotLengthMinutes, canChange, movedTo }`:
- `state` is `confirmed`, `cancelled`, `moved` (rescheduled by BS-8) or `started` (the start has
  passed or the booking is over);
- `canChange` is true only for `confirmed`;
- `movedTo` is set for `moved`: `{ startsAt, endsAt, token }`, where `token` is a fresh link for the
  new booking, so an old email still leads to the live booking;
- it returns no contact, notes, other bookings, internal IDs or owner reasons.

**BS-5. Free times.** `GET /public/v1/manage/:token/slots?from&to&zone` returns the owner slots
shape (`public-intake.md` P-11) for the booking's own resource. `resourceId` is not accepted. The
slots are for a booking that is `confirmed`; any other state answers 409 `not_changeable`. They are the
times the public booker would show: the booking's own current time is busy, so it is not offered.

**BS-6. Cancel.** `POST /public/v1/manage/:token/cancel`, body `{}`, header `Idempotency-Key`
(UUID). It runs `booking.self_cancel` with the synthetic actor: the dispatcher's idempotency
lock, then `cancelBookingRow` with `actorId = null` and the reason `Cancelled by the customer`.
It refuses a booking that started (409 `too_late`). An already cancelled booking returns the same
cancelled result (`changed` false), and a repeat under a new key writes no booking change. The
cancel sends no email to the customer (they just did it). The reply is the BS-4 view. There is no
cancellation window: a customer can cancel until the start (BS-12).

**BS-7. Idempotency.** The stored key is `manage:<bookingId>:<uuid>`, so a manage key never
collides with an owner or a public-request key, and every ID the action creates derives from the
tenant and that stored key. A replay returns the first result, even after a later change.

**BS-8. Reschedule.** `POST /public/v1/manage/:token/reschedule`, body `{ startsAt }` (a UTC
instant with milliseconds, `booking.md` B-3), header `Idempotency-Key`. It runs
`booking.self_reschedule`, one transaction:
1. take the B-21 resource lock for the booking's resource and lock the booking row;
2. refuse a booking that is not `confirmed` (409 `not_changeable`) or has started (409 `too_late`);
3. cancel it (`cancelBookingRow`, `actorId = null`, reason `Rescheduled by the customer`);
4. `checkBookingSlot` for the requested start on the same resource, then `insertBooking` with
   the same `source` and `intake_item_id`, and `rescheduled_from` set to the old booking.
Any failure in step 4 (`slot_unavailable`, `overlap`, a time outside the rules) rolls the whole
transaction back: the old booking stays confirmed and nothing else changes. The new booking is the
same resource and the resource's own slot length; the customer cannot change the service or the
details. A start equal to the booking's current start is refused before step 3 as 409 `same_time`.
A new time that overlaps the old one is allowed, because step 3 frees the old time first. Two customers moving to one free slot: the resource lock serializes them, one commits, the
other gets 409 `slot_unavailable` and keeps their old booking. The reply is `{ view, token }`
where `view` is the new booking's BS-4 view and `token` is its link; the server then dispatches the
BS-3 confirmation for the new booking (the subject says it was rescheduled). The Google calendar
push (google-calendar.md G-10) treats the new booking as any new confirmed booking.

**BS-9. Limits.** All counters live in the shared Postgres limiter (`public-intake.md` P-10), under
the request deadline, and a refused request charges nothing else. A forged or expired token is
charged to the caller's address (`manage-forged:<address>`, the address write rule). A valid token
is charged to its booking and its address: reads `manage-read:<tenant>:<booking>` and
`address-read:<address>`; writes `manage-write:<tenant>:<booking>`, `address-write:<address>` and
the tenant's `tenant-write:<tenant>`. Rules are the P-10 defaults. A write with a valid token is
charged before any database work; 429 carries `Retry-After`. Bodies over 8 KiB answer 413.

**BS-10. The page.** `GET /manage/:token` serves a static page in the style of the hosted booker
(`public-intake.md` P-14): same stylesheet, a script from the same origin, no inline code, no
third-party origin, never framed (`frame-ancestors 'none'`), `Referrer-Policy: no-referrer`,
`Cache-Control: no-store`, `noindex`. The token is in the URL only; the script reads it from its
own address and sends it in the path. The page shows the booking (BS-4), a "Cancel appointment"
button with a second "Yes, cancel it" step, and "Pick another time" with the day then time steps of
the booker. It freezes each attempt's key and body until a definitive reply (the P-14 rule), says
plainly when a time was lost, when the link has expired, when the booking is cancelled or moved,
and renders every server string with `textContent`.

**BS-11. Storage.** Migration `20261110300000_booking_reschedule.sql` adds one nullable column
`bookings.rescheduled_from uuid`, a composite foreign key `(tenant_id, rescheduled_from)` to
`bookings(tenant_id, id)`, a check that it is not the booking's own ID, and a partial index on
`(tenant_id, rescheduled_from)`. No grants change (the runtime role already inserts bookings and may
cancel through the four columns of B-35). RLS is unchanged. The audit trail is the `actions` rows
(`booking.self_cancel`, `booking.self_reschedule`, `booking.confirmation_send`), the `cancelled_*`
columns and `rescheduled_from`.

**BS-12. Known limits (revision 1).** These are decided, not forgotten.
- The owner is not told. The slot opens, and the cancelled booking is readable by the owner API
  (`status=cancelled`); the reason says "by the customer". An owner notice needs a notification
  design of its own.
- No cancellation window, notice period or fee; a customer can cancel or move until the start.
  The resource's minimum notice and horizon (B-8) still govern the new time.
- Only bookings made through the hosted page or widget get a link; an owner's booking for a
  linked customer does not (a later revision may send one).
- A `possible_match` visitor whose typed email matches no existing contact gets no email until the
  owner links them; nothing is sent to an unreviewed address.
- Anyone can type any email on the booking page, so a confirmation can reach a person who did not
  book. The link only manages that one booking, the P-10 limits apply, and the owner pays for
  the email as for any message.
- A Google event already pushed for a cancelled or moved booking stays (booking.md B-36).
- A token cannot be revoked before it expires; cancelling the booking is the revocation.
- Reminders already queued for a moved booking are not recalled (B-36).

**BS-13. Tests.** Real Postgres under `zs_runtime` unless noted: token round trip, tamper, wrong
secret, previous secret, expiry, canonical form; tenant B's token cannot read or change tenant A's
booking (a swapped booking ID inside a valid-looking token fails the tag); cancel then free slot;
cancel twice; cancel after start; reschedule moves the booking and carries the source and intake
item; reschedule that loses the slot rolls back to the old booking; two concurrent reschedules to
one slot (one commits, one `slot_unavailable`); reschedule over its own old time; confirmation
queued for a new contact, for a `possible_match` with a matching email, none for a phone-only match,
none for a `.invalid` address, once per booking on a replay; a confirmation failure does not fail
the request; rate limits (read, write, forged); strict bodies; the page's CSP and a fake-DOM render
test of the script.
