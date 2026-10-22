# M3c: Inbox v1 and Home

Status: contract for M3c (2026-10-20), revision 4. Code follows this file; a change to a
numbered rule needs a new revision of this file first. Revision 2 sends replies through M3b's
approval records (`approvals.md`): I-5..I-8, H-6 and H-8 changed, and `inbox.approve` gave way
to M3b's `approve`. Revision 3 (hub review): I-4 keeps each step's record through later steps,
I-6 binds a resumed send to the caller's key and leaves another owner's approval to them, and
I-9 limits runtime inserts to drafts. Revision 4 (2026-10-22 audit, B5-06): H-1 checks
currencies against ISO 4217, not the shape alone, and says what happens to deals stored under the
earlier check.

Scope: the owner's Inbox (one thread per customer, built from what people send through the
website forms and the bookings they make, plus the business's replies) and Home (leads,
bookings and revenue by source, this week against last week). Replies are drafted and
approved here and handed to the outbox; delivery, the wallet, consent re-checks at send time
and suppression are M3d. Inbound email, SMS and other channels are M5.

## Evidence and decisions

- Approvals: `approvals.md` A-5..A-10 (M3b). A send is a stored, owner-approved action.
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

**I-4. Replies are fixed once drafted.** `inbox_replies` keeps the subject, text, customer, channel,
author and draft time unchanged for every role, the table owner included
(`inbox_replies_guard`). Status only moves forward: `draft` to `approved` or `discarded`;
`approved` to `sent` or `failed`. Each step records its actor and time, and no later step
(settling included) rewrites it. So an approval of a reply ID is an approval of those exact words.

**I-5. Draft.** `inbox.reply.draft` `{ replyId, contactId, subject, body }`, permission
`inbox.drafts` (owners and staff). `replyId` derives from the idempotency key. The body is
trimmed, 1..5000 characters; the subject is trimmed, one line, 1..200 characters, and the handler
fills "Message from <business name>" when the request leaves it out. The contact must belong to the tenant (`TenantDenied`
otherwise). Visitor threads take no replies: the owner links the request first (I-1). Several
drafts may wait on one thread. After the draft commits, the edge proposes its send
(`approval.request`, A-5) for `inbox.reply.send` with target the reply and payload
`{ replyId }`, requested by the drafter, summary `Send the reply "<subject>"`, default expiry.
Both steps take keys derived from the caller's key, so a retry replays both. Derived step
keys start `inbox:`, a prefix reserved for the server (`SERVER_IDEMPOTENCY_PREFIXES`), so no
caller can take one first. Since the reply is
fixed (I-4), approving its ID approves its exact words, which the inbox shows beside the
proposal (A-12).

**I-6. Approve and send.** `inbox.reply.send` `{ replyId }` is in `APPROVAL_POLICIES` with
`{ request: "inbox.drafts", required: true }`, so no member session runs it directly; it runs
only under a stored approval that an owner (`approve`) decided, as that owner (A-6, A-7).
`POST /v1/inbox/replies/:id/approve` (the edge `approveReply`, `approve` permission) does this
in steps:
- it reads the reply and its newest unexpired `pending` or `approved` proposal. A reply that is
  no longer a draft is 409 `not_draft` with its `status`, unless the same key already approved
  or resumed that proposal (a retry, which replays). A draft whose customer has no real email
  address (null or a `.invalid` placeholder) is 409 `no_email` before anything is decided;
- with no open proposal (withdrawn or expired) it proposes the send again under a key derived
  from the caller's key; a pending proposal is then approved (A-6) with the caller's key;
