# M3a: public intake contract

Status: frozen contract for M3a/M3b (2026-10-18), revision 10 (2026-11-10; revision 5 text kept below). Revision 2
(review r1): P-8 and P-13 keep the disclosure text on each consent row and fix one text per
version; P-9 checks the slot before identity work; P-10 names the client address source;
P-14 retries. Revision 3 (review r3): P-8 and P-13 make the disclosure history append-only.
Revision 4 (review r4): P-14 puts public requests under the request deadline and answers a
busy idempotency key with a retryable 503. Revision 5 (review r5): P-10 keeps public intake
off in hosted deploys until a shared limiter exists. Revision 6 (2026-10-20): P-10 counts in
one Postgres table shared by every API instance, so hosted public intake may be turned on.
Revision 7 (2026-10-22, audit B1): P-12 consent rows carry the `disclosureText` the visitor
saw. A replay of a link or reject stored before that fills it from the consent row, or, once
that row is gone, from the page's append-only disclosure history for the stored version.
Revision 8 (2026-11-10, first-client week): P-1 allows three more anonymous writes, each authorized
by a signed per-booking link and defined in `booking-self-service.md` (`booking.self_cancel`,
`booking.self_reschedule`, `booking.confirmation_send`); `booking.public_request` itself is unchanged.
Revision 9 (2026-11-10, demo polish): P-14 shows times in the business's zone with a readable
zone name, adds the visitor's own time where it differs, and reads a ten-digit phone as +1 when
both the business and the visitor's device are in a US or Canada zone.
Revision 10 (2026-11-10, embed theming): P-16 lets the embedding page set the booker's colours,
radius and font through `--zs-booking-*` custom properties, validated inside the booking page, and
makes the frame grow and shrink with its content so it never scrolls inside itself.
Revision 11 (2026-11-11, embed theming fix round): P-16 accepts a colour only when the browser
reads it as an opaque colour and every text colour still reaches 4.5:1 (it derives readable ink
or drops the token), rejects font keywords, honours `header=0` only inside a frame and keeps the
business name visible, keeps the 480 px frame floor unless the host opts into a smaller one, and
has `embed.js` mount again when the host replaces the widget's children.
Code follows this file; a change to a numbered rule needs a new revision of this file first.

Scope: one narrow public write, `booking.public_request`, that lets a visitor on any
website book a published calendar of one business. The hosted booking page and the
embeddable widget (M3b) are the only clients. The owner reviews the result in the
dashboard. Messaging, payments, cancellation and outside calendars are out of scope.

## Evidence and decisions

- Plan: `2026-10-18-next-phases.md`, sections "M3a Public intake contract", "M3b" and
  decision 6 (bookings from any client website land in Calendar and Customers and block
  those slots).
- Booking authority: `booking.md` B-17..B-23 (recheck under the resource lock, exclusion
  constraint, one transaction with action and outbox).
- Identity and consent: `crm.md` C-1..C-11 (tenant-scoped identity, normalization,
  consent evidence, import preservation).
- Booker behaviour reference: cal.diy Booker (MIT), studied for behaviour only: steps
  (pick a date, pick a time, enter details, confirm, success), refetch of slots when the
  page regains focus and every few minutes, and a "time no longer available" state when
  the confirm call loses the race. No cal.diy code, text or asset is used.

## Numbered rules

**P-1. One public action.** The only anonymous write that needs no earlier proof is `booking.public_request`
(revision 8: the three link-authorized actions of `booking-self-service.md` also run anonymously, each only for the one
booking its signed token names). It runs
through the shared dispatcher (`createDispatcher`) like every other action: idempotency
key, approval binding, state plus action plus outbox in one transaction. No other
action is reachable without an owner principal.

**P-2. Tenant from the server, never from the body.** A booking page is addressed by a
public booking key: `zsb1_` followed by 64 base64url characters that encode the tenant
UUID (16 bytes), the page UUID (16 bytes) and a 16-byte HMAC-SHA-256 tag over
`zsb1:<tenantId>:<pageId>` with the server secret `PUBLIC_BOOKING_KEY_SECRET`. The server
verifies the tag in constant time before any database work, then opens a transaction
scoped to that tenant. A previous secret (`PUBLIC_BOOKING_KEY_PREVIOUS_SECRET`) still
verifies during rotation; only the current one signs. Request bodies carry no tenant ID;
a body field named `tenantId` (or any unknown field) is rejected by the strict schema.
Hostname-based resolution (a client domain mapped to a tenant) arrives with M4 site
publishing and will resolve to the same server-built principal.

