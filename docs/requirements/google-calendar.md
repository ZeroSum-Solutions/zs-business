# M5: Google Calendar busy sync

Status: draft contract for M5, provider 3 (2026-10-20), revision 2. Code follows this file; a
change to a numbered rule needs a new revision of this file first.

Scope: an owner connects one Google Calendar to one booking resource. Busy time on that
calendar blocks the resource's slots (as `booking_external_blocks`, booking.md B-13, B-21), and
bookings made here are pushed to the calendar as events. Disconnecting revokes the grant and
removes the blocks. Code and tests only: the cloud holds no Google client, key or token and
never calls Google. Tests use an in-process fake Google server. Everything is off until the Mac
sets the variables in G-12.

## Evidence and decisions

- Plan (approved 2026-10-18): M5 providers one at a time, in the order Resend, Stripe, Twilio,
  Google, Activepieces. Twilio is built in its own thread; this file is Google.
- Provider behaviour (studied from Google's public OAuth 2.0 and Calendar API v3 documentation,
  in our own words):
  - OAuth: the browser goes to `accounts.google.com/o/oauth2/v2/auth` with `client_id`,
    `redirect_uri`, `response_type=code`, `scope`, `state`, `access_type=offline`,
    `prompt=consent` and a PKCE `code_challenge` (S256). Google redirects back with `code` and
    `state`, or with `error`. `POST oauth2.googleapis.com/token` (form) exchanges the code (with
    `code_verifier`) for an access token, a refresh token and, with the `openid email` scopes,
    an `id_token` naming the account. `grant_type=refresh_token` mints a new access token;
    `invalid_grant` means the grant was revoked or expired. `POST oauth2.googleapis.com/revoke`
    with `token=` revokes the grant.
  - Events: `GET /calendar/v3/calendars/{id}/events` with `singleEvents=true` lists event
    instances in pages (`pageToken`, `nextPageToken`); the last page of a full list carries a
    `nextSyncToken`. Passing `syncToken` returns only changes since then, cancelled events
    included (`status: cancelled`), and cannot be combined with `timeMin`/`timeMax`. An expired
    sync token answers 410, which means "start again with a full list". An event has `id`,
    `status`, `transparency` (`opaque` by default, `transparent` means free), `eventType`,
    `start`/`end` as `dateTime` or an all-day `date`, `attendees` (with `self` and
    `responseStatus`) and `extendedProperties.private`.
  - `POST /calendars/{id}/events` creates an event; a client-chosen `id` (characters `a-v` and
    `0-9`, 5 to 1024 long) makes a repeat answer 409, so an insert is idempotent.
  - Push: `POST /calendars/{id}/events/watch` with `{ id, type: "web_hook", address, token }`
    opens a channel that expires (`expiration`, milliseconds); Google then posts to `address`
    with headers `X-Goog-Channel-ID`, `X-Goog-Channel-Token`, `X-Goog-Resource-State` (`sync`
    first, then `exists`) and `X-Goog-Message-Number`, and no body. `POST /calendar/v3/channels/stop`
    with `{ id, resourceId }` closes it.
- Runtime roles never write external blocks (booking.md B-21 grants). Like the delivery and
  billing workers, a service-role calendar worker moves provider state, taking the same B-21
  resource lock in the same transaction; owner intent (connect, disconnect) goes through the
  dispatcher.

## Numbered rules

**G-1. Connecting.** `POST /v1/calendar/google/connect { resourceId }` with an
`Idempotency-Key`, owners only (`publish`: it decides what the public pages offer), answers
`{ authorizeUrl }` and changes nothing. The connection ID derives from the tenant and the key.
`state` is a signed token (HMAC-SHA-256 by `GOOGLE_STATE_SECRET`, `previous` verifying through
a rotation) naming the tenant, the member, the resource, the connection ID and an expiry 10
minutes ahead. The PKCE verifier derives from the state secret and the connection ID, so nothing
is stored before the callback. Scopes: `openid email https://www.googleapis.com/auth/calendar.events`.
Off (404) without Google config.