- an `approved` proposal not bound to the caller's key is one whose run failed under another
  call. If this owner decided it, `inbox.reply.resume` `{ replyId, approvalId }` (permission
  `approve`; changes nothing, requires the draft and this owner's approved, unrun proposal)
  binds the caller's key to it, so a retry of this call replays. If another owner decided it,
  409 `approved_by_other` with `approvedBy`: only the decider runs an approved action (A-7),
  so that owner finishes the send, or an owner revokes the approval (A-8) and approves again;
- it runs the approved send (A-7). If that run fails, the approval stays `approved`.
The send, in one dispatcher transaction with the reply row locked, requires a `draft` (409
`not_draft`) and a real email address (409 `no_email`), then makes the reply `approved` with
`approved_by` (the deciding owner) and `approved_at`, and writes one outbox event
`message.send_requested` in the delivery worker's shape:
`{ messageId: replyId, contactId, channel: "email", purpose: "transactional", subject, body }`,
carrying the exact approved words, since the payload is what gets sent and priced. The
action row carries the stored approval as its approval reference, so `approvalForAction`
(A-10) finds it.
Nothing in M3c sends. The delivery worker (M3d) reads the event, takes the address from the
contact at delivery time, re-checks the approval (A-10), consent and suppression, and settles the reply
once through its settle hook, `settleReplyDelivery(tx, tenantId, messageId, outcome, at)`
(`approved` to `sent` or `failed`; a no-op for any other message or a settled reply). Whatever
runs the worker passes it as `onSettled`, with `approvalsFromRecords(approvalForAction, clock)`
as the approval port.

**I-7. Discard.** `inbox.reply.discard` `{ replyId }`, permission `inbox.drafts`. Only a
`draft` can be discarded (409 `not_draft` otherwise). The edge then revokes the reply's open
proposal (A-8) where the caller may: owners any, staff only their own pending one, under a key
derived from the caller's key. A proposal left pending can never run, since the send requires
a draft. An approved reply cannot be withdrawn here; M3d decides what stopping a queued send
means (revoking its approval stops delivery, A-8, A-10).

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
Reads need `inbox.drafts`; approve needs `approve`. MCP exposes the same reads, draft and
discard as tools, but no tool approves: deciding stays with an owner in the dashboard or API
(approvals.md, MCP tools).

**I-9. Storage.** Migration `20261020200000_inbox_home.sql`:

| Table | Columns and constraints |
|---|---|
| `inbox_replies` | `tenant_id`, `id`, `contact_id`, `channel` (`email`), `subject` (1..200), `body` (1..5000), `status`, `drafted_by`, `created_at`, `approved_by`, `approved_at`, `discarded_by`, `discarded_at`, `settled_at`; PK `(tenant_id,id)`; tenant FK and FK to the contact with the tenant; checks tie each status to its step columns; `inbox_replies_guard` (I-4) |

Forced RLS with the shared `tenant_scope` policy. Runtime may SELECT, INSERT only the draft
columns (`tenant_id`, `id`, `contact_id`, `channel`, `subject`, `body`, `drafted_by`,
`created_at`; `status` defaults to `draft`), and UPDATE only `status`, `approved_by`,
`approved_at`, `discarded_by`, `discarded_at`. Only the service
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
A currency is one of the ISO 4217 codes in `CURRENCY_CODES` (`@zs/contracts`); the
`crm_deals_currency_code` check holds the same list. Writes accept only those codes. Deals stored
under the earlier three-capitals check keep their code: migration `20261022520000` adds the check
`NOT VALID`, so every new or updated row is checked, validates it when no stored row breaks it,
and otherwise leaves it `NOT VALID` with a NOTICE giving the count; it never rewrites or deletes a
deal. The read-only `supabase/preflight/20261022520000_deal_currency_iso.sql` (as `service_role`)
lists those deals; once their values are fixed, a later migration validates the check. Until
then reads stay tolerant: lists and Home show any stored three-capital code
(`storedCurrencyCodeSchema`), and a stage move of such a deal is 409 `invalid_currency` with its
`currency`, before anything changes, until `crm.deal.set-details` gives it a valid value.

**H-2. Won date follows the stage.** `crm_stages.outcome` is `open`, `won` or `lost`
(default `open`; the migration marks stages named Won/Lost once). A deal entering a won stage
gets `won_at` equal to that write's `updated_at`, which is the dispatcher's injected clock;
moving between won stages keeps the first date; leaving the won outcome clears it
(`crm_deals_won_at` trigger, so create, move and service writes agree, and a direct `won_at`
write is overridden). Changing a stage's `outcome` later does not re-date deals already in it;
no M3c route changes outcomes. Pipelines show each stage's `outcome`.

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

**H-6. Permissions.** M2a gains `reports` (this file) and `approve` (M3b), both owners only. Staff keep
`calendar`, `customers` and `inbox.drafts`.

**H-7. Storage.** Same migration as I-9: `crm_stages.outcome`; `crm_deals.value_minor`,
`currency`, `lead_source`, `won_at`; runtime UPDATE on `value_minor`, `currency`,
`lead_source`; indexes for contacts, bookings and won deals by time, and for requests by
contact. All new columns are nullable or defaulted, so the B-28 and C-24 seeds keep working.

**H-8. Tests.** Real Postgres under `zs_runtime`: two-tenant denial on `inbox_replies`
(catalog test plus direct cross-tenant reads and writes), the guard refusing text changes and
backward moves for the service role, draft/approve/discard happy paths and conflicts, staff
refused approve, the outbox event on approve and none on draft or discard, the send refused
directly and run only under the owner's stored approval, the proposal withdrawn on discard and
proposed again once withdrawn or expired, a visitor request
kept out of a matched contact's thread until linked, Home results with a fixed clock across a
DST week, won date on move in and out of a won stage, and set-details revision conflicts.
Dashboard e2e: a website booking shows in Calendar, Customers, Inbox and Home.
