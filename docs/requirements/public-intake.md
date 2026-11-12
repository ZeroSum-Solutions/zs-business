# M3a: public intake contract

Status: frozen contract for M3a/M3b (2026-10-18), revision 12 (2026-11-11; revision 5 text kept below). Revision 2
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
Revision 12 (2026-11-11, link-page sign-up): a second anonymous write, `linkpage.signup`, for pages
a creator publishes as a Hub site. P-1 allows it, authorized by a signed `zsl1_` page key bound to
one tenant and one site (P-17). P-14 keeps the booker same-origin; this one route is cross-origin,
with an Origin check and no credentials (P-18). P-19 fixes the body, the order of checks and the
reply. P-20 fixes the writes, P-21 the monthly cap (over the cap a sign-up is stored and its
delivery held, never dropped) and P-22 the tests. P-13 gains the storage.
Code follows this file; a change to a numbered rule needs a new revision of this file first.

Scope: one narrow public write, `booking.public_request`, that lets a visitor on any
website book a published calendar of one business. The hosted booking page and the
embeddable widget (M3b) are the only clients. The owner reviews the result in the
dashboard. Messaging, payments, cancellation and outside calendars are out of scope.
Revision 12 adds one more public write, `linkpage.signup` (P-17 to P-22): a visitor on a
creator's hosted link page joins that creator's email list. Delivery to an email provider
(Klaviyo) is out of scope here; this file ends at the stored sign-up and its outbox row.

## Evidence and decisions

- Plan: `2026-10-18-next-phases.md`, sections "M3a Public intake contract", "M3b" and
  decision 6 (bookings from any client website land in Calendar and Customers and block
  those slots).
- Booking authority: `booking.md` B-17..B-23 (recheck under the resource lock, exclusion
  constraint, one transaction with action and outbox).
- Identity and consent: `crm.md` C-1..C-11 (tenant-scoped identity, normalization,
  consent evidence, import preservation).
- Revision 12 plans (`2026-11-11-mishmash-hosting-architecture.md`, sections "Where sign-ups go
  (hosted pages only)" and "Per-creator free-tier cap", build-order step 4, decisions 6, 7, 8 and
  13; `2026-11-11-mishmash-creator-identity-spec.md`, D-5, D-8, A-5 and cases X-19 to X-24).
  Where the hosting plan says `Access-Control-Allow-Origin: *`, this revision does not: the
  identity spec (A-5) and the review of this revision require the site's own hosts (P-18).
- Booker behaviour reference: cal.diy Booker (MIT), studied for behaviour only: steps
  (pick a date, pick a time, enter details, confirm, success), refetch of slots when the
  page regains focus and every few minutes, and a "time no longer available" state when
  the confirm call loses the race. No cal.diy code, text or asset is used.

## Numbered rules

**P-1. Two public actions.** The only anonymous writes that need no earlier proof are `booking.public_request`
(revision 8: the three link-authorized actions of `booking-self-service.md` also run anonymously, each only for the one
booking its signed token names) and, since revision 12, `linkpage.signup` (P-17). The signed page key
`zsl1_` authorizes `linkpage.signup` for one site of one tenant, as `zsb1_` authorizes the booking request
for one page. The keys are not interchangeable: a booking session runs only the booking actions and a
sign-up session runs only `linkpage.signup`. Each runs
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
publishing and will resolve to the same server-built principal. The sign-up key `zsl1_` follows
this rule with its own prefix, secret and tag label (P-17).

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
default accepts every request, and a `false` answers 400. The sign-up route (P-19) uses the same
limiter, address source and 429 and 503 answers with its own bucket names and no `BotCheck`. The limiter is a port
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

Revision 12 adds, in a migration `*_linkpage_signups.sql`:

| Change | Columns and constraints |
|---|---|
| `intake_items` (altered) | `kind` also allows `linkpage_signup` (now `intake_items_kind`, `supabase/migrations/20261018200000_public_intake.sql:96`); `channel` also allows `linkpage` (`:99`); new nullable `site_id` with a tenant-qualified FK to `sites`; `page_id` (`:100`) and `submitted_name` (`:101`) become nullable, with a check that both are set when `kind='booking_request'` and that `site_id` is set when `kind='linkpage_signup'`; new nullable `cap_state` (`counted` or `held`), set when `kind='linkpage_signup'` and never otherwise. The runtime role inserts `cap_state` and cannot update it (it holds UPDATE only on `status`, `contact_id`, `reviewed_at`, `reviewed_by`). |
| `linkpage_disclosures` (new) | `tenant_id`, `site_id`, `version` (1..50 characters), `seq` (integer, 1 for the first version, +1 each time, unique per site), `text` (1..2000 characters), `created_at`; PK `(tenant_id,site_id,version)`; unique `(tenant_id,site_id,seq)`; FK to `sites` with the tenant; append-only like `booking_page_disclosures` (the service role holds SELECT and INSERT; the runtime role holds SELECT; a trigger refuses UPDATE, DELETE and TRUNCATE for every role). The current version of a site is its row with the highest `seq`. |
| `linkpage_signup_usage` (new) | `tenant_id`, `month` (date, the first day of a UTC calendar month), `counted` (integer, at least 0); PK `(tenant_id,month)`. The runtime role may INSERT and UPDATE `counted` only. |

Both new tables have `tenant_id`, a tenant FK, forced RLS with the shared `tenant_scope` policy and a
two-tenant denial test under `zs_runtime` (AGENTS.md, "Hard rules"). Who appends a disclosure version is
decided with the Sites contract (a publish appends it); this file reads the current version only.

**P-14. Hosted page and widget.** The API serves `GET /book/:key` (HTML) and its static
script and style, and `GET /embed.js`. Same origin as the public booking routes, so no CORS and
no cookies. Revision 12: this holds for the booker and `/public/v1/pages/*`. The one cross-origin
route is the link-page sign-up (P-18), and it also sets and reads no cookie. The page CSP allows only its own scripts, styles and API calls, and allows
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

**P-15. Tests.** The sign-up route has its own table (P-22). For the booking route, real Postgres under `zs_runtime`: forged keys, forged and foreign
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

**P-17. Link-page sign-up: route, key and site.** `POST /public/v1/linkpages/:key/signups` runs
the action `linkpage.signup` through the shared dispatcher (P-1), and `OPTIONS` on the same path
answers the browser preflight (P-18).
- **Key.** `zsl1_` followed by 64 base64url characters that encode the tenant UUID (16 bytes), the
  site UUID (16 bytes) and a 16-byte HMAC-SHA-256 tag over `zsl1:<tenantId>:<siteId>`, with the server
  secret `PUBLIC_LINKPAGE_KEY_SECRET`. `PUBLIC_LINKPAGE_KEY_PREVIOUS_SECRET` still verifies during
  rotation; only the current secret signs; a previous secret without a current one is refused at startup.
  Verification is constant time, checks every secret and needs no database, as for `zsb1_`
  (`packages/core/src/intake/keys.ts:6-8`, `:36-50`; `apps/api/src/config.ts:424-426`).
  With `PUBLIC_LINKPAGE_KEY_SECRET` unset the route is not mounted, as the booking routes are off
  without their secret (`apps/api/src/main.ts:14`).
- **Not interchangeable (domain separation).** The prefix, the secret and the tag label all differ
  from `zsb1_`. A `zsb1_` key never verifies on the sign-up route and a `zsl1_` key never verifies on
  `/public/v1/pages/*` (the booking key pattern accepts only `zsb1_`, `keys.ts:8`, `:37`). Both answer
  404 with the same body as any forged key.
- **Principal.** P-3 applies: the tenant is the key's tenant, the actor is the fixed per-tenant
  public actor, the server approves exactly the command it built, and nothing comes from headers,
  cookies or the body. The sign-up session authorizes `linkpage.signup` and nothing else, the way
  the booking session authorizes its two actions (`packages/core/src/edge/public-session.ts:34-36`).
- **Site.** The key names a site. The request is served only while the site (a) exists in the key's
  tenant, (b) has a live release (a `site_pointers` row, `supabase/migrations/20261020700000_site_releases.sql:52`)
  and (c) that release's `spec` has `kind` `linkpage` (`site_releases.spec`, same file `:20`). Any other
  case answers 404 with the one fixed body: forged key, key of another tenant's site, unknown site,
  site never published, site of another kind. The handler rechecks (a) to (c) inside the write
  transaction (as P-4). Today the contract knows only the spec kind `plain`
  (`packages/contracts/src/sites.ts:61`), so until the `linkpage` kind ships (hosting step 3) every
  request answers 404.