**G-2. Callback.** `GET /oauth/google/callback` is anonymous. A missing, forged or expired
`state` answers 400 (no redirect: nothing proves where the caller came from). Otherwise it
redirects (303) to `GOOGLE_RETURN_URL` with `calendar=connected` or `calendar=error&reason=…`:
`denied` when Google sent `error`, `exchange_failed` when the code exchange fails, `no_refresh_token`
when Google sent none, `scope_missing` when the granted scope lacks calendar events. On success it
runs `calendar.google.connect` through the dispatcher as the member the state names, under the
reserved key `oauth-google:<connection id>`, so that member must still be an owner and a reload
replays the stored result. The action refuses any other key, so it never runs through an approval
or with a payload the callback did not build. A reload counts as `connected` only while that
connection is `active`; any other existing row answers `reason=conflict`. When the callback fails
after the code exchange it stores nothing and does not revoke: Google revokes a whole grant, so a
revoke could end another live connection on the same Google account, and the callback cannot see
other tenants' rows. The refresh token is sealed (G-3) before the action sees it. The access
token is never stored.

**G-3. Sealed tokens.** The API holds only a public key (`GOOGLE_TOKEN_PUBLIC_KEY`, X25519); the
calendar worker holds the private key. A refresh token is sealed as
`zsg1.<ephemeral public key>.<iv>.<ciphertext+tag>` (base64url): X25519 with a fresh ephemeral
key, HKDF-SHA-256, AES-256-GCM, with additional data `zsg1:<tenant>:<connection>`, so a sealed
token opens only for its own row. The API can store a grant but never read one. The sealed
token also sits in the connect action's stored payload; it opens only with the worker's key and
is useless once the grant is revoked (G-9).

**G-4. Connection rows.** `calendar_connections` (tenant table) holds one row per grant: the
resource, `calendar_id` (`primary`), the Google account email from the `id_token`, `status`
(`active`, `reauthorize`, `disconnecting`, `disconnected`), the sealed token, sync state, the
watch channel and timestamps. At most one row per resource is `active` or `reauthorize`. Connecting
a resource that already has one moves the old row to `disconnecting` in the same action, and the
worker cleans it up beside its replacement. The
runtime role reads its tenant's rows (the sealed token is useless without the worker's key),
inserts through the connect action (a new row starts `active`) and may set only `status`, from
`active` or `reauthorize` to `disconnecting`, and `updated_at`; a trigger refuses any other status
change by the runtime role.

**G-5. Disconnecting.** `POST /v1/calendar/connections/:id/disconnect` with an `Idempotency-Key`,
owners only, runs `calendar.google.disconnect`: an `active` or `reauthorize` connection becomes
`disconnecting`; a `disconnecting` or `disconnected` one is answered as it is. `GET
/v1/calendar/connections` lists the tenant's connections (`calendar`), never a token.

**G-6. Sync.** The calendar worker (service role) claims due connections (`active`,
`next_sync_at <= now`, not leased) with `FOR UPDATE SKIP LOCKED` and leases each, then works
outside the transaction: it mints an access token, lists events (incremental with the stored
sync token; full otherwise, from 1 day ago to 400 days ahead, at most 20 pages of 250) and
applies the result in one transaction that takes the B-21 lock for the connection's resource.
A 410 clears the sync token and runs a full list in the same pass. A full list replaces every
block of the connection; an incremental one upserts and deletes by event ID. The next sync is due
after `CALENDAR_POLL_INTERVAL_MS` (default 15 minutes), sooner on a push (G-8), and a full list
runs at least every 7 days so instances entering the 400-day window are seen. When a
full list reaches the page cap it is incomplete: the worker then lists again from 1 day ago to 30
days ahead and, if that list is complete, replaces the connection's blocks that start in that
window and upserts the rest; it stores no sync token, so the next sync is full again.

**G-7. What is busy.** An event blocks time when its `status` is not `cancelled`, its
`transparency` is not `transparent`, its `eventType` is not `workingLocation` or `birthday`, and
the calendar's own attendee entry (`self`) has not `declined`. A timed event blocks
`[start, end)`; an all-day event blocks from midnight of its start date to midnight of its end
date in the resource's time zone. An event this system pushed for this
connection's own tenant and resource (`extendedProperties.private` `zs_tenant` and `zs_resource`
both match) never becomes a block; an event pushed for another resource or tenant that shares the
calendar blocks like any other. Blocks are stored with `source = google`, the connection and the event ID
(unique per connection). A block may overlap an existing booking: it stops new slots and changes
no booking.

