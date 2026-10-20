# M3c: Inbox v1 and Home

Status: contract for M3c (2026-10-20), revision 1. Code follows this file; a change to a
numbered rule needs a new revision of this file first.

Scope: the owner's Inbox (one thread per customer, built from what people send through the
website forms and the bookings they make, plus the business's replies) and Home (leads,
bookings and revenue by source, this week against last week). Replies are drafted and
approved here and handed to the outbox; delivery, the wallet, consent re-checks at send time
and suppression are M3d. Inbound email, SMS and other channels are M5.

## Evidence and decisions

- Plan (approved 2026-10-18), "M3c": Inbox v1 (one thread per customer from form and booking
  messages; replies drafted, sent only after approval) and Home (leads, bookings, revenue by
  source, this week vs last; adds deal value, lead source, won date).
- Intake: `public-intake.md` P-5 (the visitor's notes), P-7 (anonymous input never changes an
  existing contact), P-12 (owner review). Roles: M2a `ROLE_PERMISSIONS`.
- CRM boundary: `crm.md` C-13..C-24 stay frozen. Deal value, lead source and won date are new
  nullable columns and a new action outside `crmHandlers`; the frozen deal record and the
  three CRM actions do not change shape.
- "Form messages" are what a visitor types on the hosted booking page or the widget (P-5
  `notes`). A standalone contact form would be a second anonymous write and needs a revision
  of P-1 first; it is not part of M3c.

## Inbox

**I-1. Threads are derived, one per customer.** A thread is read, not stored:
- a customer thread for each contact that has at least one website request
  (`intake_items.contact_id`) or one reply that is not discarded;
- a visitor thread for each website request with no contact (`possible_match` waiting for
  review, or `rejected`).
Linking a request (`intake.item.link`) moves it into that customer's thread at once, because
the request now names the contact. A visitor's message never lands in a matched contact's
thread before the owner links it (P-7): an anonymous visitor cannot write into someone
else's conversation by typing their email.

**I-2. Thread IDs.** `c_<contactId>` for a customer thread and `v_<intakeItemId>` for a
visitor thread, lowercase UUIDs. Anything else is a 400; an ID of another tenant, or a contact
with no thread, is a 404 with the fixed `NotFound` body.

**I-3. Entries.** A thread holds, oldest first:
- `request`: one per website request: the visitor's name, notes (null when they left none),
  channel (`booking_page` or `widget`), review status, and the booking it made (resource and
  times) when it has one. The notes are the form message; the booking is the booking message.
- `reply`: one per reply that is not discarded: text, status (`draft`, `approved`, `sent`,
  `failed`), who drafted it and when, who approved it and when, and when delivery settled.
Discarded drafts are not shown. A thread returns at most its 200 latest entries and says
whether older ones exist.

**I-4. Replies are fixed once drafted.** `inbox_replies` keeps the text, customer, channel,
author and draft time unchanged for every role, the table owner included
(`inbox_replies_guard`). Status only moves forward: `draft` to `approved` or `discarded`;
`approved` to `sent` or `failed`. Each step records its actor and time and never rewrites
an earlier step. So an approval of a reply ID is an approval of those exact words.

**I-5. Draft.** `inbox.reply.draft` `{ replyId, contactId, body }`, permission
`inbox.drafts` (owners and staff). `replyId` derives from the idempotency key. The body is
trimmed, 1..5000 characters. The contact must belong to the tenant (`TenantDenied`
otherwise). Visitor threads take no replies: the owner links the request first (I-1). Several
drafts may wait on one thread.

**I-6. Approve.** `inbox.reply.approve` `{ replyId }`, permission `inbox.approve` (owners
only). In one dispatcher transaction, with the reply row locked:
- the reply must be a `draft`, else 409 `Conflict` with `reason: "not_draft"` and its
  `status`;
- the contact must have a real email address (not a `.invalid` placeholder), else 409
  `reason: "no_email"`;
- the approval is recorded through the approval interface (M3b) when it is wired in;
  until then the action row is the record (actor, time, and the direct approval binding);
- the reply becomes `approved` with `approved_by` and `approved_at`, and the action writes
  one outbox event `inbox.reply.approved` with
  `{ replyId, contactId, channel: "email" }`.
Nothing in M3c sends. The delivery worker (M3d) reads the event, reads the text by reply ID
and the address from the contact at delivery time, re-checks consent and suppression, and
settles the reply once with `settleReplyDelivery` (`approved` to `sent` or `failed`).

**I-7. Discard.** `inbox.reply.discard` `{ replyId }`, permission `inbox.drafts`. Only a
`draft` can be discarded (409 `not_draft` otherwise). An approved reply cannot be withdrawn
here; M3d decides what stopping a queued send means.