- **Preview never takes sign-ups.** Only a live release of a published site is served, and only
  from an attached host (P-18). A preview page, which the local daemon or the Hub preview route
  renders without storing a release, has no such host, so its sign-up call answers 403 (or 404 when
  the site has no live release). The Hub compiler gives a preview build no live sign-up endpoint; that
  belongs to the Sites contract.
- **Read-only plans.** `linkpage.signup` is not in `READ_ONLY_ALLOWED_ACTIONS`
  (`packages/core/src/billing/plan-gate.ts:38`), so a read-only business answers 409 `plan_read_only`
  from the dispatcher's plan check (`plan-gate.ts:79-80`, run at `actions/dispatch.ts:212`), as
  `booking.public_request` does today.

**P-18. Browser calls: CORS without credentials.** The sign-up route is the one public route called
from another origin: the page is served from the creator's host (for example `<slug>.<links domain>`)
and the API from its own host.
- **Allowed origins.** An `Origin` header must be exactly `https://<host>` (no path, no port, host
  compared in lower case) for a host attached to the key's site in `site_hosts` (`site_releases.sql:83`,
  read by the runtime role). Every other `Origin` value answers 403 `Forbidden`, writes nothing and
  carries no CORS header: another tenant's host, a host of the same tenant's other site, `null`,
  `http:` origins, a loopback address (this is the preview case) and a host with a port. A request
  with no `Origin` header (a server-side caller) is not refused by this rule. The Origin check
  is a guard against other websites using a key that sits in public page source. It is not
  authentication: a script that sets its own header passes it, and the limiter (P-10) and the cap
  (P-21) bound the harm. A custom domain is allowed once it is attached to the site.
- **Response headers.** When the `Origin` is allowed, every answer the route itself makes
  (201, 400, 409, 413, 422) carries `Access-Control-Allow-Origin` set to that exact origin and
  `Vary: Origin`. The route never sends `*`. It never sends `Access-Control-Allow-Credentials`,
  reads no cookie and sets none; the page script calls `fetch` with `credentials: "omit"`. A
  429 from the limiter or a 503 from the deadline comes before the Origin is known and carries
  no CORS header; the page treats it like a network error and retries with the same
  `Idempotency-Key` (P-19).
- **Preflight.** `OPTIONS /public/v1/linkpages/:key/signups` runs, in order: the key tag
  check (404, no CORS headers), the limiter with the address read bucket (P-19), then the host
  check above (403 for a refused `Origin`). An allowed `Origin` gets 204 with
  `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: POST`,
  `Access-Control-Allow-Headers: Content-Type, Idempotency-Key` and `Access-Control-Max-Age: 600`.
  No other request header is allowed, and `Authorization` is not.
- **Global CORS middleware.** The API's global `cors()` (`apps/api/src/app.ts:213-220`) answers
  every path from a fixed allowlist of dashboard origins and allows `Authorization`. It must not run
  for `/public/v1/linkpages/*`: the route answers its own preflight and headers, and the global
  allowlist adds nothing there.
- **Responses are not cached.** `Cache-Control: no-store`, as on every public route
  (`apps/api/src/public/routes.ts:115`).

**P-19. Sign-up request, order of checks and reply.** JSON, at most 4 KiB (413 over), header
`Idempotency-Key`. The body is a strict object. The server reads nothing else.

| Field | Rule |
|---|---|
| `email` | required, normalized like C-2 |
| `consent` | `{ email: boolean }`, strict: any other key, `sms` included, answers 400 |
| `disclosureVersion` | 1..50 characters: the version the page showed |
| `website` | honeypot, must be the empty string |

- **Rejected fields.** `tenantId` and every unknown field answer 400, as in P-2. There is no
  `botToken` and no `BotCheck` call on this route.