**P-3. Server-built principal.** The public route has no auth principal. After P-2 the
server builds one: tenant = the key's tenant, actor = `derivedId(tenantId,
"public-intake")` (a fixed synthetic actor per tenant), approval = the server approving
exactly the command it built (the same direct approval the owner session uses). The
principal never comes from headers, cookies or the body, and the public route never
reads the owner `Authorization` header. It shares no code path with owner auth beyond
`createDispatcher`, so the owner auth model (M2a) can change independently.

**P-4. Published only.** A page is usable only while `booking_pages.published` is true.
A resource is bookable through a page only when a `booking_page_resources` row links it to
that page. An unpublished page, a forged or wrongly signed key, a page of another tenant,
and a resource not linked to the page all answer 404 `NotFound` with one fixed body, on
reads and on writes. The handler rechecks page and resource inside the write transaction.

**P-5. Request body.** `POST /public/v1/pages/:key/requests`, JSON, at most 8 KiB, header
`Idempotency-Key` holding a UUID the client mints once per attempt and reuses on retry.
Strict fields:

| Field | Rule |
|---|---|
| `resourceId` | UUID of a resource linked to the page |
| `startsAt` | UTC instant with milliseconds (booking.md B-3) |
| `name` | 1..200 characters, trimmed, not empty after trimming |
| `email` | required, normalized like C-2 |
| `phone` | optional E.164 (C-3), or null |
| `notes` | optional, at most 1000 characters, or null |
| `consent` | `{ email: boolean, sms: boolean }`: the visitor ticked the box or not |
| `disclosureVersion` | the consent disclosure version the page showed |
| `channel` | `booking_page` or `widget` |
| `website` | honeypot, must be the empty string |
| `botToken` | optional string up to 2048 characters for the bot check hook (P-10) |

The server stores the idempotency key as `public:<pageId>:<uuid>` so public keys never
collide with owner keys. Booking, intake item and candidate contact IDs derive from
tenant and stored key, so a retry rebuilds the identical command and replays.

**P-6. Same reply for new and known people.** Every accepted request answers 201 with
`{ requestId, status: "confirmed", resourceId, startsAt, endsAt }`. The reply, status
code and headers do not depend on whether the email or phone matched a contact, on how
many matched, or on whether they matched different contacts. A match never raises
`split_identity` or `identity_mismatch` here. A replay with the same key and body returns
the same reply. Errors depend only on the page, the slot, the body shape and the limits.

**P-7. Anonymous input never changes an existing contact.** Inside the transaction, with
the CRM identity locks (`crm:contact:email|phone|id:<tenant>:<value>`, sorted) held:
- No contact has the email or the phone: create a contact (display name, email, phone)
  and an intake item with status `new_contact` linked to it.
- Any contact has the email or the phone: change no contact row and no consent row.
  Create an intake item with status `possible_match` holding the submitted details and
  the matched contact IDs. The owner later links it to a contact (`intake.item.link`) or
  rejects it (`intake.item.reject`). The booking holds the intake item until then.
A uniqueness race during the create is retried inside a savepoint and becomes a
`possible_match`.

**P-8. Consent at intake.** Each ticked box becomes an `intake_item_consent` row:
channel, status `granted`, purpose `marketing_updates`, the page's disclosure version and
the exact disclosure text shown, source `booking_page:<pageId>` or `widget:<pageId>`, and the server's transaction time.
The client sends no status, time, source or purpose; an unticked box records nothing (no
evidence, not a denial). `disclosureVersion` must equal the page's current version, or
the request fails with 409 `disclosure_changed` and nothing is written.
Contact consent:
- `new_contact`: the contact is new, so it has no recorded evidence; the intake consent
  is copied to it with source `intake:<intakeItemId>`.
- `possible_match`: nothing is written to the contact. On `intake.item.link` the intake
  consent fills only channels that have no recorded evidence (C-10 import semantics). A
  recorded denial or grant is never replaced.
A disclosure version names one text for the life of the page: `booking_page_disclosures`
keeps every version a page has shown with its text, and `booking_pages_disclosure_versioned`
rejects any write that pairs a known version with other text (including a return to an
earlier version). New words need a new version, so a visitor holding the old one gets
`disclosure_changed`. The history is append-only: no runtime or service grant allows UPDATE
or DELETE on it, and `booking_page_disclosures_append_only` refuses UPDATE, DELETE and
TRUNCATE for every role, the table owner included.
Sending (M3d/M5) re-checks consent and adds confirmation for unverified addresses.

**P-9. One transaction.** Contact (when new), intake item, intake consent, booking (with
`source='website'` and the intake item ID), action row and one outbox event commit
together or not at all. The booking obeys B-19..B-21: the per-resource advisory lock
and the authoritative recheck come first, before anything that depends on who the visitor
is, so a taken slot answers 409 after the same work for a known and an unknown person.
Then the identity locks, the intake writes, and the insert under
`bookings_resource_occupied_excl`. This is the only path that takes both lock kinds, so the
order cannot deadlock. Two conflicting public requests: one commits, the
other gets 409 `slot_unavailable` or `overlap` and leaves no row behind.

**P-10. Abuse limits.** Before the request's own database work, body parsing and bot check:
- per client address: 10 requests per 10 minutes for writes, 300 per 10 minutes for reads;
- per tenant: 200 writes per hour across all its pages;
- 429 `RateLimited` with `Retry-After`; a refused request consumes nothing else. The numbers
  are server configuration with these defaults.
Each bucket is a fixed window that opens at its first charge. A request names every bucket it
touches, and one atomic step checks them all and charges all or none, so concurrent requests
never pass a limit and a refused request charges no bucket. The counters live in Postgres
(`public.rate_limit_buckets`, migration 20261020400000), shared by every API instance on the
database, so the limits hold however many Vercel function instances serve. The table holds
the SHA-256 of each bucket name, never a client address; the runtime role cannot read or write
it and charges only through the `SECURITY DEFINER` function `public.rate_limit_take`, owned by
the NOLOGIN role `zs_rate_limiter`. The function refuses (42501) every caller but the API's
runtime login (an unprivileged LOGIN whose one membership is `authenticated`) and any call
carrying JWT claims, so a Supabase-issued token cannot reach it through pg_graphql or PostgREST. The API passes its own clock (instances whose clocks
differ by a few seconds move a window edge by that much), and each charge sweeps at most 32
expired buckets, so the table stays bounded by the live windows. The charge runs in its
own runtime transaction under the request deadline. If the database cannot answer (no
connection in time, a lock or statement timeout, a lost connection), the request gets 503
with `Retry-After` and is not served. `PUBLIC_RATE_LIMIT_STORE=memory` counts in the process instead and
is refused unless `DATABASE_URL` is a loopback host. The email unsubscribe routes
(delivery.md D-9) charge their own buckets through the same limiter and store.
The client address is the socket address, unless the deployment names another source:
`PUBLIC_CLIENT_IP_HEADER`, a header the host overwrites (on Vercel `x-vercel-forwarded-for`
or `x-real-ip`, only when the API is reachable through the host alone); or
`PUBLIC_TRUSTED_PROXIES`, CIDRs whose `X-Forwarded-For` entries count, walked right to left
past trusted hops, and only when the socket peer is one of them. Addresses are
canonicalized (port, brackets and zone dropped; IPv4-mapped IPv6 as IPv4), and IPv6
addresses share a bucket per /64. `TRUST_PROXY=1` is refused at startup. Bodies over 8 KiB answer 413. A non-empty honeypot answers 400.
`BotCheck` is an injected hook `(input: { token, address }) => Promise<boolean>`; the
default accepts every request, and a `false` answers 400. The limiter is a port
(`RateLimiter` in `apps/api/src/public/limiter.ts`), so another shared store can replace
Postgres behind the same interface.

**P-11. Public reads.** `GET /public/v1/pages/:key` returns the business name, page title
and description, the linked resources (`id`, `name`, `timeZone`, `slotLengthMinutes`) and
the disclosure (`version`, `text`). `GET /public/v1/pages/:key/slots` takes the owner
slots query (`resourceId`, `from`, `to`, optional `zone`) and returns only free start and
end instants. No read returns bookings, contacts or intake items.

**P-12. Owner review.** Authenticated owner routes, through the dispatcher. Under the M2a
role model they are owner-only: review needs the `intake` permission and the page list
`publish`; staff get 403 `Forbidden`:
- `GET /v1/intake/items?status&limit&offset|cursor`: intake items, newest first (keyset `nextCursor` as on every list), with submitted
  details, matched contact IDs, linked contact, consent rows (with the disclosure version and
  text the visitor saw) and the booking.
- `POST /v1/intake/items/:id/link` `{ contactId }`: `possible_match` → `linked`; the
  contact must belong to the tenant; applies P-8 fill-only consent.
- `POST /v1/intake/items/:id/reject` `{}`: `possible_match` → `rejected`; the booking
  stays, without a contact.
A replay of a link or reject whose stored result predates `disclosureText` fills the text
from the consent row, else from `booking_page_disclosures` for the stored version.
A reviewed item answers 409 `already_reviewed`. `GET /v1/booking/bookings` adds `source`,
`intakeItemId` and `customer` (`contactId`, `name`, `status`) to each booking.
`GET /v1/booking/pages` lists the tenant's pages with their public key, hosted URL and
embed snippets.

**P-13. Storage.** Migration `*_public_intake.sql`:

| Table | Columns and constraints |
|---|---|
| `booking_pages` | `tenant_id`, `id`, `title`, `description` NULL, `published`, `disclosure_version`, `disclosure_text`, `created_at`; PK `(tenant_id,id)` |
| `booking_page_disclosures` | `tenant_id`, `page_id`, `version`, `text`; PK `(tenant_id,page_id,version)`; FK to pages with the tenant; written only by the page trigger; append-only (service role holds SELECT, INSERT; a trigger refuses UPDATE, DELETE and TRUNCATE) |
| `booking_page_resources` | `tenant_id`, `page_id`, `resource_id`, `position`; PK `(tenant_id,page_id,resource_id)`; FKs to pages and resources with the tenant |
| `intake_items` | `tenant_id`, `id`, `kind`, `status`, `channel`, `page_id`, `submitted_name`, `submitted_email`, `submitted_phone` NULL, `notes` NULL, `matched_contact_ids`, `contact_id` NULL, `reviewed_at` NULL, `reviewed_by` NULL, `created_at`; status/contact consistency checks |
| `intake_item_consent` | `tenant_id`, `intake_item_id`, `channel`, `status`, `purpose`, `disclosure_version`, `disclosure_text`, `source`, `recorded_at`; PK `(tenant_id,intake_item_id,channel)` |
| `bookings` (added) | `source` (`owner` default, or `website`), `intake_item_id` NULL; `source='website'` exactly when the intake item is set |

Every table has `tenant_id`, a tenant FK, forced RLS with the shared `tenant_scope`
policy, and tenant-qualified FKs. Runtime may read pages, insert intake items and
consent, and update only `status`, `contact_id`, `reviewed_at`, `reviewed_by` on intake
items. Pages are provisioned by service-role setup until a page-editing action ships.

**P-14. Hosted page and widget.** The API serves `GET /book/:key` (HTML) and its static
script and style, and `GET /embed.js`. Same origin as the public routes, so no CORS and
no cookies. The page CSP allows only its own scripts, styles and API calls, and allows
framing by any site (`frame-ancestors *`) because embedding is the point. The widget is a
script tag that turns each `[data-zs-booking]` element into an iframe of the hosted page
and resizes it from validated `postMessage` events; a plain iframe snippet works too.
The widget passes no personal data to the host page.
The booker groups and labels free times in the chosen resource's `timeZone` (the business's),
never the visitor's, and names the zone in words ("Pacific Time (Los Angeles)", not the IANA ID).
When the visitor's device is in another zone, each time also shows the visitor's own clock time,
marked "your time". In the hour that repeats when clocks go back, times carry the zone abbreviation
so the two are told apart. When both the business's zone and the visitor's device zone are US or
Canada (+1) zones, the phone hint is a US example and a ten-digit number (or eleven starting with 1)
is sent as `+1…`; any other entry must still be E.164 (C-3).
The booker freezes each attempt's Idempotency-Key and exact body on the first submit and
keeps them until a definitive reply (a 2xx with a body, or a 4xx). After a network error, a
5xx or a non-JSON reply it shows the details as sent and offers only "Try again" with the
same key and body, and slot refreshes wait, so a committed request replays instead of
looking taken. Public requests run under the same request deadline as `/v1`: a COMMIT
whose reply is lost answers 503 (`commit_unknown`) instead of holding a pool connection,
and a same-key request whose wait for the idempotency key lock times out answers 503
(`in_progress`), because the earlier request may still commit. The booker keeps the attempt
on both.

**P-15. Tests.** Real Postgres under `zs_runtime`: forged keys, forged and foreign
resource IDs, an unknown body `tenantId`, enumeration (identical replies for unknown,
known-by-email, known-by-phone and split matches), a victim's email and phone with ticked
consent (contact row and denial unchanged, `possible_match` created), concurrent
conflicting requests (one 201, one 409, no partial rows), rollback when a later step
fails, rate limits and body caps, and owner link/reject. Dashboard e2e: a booking made
through the widget appears in Calendar marked as from the website and in Customers.

**P-16. Theming and layout of the embed.** The booker serves every tenant, so it carries no
tenant's colours or fonts. The page that embeds it sets the look; with nothing set, the booker
looks exactly as before revision 10.
- The host sets these CSS custom properties on the `[data-zs-booking]` element or any ancestor:
  `--zs-booking-bg`, `-surface`, `-text`, `-muted`, `-accent`, `-accent-text`, `-border`, `-link`,
  `-error`, `-radius`, `-font` (meanings and defaults in "Theming the embed" below). `embed.js`
  reads their computed values and passes each one as a query parameter of the same name without
  the prefix (`bg`, `surface`, … `font`) on the frame URL; a plain iframe passes the same
  parameters itself. `embed.js` drops a value longer than 200 characters and nothing else; the
  booking page is the only gate.
- Mounting (single-page sites): `embed.js` mounts elements added after it loaded and elements
  that gain a `data-zs-booking` attribute later. When the host removes or replaces the frame
  (for example `element.replaceChildren()`), it mounts again in the same element with the key it
  first mounted there; a key written into an already mounted element is not followed. It forgets
  frames that left the page. Any valid key mounts, another tenant's included: the key is public
  by design and the host page chooses it, and a script that can write markup into the host page
  could add an iframe itself.
- Grammar: the booking page first checks each value against a fixed grammar: a colour is a hex
  colour (3, 4, 6 or 8 digits), `rgb()`/`rgba()`/`hsl()`/`hsla()` with numbers only, or one colour
  keyword (letters only); a radius is `0` or a number in `px` (at most 48), `rem` or `em` (at most
  3); a font is a comma list of family names, each letters, digits, spaces, `_` and `-` (an
  optional leading `-`), quoted or not. Anything else (`url(`, `var(`, `;`, braces, extra quotes,
  longer than 200 characters) is dropped and that token keeps its default; the other tokens still
  apply. An accepted value is set only as a custom property through the CSSOM
  (`style.setProperty`), never as markup, so the page CSP keeps `style-src 'self'`.
- Colours: a colour is kept only when the browser itself accepts it (`CSS.supports("color", …)`)
  and resolves it to an opaque colour (alpha 1, read back from a probe element). CSS-wide
  keywords (`inherit`, `initial`, `unset`, `revert`, `revert-layer`), `transparent`,
  `currentcolor` and `none` are dropped, and so are `#ffffff00`, `#0000` and any other alpha
  below 1.
- Readable text, for every accepted query: text, muted text, errors and links reach 4.5:1 on the
  page background, on the surface and on a selected button (8% accent over the surface), and the
  primary button's text reaches 4.5:1 on the accent. When one of bg and surface is set alone,
  the other follows it, so a dark page never keeps white buttons with dark text. When no ink
  can read on both, the surface follows the page; when none reads even then, both keep their
  defaults. For each text token the page keeps the host's colour if it reads; otherwise it uses
  the default, then a fixed readable fallback (black or white for text and button text, a light
  grey for muted text, a light red for errors, the accent or the text colour for links). The
  focus outline uses the link colour, so it reads too. Typed text in fields uses the text colour
  on the surface whenever the page themes bg or surface; otherwise fields keep the browser's own
  colours. A background darker than luminance 0.18 sets `color-scheme: dark`.
- Fonts: CSS-wide keywords (`inherit`, `initial`, `unset`, `revert`, `revert-layer`), `default`,
  `none` and the system-font keywords (`caption`, `icon`, `menu`, `message-box`, `small-caption`,
  `status-bar`) are not family names; a list that holds one unquoted is dropped. A quoted name
  (`"caption"`) is a family name and is kept. The list must also pass
  `CSS.supports("font-family", …)`.
- `data-zs-header="hidden"` on the element (`header=0` on the URL) hides the page title and
  description visually and keeps them for screen readers, for hosts whose page already shows
  that title. The business name stays visible, so the visitor still sees who they book with.
  It applies only when the page runs inside a frame (`embed=1` and a parent window); a page
  opened on its own always shows its header.
- Layout: the frame's height follows the booking page's body height on every change, up and
  down (P-14 `postMessage`), within 160 to 4000 px. The frame keeps a 480 px minimum height, as
  embeds had before revision 10, so a short step leaves space below the content rather than
  moving the host page. A host can opt into a smaller minimum with `data-zs-min-height="N"` on
  the element (N in px, clamped 160 to 480). Content taller than 4000 px (a very long day of
  times on a narrow phone) scrolls inside the frame; below that the frame never scrolls inside
  itself and the host page scrolls. The date list, time list and details form fit 390 px
  without sideways scrolling.
- Changes to the default look in revision 10, with no tokens set: every control and checkbox row
  is at least 44 by 44 px (checkboxes are 20 px), buttons and fields show a 2 px outline in the
  link colour on keyboard focus, and the font is set as `font-family` only (the size stays
  16 px).
- Focus: headings take focus only when the step changes and only after the visitor has acted
  (a pointer, a key or a click event, which also covers assistive tech and voice control), so
  the first paint never moves the host page's focus into the frame. A re-render of the same
  step (a slot refresh) leaves focus on the control that had it, or moves it to the heading
  when that control is gone.
- Tests: unit tests in `apps/api/test/booker-render.test.ts` cover the default render (no
  property, same frame URL), each property, hostile values, the rejected colours (`transparent`,
  `inherit`, `currentcolor`, `none`, `notacolour`, `rgb(1)`, `rgb(1,2,3,)`, `#ffffff00`, `#0000`)
  on every token, partial and all-white themes, rejected fonts, `header=0` only in a frame, and
  `embed.js` remounting, re-keying, the frame floor and message checks. Under the real CSP at
  390 and 1440 px, `apps/dashboard/e2e/booker-theme.spec.ts` walks every step and measures the
  computed colours: every visible text and typed field text is opaque and reaches 4.5:1 on the
  background behind it, and the focus ring reaches 3:1. It also covers focus on first paint, a
  slot refresh and a click-only step change, remounting after `replaceChildren()`, the 480 px
  floor and its opt-in, the theme applying, no inner scrolling, shrinking back, and 44 px
  targets.

## Theming the embed

Set the properties on the element that holds the widget (or any ancestor). Each one is optional.

| Property | Sets | Default |
|---|---|---|
| `--zs-booking-bg` | page background | `#ffffff` |
| `--zs-booking-surface` | day and time buttons, form fields | `#ffffff` |
| `--zs-booking-text` | body text and headings | `#1d232a` |
| `--zs-booking-muted` | secondary text and hints | `#5b6672` |
| `--zs-booking-accent` | primary button, selected and hover borders | `#24577a` |
| `--zs-booking-accent-text` | text on the primary button | `#ffffff` |
| `--zs-booking-border` | button, field and panel borders | `#d8dde3` |
| `--zs-booking-link` | text links and the focus outline | the accent |
| `--zs-booking-error` | error messages | `#a3271f` |
| `--zs-booking-radius` | corner radius | `8px` |
| `--zs-booking-font` | font family list | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |

A dark site:

```html
<style>
  .booking {
    --zs-booking-bg: #111113;
    --zs-booking-surface: #000000;
    --zs-booking-text: #ffffff;
    --zs-booking-muted: #8a8a93;
    --zs-booking-accent: #5b4cff;
    --zs-booking-accent-text: #ffffff;
    --zs-booking-border: #2a2a30;
    --zs-booking-link: #a99fff;
    --zs-booking-error: #ff6b5e;
    --zs-booking-radius: 12px;
    --zs-booking-font: Geist, -apple-system, "Segoe UI", sans-serif;
  }
</style>
<h2>Book a call</h2>
<div class="booking" data-zs-booking="KEY" data-zs-header="hidden"></div>
<script src="https://<api>/embed.js" async></script>
```

`data-zs-header="hidden"` is for a page that already shows the booking's title, as the
`<h2>` does here. Without one, leave it out.

Do not give the container a fixed height or `overflow`; the widget sets the frame's height. Add
`data-zs-min-height="320"` (160 to 480) to let the frame be shorter than 480 px on short steps.
A colour that would leave any text below 4.5:1 is replaced or dropped, as P-16 describes, so
check the result in a browser.
The frame can not use the host page's web fonts: name a font the visitor's device has, or end
the list with a system fallback as above. A plain iframe takes the same values as query
parameters:
`https://<api>/book/KEY?bg=%23111113&surface=%23000000&text=%23ffffff&muted=%238a8a93&accent=%235b4cff&link=%23a99fff`.
A plain iframe does not resize itself and so scrolls inside; prefer `embed.js`.