**I-8. Routes.** Owner routes under `/v1/inbox`, through the edge session:
- `GET /v1/inbox/threads?limit&offset|cursor`: thread summaries, latest activity first, keyset
  `nextCursor` as on every list. Each summary: `id`, `kind`, `contactId`, `intakeItemId`,
  `name`, `email`, `preview` (the last notes or reply text, at most 140 characters),
  `lastActivityAt`, `needsReply`, `needsReview`, `drafts` (waiting drafts).
  `needsReply`: a customer thread whose latest request is newer than its latest approved
  reply. `needsReview`: a visitor thread still `possible_match`.
- `GET /v1/inbox/threads/:threadId`: the summary plus `entries` and `olderEntries`.
- `POST /v1/inbox/replies` `{ contactId, body }` (draft), `POST /v1/inbox/replies/:id/approve`
  `{}`, `POST /v1/inbox/replies/:id/discard` `{}`; each takes `Idempotency-Key`.
Reads need `inbox.drafts`. MCP exposes the same reads and writes as tools.

**I-9. Storage.** Migration `20261020200000_inbox_home.sql`:

| Table | Columns and constraints |
|---|---|
| `inbox_replies` | `tenant_id`, `id`, `contact_id`, `channel` (`email`), `body` (1..5000), `status`, `drafted_by`, `created_at`, `approved_by`, `approved_at`, `discarded_by`, `discarded_at`, `settled_at`; PK `(tenant_id,id)`; tenant FK and FK to the contact with the tenant; checks tie each status to its step columns; `inbox_replies_guard` (I-4) |

Forced RLS with the shared `tenant_scope` policy. Runtime may SELECT and INSERT, and UPDATE
only `status`, `approved_by`, `approved_at`, `discarded_by`, `discarded_at`. Only the service
role records `sent`/`failed` (`settled_at`), so a member session cannot claim a send.

## Home

**H-1. Deal fields.** `crm_deals` gains nullable `value_minor` (integer minor units, 0..2^53-1)
with `currency` (ISO 4217 code, both set or both null), `lead_source` (`website`, `referral`,
`phone`, `email`, `walk_in`, `social`, `ads`, `other`) and `won_at`. Lists show them as
`value: { amountMinor, currency } | null`, `leadSource` and `wonAt` on each deal
(`GET /v1/crm/deals`). `crm.deal.set-details` `{ dealId, expectedRevision, value, leadSource }`,
permission `customers`, sets value and lead source with the same compare-and-set as C-14:
a stale revision is 409 `stale_revision` with `currentRevision`; success bumps the revision
by one and sets `updatedAt`. It is registered outside `crmHandlers` (C-23 keeps three keys).

**H-2. Won date follows the stage.** `crm_stages.outcome` is `open`, `won` or `lost`
(default `open`; the migration marks stages named Won/Lost once). A deal entering a won stage
gets `won_at` equal to that write's `updated_at`, which is the dispatcher's injected clock;
moving between won stages keeps the first date; leaving the won outcome clears it
(`crm_deals_won_at` trigger, so create, move and service writes agree). Pipelines show each
stage's `outcome`.

**H-3. Weeks.** `GET /v1/home/results?zone&weekStart` takes an IANA zone (default `UTC`) and
`monday` (default) or `sunday`. The server reads its injected clock once. This week runs from
the local start of the current week to the start of the next (so far: nothing later exists
yet); last week runs from its own local start to the same local moment as now, seven days
earlier, so both cover the same span and a DST change does not shift it. A local midnight that
a DST jump skips starts at the jump. Results never read the database clock or the host's
date. The response states both ranges as UTC instants, `from` inclusive and `to` exclusive.

**H-4. Counts.** In each range:
- leads: contacts created, by source `website` (a website request created the contact,
  P-7 `new_contact`) or `manual` (everything else);
- bookings: bookings created (taken), by source `website` or `owner` (P-12 `source`);
- revenue: the value of deals won (`won_at`) in the range, per currency, by lead source,
  `unset` for deals without one. Deals without a value count in `wonDeals` but add nothing.
Each figure is `{ thisWeek, lastWeek }`.

**H-5. Who sees Home results.** Results need `reports` (owners only). Staff keep the rest of
Home (next appointments).

**H-6. Permissions.** M2a gains `inbox.approve` and `reports`, both owners only. Staff keep
`calendar`, `customers` and `inbox.drafts`.

**H-7. Storage.** Same migration as I-9: `crm_stages.outcome`; `crm_deals.value_minor`,
`currency`, `lead_source`, `won_at`; runtime UPDATE on `value_minor`, `currency`,
`lead_source`; indexes for contacts, bookings and won deals by time, and for requests by
contact. All new columns are nullable or defaulted, so the B-28 and C-24 seeds keep working.

**H-8. Tests.** Real Postgres under `zs_runtime`: two-tenant denial on `inbox_replies`
(catalog test plus direct cross-tenant reads and writes), the guard refusing text changes and
backward moves for the service role, draft/approve/discard happy paths and conflicts, staff
refused approve, the outbox event on approve and none on draft or discard, a visitor request
kept out of a matched contact's thread until linked, Home results with a fixed clock across a
DST week, won date on move in and out of a won stage, and set-details revision conflicts.
Dashboard e2e: a website booking shows in Calendar, Customers, Inbox and Home.