- **Decision on `page` (revision 12): it is not a field.** Reasons: the key already names the one
  site, so a `page` value adds nothing the server can trust; the body is strict, so every extra
  field is a way to store visitor-chosen text; and a link page has one address, so the value would
  always be the same path. The same holds for `kind`. The page script in the plan draft
  (`mish` branch `feat/link-pages`, `packages/linkpage/src/render.ts:41-44`, read-only) sends
  `kind` and `page`; it must send only the four fields above, `consent.email` and the
  `Idempotency-Key` header. Until it does, its sign-ups answer 400.
- **`Idempotency-Key`.** A UUID (lower-cased), required: missing or malformed answers 400. The
  page script mints one per attempt and reuses it on retry. The stored key is
  `linkpage:<siteId>:<uuid>`, so it never collides with an owner key or a `public:<pageId>:…` booking
  key (P-5). The intake item and contact IDs derive from the tenant and the stored key
  (`derivedId`), so a retry rebuilds the identical command. The same key and body again returns
  the same reply, writes nothing and takes no cap slot. The same key with another body answers
  409 `idempotency_key_reused` (`actions/dispatch.ts:171-176`). A same-key request whose wait for the
  key lock times out answers 503 `in_progress` (`dispatch.ts:157-159`, P-14).
- **Order of checks.** Each step runs only when the earlier ones passed.
  1. Key tag, constant time, before any database work. Fails: 404. A forged key charges no
     limiter bucket, because the check costs one HMAC. This differs on purpose from the booking
     routes, which charge the address bucket before they answer 404 for a forged key
     (`routes.ts:63-78`).
  2. P-10 limiter, before the body is read. Buckets (own names, so sign-ups and bookings do not
     use each other's allowance; same numbers as P-10): per address, 10 writes per 10 minutes
     (`linkpage-address-write:<address>`, and `linkpage-address-read:<address>` for the
     preflight, 300 per 10 minutes); per tenant, 200 writes per hour
     (`linkpage-tenant-write:<tenantId>`). Refused: 429 `RateLimited` with `Retry-After`. Database
     down: 503 with `Retry-After`.
  3. Read the body: over 4 KiB is 413; not JSON, or not `application/json`, is 400
     (`apps/api/src/routes/request.ts:5-13`).
  4. Honeypot: a non-empty `website` answers 400 with the fixed `ValidationFailed` body and
     no issue list, before the schema runs.
  5. Strict schema and the `Idempotency-Key` header: 400.
  6. `consent.email` is `false`: 422 `consent_required`, nothing stored. (Decision: on this form the
     only purpose is the list, and a stored sign-up with no consent has no use. The booking form
     differs: an unticked box still books, P-8.) It is a `Refused(422)`, which keeps the code
     `ValidationFailed` and names the reason (`packages/core/src/edge/errors.ts:195`).
  7. Open the tenant scope. Read the site (P-17: missing, no live release or wrong kind is 404).
     Then the `Origin` rule of P-18: a refused `Origin` is 403, and nothing is written. The 404
     comes first so a refused origin says nothing about whether a site exists.
  8. The action, in one tenant transaction (P-20): replay lookup, plan check, site recheck,
     disclosure check (`disclosureVersion` is not the site's current version: 409
     `disclosure_changed`, nothing written), then the writes.
- **Reply.** Every accepted request answers `201 { "ok": true }`: a new person, a known person
  (P-6, P-7), a replay and a sign-up held over the cap (P-21) look the same. The reply, status
  and headers never show whether the email matched a contact or whether the cap held the
  delivery. Errors depend only on the key, the site, the origin, the body shape and the limits.
  Errors use the shared body `{ error: { code, message, details } }`
  (`packages/core/src/edge/errors.ts:66-68`).

**P-20. What a sign-up writes.** One transaction (X-21), with the tenant's rules from P-7 to P-9:
- **Contact and intake item (P-7).** With the CRM identity locks held, as in P-7 (email only, no
  phone): no contact has the email, so create a contact (no display name: `display_name` may be
  null, `supabase/migrations/20261017170100_crm.sql:17`) and an intake item `linkpage_signup`,
  status `new_contact`, `site_id` set, `page_id` and `submitted_name` null, channel `linkpage`. A
  contact has the email, so change no contact row and no consent row, and create an intake
  item with status `possible_match` holding the matched contact IDs. The owner links or
  rejects it as in P-12. A uniqueness race is retried in a savepoint and becomes a
  `possible_match`.
- **Consent (P-8).** One `intake_item_consent` row: channel `email`, status `granted`, purpose
  `marketing_updates`, the site's current disclosure version, the exact text of that version from
  `linkpage_disclosures`, source `linkpage:<siteId>`, the server's transaction time. For a
  `new_contact` the consent is copied to the contact with source `intake:<intakeItemId>`. For a
  `possible_match` nothing is written to the contact, and `intake.item.link` fills only channels
  with no recorded evidence. The client sends no status, time, source or purpose. No address, user
  agent or other device data is stored.
- **Cap slot (P-21).** Taken in this transaction; the result sets `cap_state` on the intake item.
- **Outbox.** One row, event type `lead.created`, written with the action row by the dispatcher
  (`HandlerResult.event`, `packages/core/src/actions/dispatch.ts:45`, `:232`). Its payload holds IDs
  and flags only: `{ intakeItemId, siteId, contactId (null for a possible_match), match, kind:
  "signup", source: "linkpage", held }`. A consumer reads the email and the consent from the
  stored rows, never from the payload. Neither `linkpage.signup` nor this event is in
  `SOURCE_EVENT_TYPES` (`packages/core/src/automation/events.ts:19`), so no Activepieces
  webhook sees a link-page sign-up (the worker scans only those types,
  `packages/core/src/automation/worker.ts:139`). A webhook would bypass the cap.
- **Stored action result.** `{ intakeItemId, siteId, outcome, contactId, held }`. It never leaves
  the server (P-6).
- **Other readers of `intake_items`.** A sign-up is not a booking request, so each reader that
  assumes one needs a rule in the code change, with a test: the follow-up agent's candidate
  query takes every `new_contact` or `linked` item with a contact
  (`packages/core/src/agents/candidates.ts:29-33`, `:51`, `:98`), so it adds
  `kind='booking_request'`; the Inbox read builds request threads from every item
  (`packages/core/src/reads/inbox.ts:94`, `:113`, `:137`, `:214`), so a sign-up is no request
  thread; the owner review list reads `page_id` and `submitted_name`
  (`packages/core/src/reads/intake.ts:44-50`), so a `possible_match` sign-up stays in it with its
  site and no booking. Readers that join through `bookings.intake_item_id` never reach a sign-up.

**P-21. Monthly sign-up cap.** The free tier limits sign-ups a creator can deliver, not page views.
- **Counter.** `linkpage_signup_usage` (P-13), one row per tenant and UTC calendar month, month
  taken from the injected clock. In the sign-up transaction one statement takes a slot:
  `INSERT … (tenant_id, month, 1) ON CONFLICT (tenant_id, month) DO UPDATE SET counted =
  counted + 1 WHERE counted < $limit RETURNING counted`. A returned row means counted
  (`cap_state='counted'`); no row means over the cap (`cap_state='held'`). For a tenant with no
  limit the `WHERE` is left out and the counter still counts. The row lock serializes concurrent
  sign-ups, so exactly `limit` are counted in a month. A rolled-back transaction gives its slot
  back; a replay (P-19) takes none.
- **Limit.** An injected value (the core takes config as an argument; AGENTS.md, "Hard rules"),
  server setting `LINKPAGE_FREE_SIGNUP_LIMIT`, default 250. It applies to every tenant until the
  plans contract (the "Creator Free" rule, hosting step 5) says which plans have no limit. That
  contract may also say which sign-ups do not count (for example a duplicate address); until it
  does, every accepted sign-up counts, whether the person is new or known (P-6).
- **Over the cap.** The sign-up is stored in full with its consent and shows in the owner's
  Customers and intake review like any other. Its `cap_state` is `held` and the outbox event has
  `held: true`; a consumer must not deliver a held sign-up. The visitor gets the same `201 { "ok": true }`.
  Releasing held sign-ups (a higher limit, a new month) is a service-role job, specified with the
  delivery contract; it takes a slot in the month it runs.
- **Abuse limit stays separate.** The cap never answers 429. The only 429 is the P-10 limiter
  (P-19 step 2).

**P-22. Tests (sign-up).** Real Postgres under `zs_runtime`, two tenants A and B, each with a link-page
site, an attached host and a live release whose `spec.kind` is `linkpage` (inserted by the service role
until the compiler ships). Files: `apps/api/test/linkpage-signup.test.ts` and
`packages/core/test/linkpage-keys.test.ts`. "Unchanged" means row counts of contacts, consent rows,
intake items, outbox rows and the usage counter. X-numbers are the cases of the creator-identity plan.

| ID | Plan case | Case | Expected |
|---|---|---|---|
| S-1 | X-19 | Key with A's tenant and site UUIDs and a tag made for B; a key with a flipped character; a wrong length; a key signed with an unknown secret | 404, same body for all; a counting database double sees zero statements and no limiter charge; nothing written |
| S-2 | X-20 | A's valid key, body with `tenantId: B`; again with `page`, `kind`, `consent.sms`, an extra key | 400 each; B and A unchanged |
| S-3 | X-21 | A's valid key and host origin, good body | 201 `{ok:true}`; A has one contact, one consent row (version and text of A's site), one intake item and one `lead.created` outbox row; B's contacts, intake items, outbox rows and counter unchanged. A fault injected after the contact insert leaves no row and no counter change. |
| S-4 | X-22 | A `zsb1_` key on the sign-up route; A's `zsl1_` key on `/public/v1/pages/:key` and on the booking route | 404 each, same body; nothing written |
| S-5 | X-23 | A's valid key with `Origin: https://<B host>`; also `null`, `http://<A host>`, `https://<A host>:8443`, `http://127.0.0.1:3000`, `https://<host of another site of A>` | 403 each, no CORS headers, nothing written. A's own host: 201 with `Access-Control-Allow-Origin` equal to it, `Vary: Origin` and no `Allow-Credentials`. No `Origin`: 201. |
| S-6 | X-24 | Limit set to 2 for the test. A sends 3 sign-ups, then B sends 1 | A's third: 201 same body, stored in full with consent, `cap_state='held'`, outbox `held:true`, counter stays 2, visible to the owner. B's: `counted`, B's counter 1. A month later (injected clock) A's next sign-up is counted. |
| S-7 | P-19 step 2 | 11 requests from one address within 10 minutes; separately, 201 sign-ups past the limit of S-6 | The 11th: 429 with `Retry-After`; a booking from the same address still works (own buckets). Past the cap: never 429. |
| S-8 | P-19 | Replay with the same key and body; same key with another body; missing, malformed key; two concurrent requests with one key; 20 concurrent requests with the counter at limit minus 1 | Same 201, one set of rows, one slot; 409 `idempotency_key_reused`; 400; one set of rows; exactly one `counted` |
| S-9 | P-19 steps 4-6, 8 | Non-empty `website` with an otherwise invalid body; `consent.email: false`; an old `disclosureVersion` after a new version is appended | 400 with the fixed body and no issue list; 422 `consent_required`; 409 `disclosure_changed`; nothing written each time |
| S-10 | P-6, P-7 | A new email, a known email with a consenting contact, a known email whose contact denied email | Same status, headers and body. The known ones create a `possible_match` and change no contact and no consent row. |
| S-11 | P-17 | Site unpublished (no pointer); site whose live release is `plain`; a site UUID of B with A's tenant in a validly signed key | 404, same body as S-1 |
| S-12 | P-18 | `OPTIONS` from A's host; from B's host; with a forged key; request header list including `Authorization` | 204 with `Allow-Origin`, `Allow-Methods: POST`, `Allow-Headers: Content-Type, Idempotency-Key`, `Max-Age: 600`; 403 without CORS headers; 404; `Authorization` not allowed. The global dashboard allowlist does not answer this path. |
| S-13 | P-20 | A sign-up with a contact for the same tenant | Never a follow-up candidate; never an Inbox request thread; a `possible_match` shows in the owner review list; no `lead.created` Activepieces delivery is queued |
| S-14 | P-17 | Tenant with a read-only plan | 409 `plan_read_only`; nothing written |
| S-15 | P-17 | Key signed with the previous secret after rotation; with the current secret | 201 each; only the current secret signs new keys |
| S-16 | P-13 | `linkpage_disclosures` and `linkpage_signup_usage`: A's runtime session reads and updates B's rows; UPDATE, DELETE and TRUNCATE on `linkpage_disclosures` | 0 rows; refused for every role |

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