**G-8. Push notifications.** When `GOOGLE_WEBHOOK_URL` is set the worker keeps one watch channel
per active connection, with `token = HMAC-SHA-256(GOOGLE_CHANNEL_SECRET, channel id)`, renewing it
a day before it expires and stopping the old one. `POST /webhooks/google/calendar` checks the
token in constant time before any database work (401 otherwise) and records the channel ID and
message number once in `calendar_push_notifications`, a platform table the runtime role may only
insert into; it answers 200. The worker marks those connections due now. Notifications carry no
calendar data, so a forged one could only cause an early sync.

**G-9. Cleanup.** For a `disconnecting` connection the worker stops its channel, revokes the
grant (an already invalid token counts as revoked) unless another `active` connection may share
it: one with the same Google account (emails compared without case), or, when either row has no
account email, one on the same tenant and resource. Google revokes a whole grant, not one refresh
token, so a revoke would end the reconnect that replaced this row. A `reauthorize` row shares
nothing (its grant is already gone). It then deletes its blocks under the B-21 lock, and
sets `disconnected`, clearing the sealed token, sync token and channel. Events already pushed
stay in the owner's calendar. A refresh that answers `invalid_grant` sets `reauthorize`: the
blocks stay (a stale block refuses a slot; a missing one could double-book) until the owner
reconnects or disconnects.

**G-10. Bookings out.** For every confirmed booking on a resource with an `active` connection
that has not ended, the worker records one `calendar_pushes` row and inserts one event with
`id` = the booking ID's 32 hex digits, `summary` = `GOOGLE_EVENT_TITLE` (default `Booked`, no
customer data), the booking's start and end, `transparency: opaque` and
`extendedProperties.private` `zs_booking`, `zs_tenant` and `zs_resource`. 200 or 409 marks it
`pushed`; a 5xx, 429, 401 (the grant went away mid-pass; the next refresh decides `reauthorize`) or
network error retries with backoff; another refusal, or 8 failed attempts, marks it `failed` with
the error code. A worker run stops claiming new work once its deadline passes, so a run ends
inside the function's time limit.

**G-11. Tenancy.** `calendar_connections` and `calendar_pushes` have `tenant_id`, forced RLS and
the tenant policy, and are in the catalog isolation test; every relationship includes
`tenant_id`. The worker names `tenant_id` in every statement. `calendar_push_notifications` is a
platform table (one Google project), like `stripe_events`.

**G-12. Configuration the Mac sets.** API function: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URL` (`https://<api host>/oauth/google/callback`, also registered in Google
Cloud), `GOOGLE_RETURN_URL` (the dashboard page to land on), `GOOGLE_STATE_SECRET` (optional
`GOOGLE_STATE_PREVIOUS_SECRET`), `GOOGLE_TOKEN_PUBLIC_KEY`, `GOOGLE_CHANNEL_SECRET`; all or
none. Calendar function: `CALENDAR_WORKER=on`, `CRON_SECRET`, `CALENDAR_DATABASE_URL` (a login
that may `SET ROLE service_role`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_TOKEN_PRIVATE_KEY`, `GOOGLE_CHANNEL_SECRET`, optional `GOOGLE_WEBHOOK_URL`
(`https://<api host>/webhooks/google/calendar`), `GOOGLE_EVENT_TITLE`. Build: optional
`CALENDAR_CRON_SCHEDULE`. Base URLs (`GOOGLE_OAUTH_BASE_URL`, `GOOGLE_TOKEN_BASE_URL`,
`GOOGLE_API_BASE_URL`) exist for tests. In Google Cloud: an OAuth client (web), the Calendar API
enabled, the consent screen with the three scopes, and the webhook domain verified for push.

## Known limits (revision 2)

- One calendar (`primary`) per resource, one resource per connection.
- Bookings are only pushed, never updated or deleted in Google (bookings have no cancellation yet).
- Busy time comes from one calendar's events; free/busy across several calendars is not read.
- The dashboard has no connect screen yet; the API routes are ready for it.
- The OAuth `state` is a 10-minute bearer token and is not bound to the browser that started the
  flow, so whoever holds an `authorizeUrl` can finish it with their own Google account. Binding it
  to a cookie needs the page that starts the flow, which comes with the dashboard connect screen.
- A disconnect followed by a reconnect of the same account within one worker revoke call can lose
  the new grant; the new row then shows `reauthorize` and the owner connects again.
- Vercel environment variables are project-wide: in one project the API function can also read
  `GOOGLE_TOKEN_PRIVATE_KEY` and `CALENDAR_DATABASE_URL`. G-3 holds at code level; a separate
  Vercel project for the workers makes it hold at deploy level too.
