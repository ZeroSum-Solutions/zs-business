# Inbound email: customer replies reach the Inbox

Status: draft contract, not built (2026-11-10), revision 1. Code follows this file once its first
slice lands; a change to a numbered rule needs a new revision of this file first. Four choices
wait on the repo owner ("Open decisions"); the rules below use the recommended answer for each,
and the first slice can be built on them without code changes if the owner agrees.

Scope (Inbox area): email that a customer sends to a business reaches that business's Inbox,
in the customer's thread, as text an owner can read and answer. That covers a reply to an email
the hub sent (an Inbox reply, a follow-up draft, a booking notice) and a new email to the
business's hub address. It decides how mail gets in, how each message is bound to exactly one
tenant, which From and Reply-To the hub sends with, how a message finds its conversation and
contact, what is done to keep the body safe, and how an inbound message changes the follow-up
agent. It also fixes the scope change that would let the outreach sequencer keep reply text,
which ships only after the owner approves it.

Out of scope: reading a tenant's own Gmail or Microsoft mailbox through OAuth (compared and
deferred in decision 1); sending from the owner's own mailbox; HTML display of any message;
opening, previewing or scanning attachments (the first slices keep names and sizes only,
IE-14); SMS and other inbound channels; push or email notifications to the owner about new mail
(a separate contract; the Inbox `needsReply` flag and Home show it); an agent that drafts
answers to inbound email; automatic CRM changes (contacts, consent, deals) from inbound mail;
per-tenant inbound domains (a vanity `reply.<tenant domain>`); importing old mail.

## Evidence and decisions

What exists today (read 2026-11-10):
- The Inbox has no conversation or message tables. Threads are derived on read from
  `intake_items` (website requests) and `inbox_replies` (`inbox-home.md` I-1,
  `packages/core/src/reads/inbox.ts`). An inbound email is therefore a new entry source, and
  `inbox-home.md` needs a revision for it (IE-24), as `twilio.md` already notes for callbacks.
- Outbound email goes through the delivery outbox (`delivery.md` D-1..D-10) to Resend
  (`resend.md`). `from` and `reply_to` come from one global config, `RESEND_FROM` and the
  optional `RESEND_REPLY_TO` (`packages/core/src/delivery/resend.ts`, R-4, R-6). A customer who
  presses Reply writes to that shared address or to the global Reply-To, and the hub never sees
  it. The adapter refuses `Reply-To` and `Message-ID` as request headers (`RESERVED_HEADERS`).
- `POST /webhooks/resend` (`apps/api/src/public/resend-webhook.ts`) verifies Standard Webhooks
  signatures and acts only on bounces, complaints and suppressions; its own comment says
  `email.received` is not subscribed. R-8 binds an event to a tenant only through tags this
  system set, and checks them under that tenant's scope.
- The outreach sequencer reads Gmail with `gmail.metadata` only: it sees that a reply arrived and
  stops the prospect, but never reads a body (`outreach-sequencer.md` OS-19, "Why
  `gmail.metadata`"). `outreach_inbound_events` stores no text. Its Known limits say replies are
  read in Gmail and nothing reaches the hub Inbox.
- `activepieces.md` Known limits: `message.received` comes only from website booking notes;
  there is no inbound email.
- The API Vercel project holds no worker secret (README "Hosting"): the Resend key and service
  database logins live in the workers project. Anything that calls Resend's API to read a
  message therefore runs as a worker, not in the webhook.
- Per-tenant sending domains are an open question (`docs/integrations.md` open question 4) and
  `marketing-email.md` M-2, M-3 (not built) put them in `tenant_email_domains` for marketing only.
- Anonymous input never changes a contact and never lands in a known contact's thread before an
  owner links it (`public-intake.md` P-7, `inbox-home.md` I-1). Email From is anonymous input:
  anyone can type any address there.
- Read-only tenants still run inbound records (`plans.md` PL-8); server key prefixes are
  reserved (`approvals.md` A-14, `delivery.md` D-9); stored text is data, not instructions
  (`hub-access.md` H-10, `docs/integrations.md` "Untrusted input").

Provider behaviour (Resend's public docs, in our own words; recheck when the first slice
starts; until the first real message only the fake provider proves it):
- A domain or subdomain whose MX record points at Resend receives mail for every local part at
  that domain. Each received message raises a signed `email.received` webhook (the same Standard
  Webhooks scheme as R-7) with the message's ID, sender, recipients, subject and attachment
  metadata. The body is not in the webhook.
- The text and HTML parts, the headers and the attachments are read through the API by the
  message ID. This is assumed to need an API key with more than sending access.
- Not known yet, and checked in the first slice: whether the API answer carries the receiving
  server's `Authentication-Results` or a spam verdict; whether a received message can be
  deleted at Resend and how long Resend keeps it; whether received mail counts toward the
  plan's monthly quota; whether a custom `Message-ID` on a sent email survives to the recipient.
  Every rule below works when the answers are "no" (IE-13, IE-19, IE-20).

### Decision 1: how mail gets in

| | A. Hub reply address, provider inbound webhook | B. OAuth read of the tenant's Gmail or Microsoft mailbox | C. Forwarding address |
|---|---|---|---|
| How | Every hub email carries `Reply-To: <tenant address>@<inbound domain>`. The inbound domain's MX points at Resend, which posts each message to the hub. | The owner signs in; a worker polls the mailbox and copies customer mail into the hub. | The owner sets a forwarding rule in their own mailbox to the tenant's hub address. Same pipeline as A. |
| Cost | No new vendor. One MX record on a hub subdomain. Received mail may count toward the Resend plan (unverified). | Google's restricted read scopes for a public app need Google's verification and a yearly paid security assessment before any outside tenant can connect. Microsoft needs publisher verification. Composio's managed apps avoid that but count as a managed connection (PL-1) and pass mailbox content through a third party. | As A. |
| Setup for a non-technical owner | Nothing. The address exists from the start and replies just arrive. | One sign-in, but the consent screen asks to read all their mail, and many Microsoft 365 organisations require an admin to approve it. | Hard. Mail settings, a confirmation code Gmail sends to the forwarding address, and Microsoft 365 blocks automatic forwarding outside the organisation by default. |
| Deliverability | Inbound is unaffected (we run the receiving address). Outbound keeps the shared sender (decision 3). | Best: mail stays in the owner's own mailbox. | Forwarding breaks SPF; DKIM usually survives; forwarded mail is more often flagged, so the authentication signal (IE-13) is weaker. |
| Privacy | The hub sees only mail sent to the business's hub address. | The hub can read every message in the mailbox, personal mail included. A leaked token exposes all of it. | Usually everything the owner gets, unless they write filters. |
| Routing and threading | Address chosen by the hub (IE-3); a per-message reply reference (IE-6). | Strong (provider thread IDs). | Address chosen by the hub; no reply reference on mail the hub did not send. |

**Recommended: A.** It fixes the lost replies with no owner setup, no new vendor and the least
data. C is a later slice on A's pipeline (a second address kind) for owners who want every
customer email in the hub. B is deferred: it needs the owner's approval of a new Gmail or
Microsoft connection (`docs/integrations.md` rule) and the verification cost, and only pays off
when tenants want their old mailbox history.

### Decision 2: tenant routing

| Option | Verdict |
|---|---|
| a. One random handle per tenant at the hub's inbound domain, looked up server-side | **Recommended.** The hub creates the handle; the sender can only choose which address to write to. |
| b. A signed handle that encodes the tenant (like the booking key, P-2) | Rejected: a tenant UUID and tag plus a reply reference do not fit the 64-character local part limit. |
| c. A subdomain per tenant (`<slug>.reply.…`) | Rejected: names the tenant in the address, guessable, wildcard DNS for no gain. |
| d. One shared address, tenant found by headers or the sender | Rejected: trusts data the sender controls. |

### Decision 3: sender ownership

| Field | Options | Recommended now |
|---|---|---|
| From address | the shared hub sender; the tenant's verified domain (M-2); the owner's own address | The shared hub sender (`RESEND_FROM`, `mail.zerosumsolutions.com` today), unchanged. Sending as the owner's own address from our servers fails DMARC; their verified domain comes with M-2. |
| From name | business name; "business name via ZS Hub"; the hub's name | The business name from `business_profiles` (IE-5). Open decision 2. |
| Reply-To | the tenant's hub address with a reply reference; the owner's own address; none | The tenant's hub address with a per-delivery reply reference (IE-6). The owner's own address is how replies get lost from the hub today; none sends replies to the shared sender. |

## Numbered rules

### Addresses and routing

**IE-1. The inbound domain.** One hub subdomain, `INBOUND_EMAIL_DOMAIN` (recommended
`reply.zerosumsolutions.com`, open decision 1), with its MX at the inbound provider. It is
separate from the sending domain, so inbound DNS never touches the sending reputation or the
DKIM, SPF and DMARC records under `mail`. The repo owner publishes the records; no agent changes
DNS.

**IE-2. Tenant addresses.** `inbound_email_addresses` holds a tenant's addresses: `handle` (16
characters of lower-case base32, 80 random bits from the database's `gen_random_bytes`), `kind`
(`reply`; `forwarding` joins with slice 5), `status` (`active`, `disabled`). A handle is unique
across all tenants. A tenant has at most one active `reply` address (partial unique index). The
migration creates one for every tenant; a trigger on tenant insert creates one for each new
tenant. Only the service role writes the table; a later owner action rotates the address
(disable the old one, create a new one). The address is `<handle>@<INBOUND_EMAIL_DOMAIN>`. The
owner may publish it as the business's "email us" address (open decision 4 covers the spam
exposure).

**IE-3. Routing a message to one tenant.** The tenant comes only from a recipient address the
hub issued:
- The webhook reads the message's recipients (at most 50) and keeps those whose domain equals
  `INBOUND_EMAIL_DOMAIN`, compared in lower case. Recipients at other domains are ignored.
- A kept local part, lower-cased, must match `^[a-z2-7]{16}(\+[a-z2-7]{16})?$`: the handle, and
  an optional reply reference after `+` (IE-6). Anything else is not routed.
- The handle is looked up with `inbound_email_route(handle)`, a `SECURITY DEFINER` function with
  a pinned `search_path` that returns only `tenant_id` and `address_id` of an `active` address,
  executable by the runtime role. Every later read and write runs in that tenant's scope (runtime
  role, RLS), as R-8 does after reading its tags.
- Nothing else picks a tenant: not From, Subject, `In-Reply-To`, `References`, any `X-` header,
  the body or the reply reference. A reference, a header or an address that names another
  tenant's data finds nothing, because every lookup after routing is in the routed tenant's scope.
- A message addressed to several hub addresses is received once per routed tenant, each under
  its own tenant. Two recipients that route to the same tenant give one record; the one with a
  reply reference wins.

**IE-4. Mail that matches no tenant.** A message with no routed recipient (unknown handle,
disabled address, malformed local part) is acknowledged with 200 and leaves nothing: no row, no
body fetch, no reply, no bounce. The log gets one line with the provider message ID and the
reason (`unrouted`), never an address, subject or body. A count per hour feeds the existing
cron alerts. The hub never sends a bounce or notice for unrouted mail, so a forged sender cannot
use it to send backscatter.

### Sender

**IE-5. From.** Transactional email keeps the shared sender address from `RESEND_FROM`. The
display name is the tenant's business name (`business_profiles`), one line, at most 64
characters, with `"`, `<`, `>`, `@`, `\`, control characters and bidirectional overrides removed;
an empty result falls back to the configured name. The worker builds the full From at a
delivery's first attempt and stores it with the request, so every later attempt replays the
same bytes (D-8, R-2). Marketing email keeps M-3 (the tenant's verified domain).

**IE-6. Reply-To with a reply reference.** Every email the delivery worker sends for a tenant
with an active reply address carries `Reply-To: <handle>+<ref>@<INBOUND_EMAIL_DOMAIN>`, where
`ref` is the first 10 bytes of HMAC-SHA-256 over `zsr1:<tenantId>:<deliveryId>` with
`INBOUND_REF_SECRET`, in lower-case base32 (16 characters). At the first attempt, in the
transaction that stores the request, the worker records the reference in `email_thread_refs`
(direction `out`, the delivery, the contact, the pinned recipient). The reply address is part of
the stored request and is replayed unchanged. The global `RESEND_REPLY_TO` is used only for a
tenant without an active address. The reference proves which delivery a reply answers; it never
chooses the tenant (IE-3). This needs revisions of R-4 (a per-request Reply-To) and D-8 (the
stored request holds it).

**IE-7. Sending domains.** When a tenant gets a verified domain (M-2), its From may move to that
domain in a later revision. Reply-To stays the hub address, so inbound mail never needs DNS work
from the tenant. A vanity inbound address on the tenant's domain is out of scope. The outreach
sequencer keeps its own From and Reply-To (the Gmail mailbox, OS-17); its replies are IE-29's.

### Receiving

**IE-8. The webhook.** `POST /webhooks/resend/inbound`, its own endpoint with its own secret
`RESEND_INBOUND_WEBHOOK_SECRET` (and `RESEND_INBOUND_WEBHOOK_PREVIOUS_SECRET` during a rotation),
so the bounce endpoint's secret and subscriptions do not change. It checks, before parsing or
any database work, exactly as R-7: the three signature headers, a `v1` HMAC equal in constant
time over the exact bytes, a timestamp within 5 minutes of the injected clock, a body of at most
256 KiB (413). Any signature failure is 401 with one fixed body; a signed body that is not JSON
is 400. Only `email.received` is read; every other signed event is acknowledged and ignored.
A signed `email.received` whose fields cannot be read is logged `malformed_event` and answered
400, so it shows as failed at Resend and is retried. Database errors answer 503.

**IE-9. Receive: one action, state plus outbox.** For each routed tenant (IE-3) the webhook runs
`inbound.email.receive` through the dispatcher with a server-built principal,
`inboundEmailActorId(tenantId) = derivedId(tenantId, "inbound-email", "actor")`, which may run
`inbound.email.receive`, `inbound.email.settle` and nothing else. Its idempotency key is
`email-inbound:<provider message id>`; the prefix joins `SERVER_IDEMPOTENCY_PREFIXES`, so no
member or MCP key can take it first. In one transaction the action inserts the `inbound_emails`
row (status `fetching`, the address, the reply reference as received, the sender and subject as
the webhook gave them, cut per IE-12) and writes one outbox event `inbound.email.received`
`{ inboundEmailId }`. The key is the provider's message ID, not the webhook's `svix-id`, so a
redelivered webhook and a second event for the same message both replay the stored action. A
unique index on (`tenant_id`, `provider`, `provider_message_id`) backs it.

**IE-10. Content worker.** `GET /cron/inbound-email` in the workers Vercel project and `pnpm
inbound-email:worker`, sharing one runner, like R-9: bearer `CRON_SECRET`, kill switch
`INBOUND_EMAIL_WORKER` (anything but `on` runs nothing), service role through
`INBOUND_EMAIL_DATABASE_URL`, and a cron entry only when `INBOUND_EMAIL_CRON_SCHEDULE` is set at
build time. It selects `inbound.email.received` outbox rows with `processed_at` null (D-2, `FOR
UPDATE SKIP LOCKED`) and leases the email row (D-3 pattern: token, owner, expiry, injected
clock). Under the lease it reads the message from the provider with `RESEND_INBOUND_API_KEY`
(worker only, in `WORKER_ONLY_ENV`), applies IE-12..IE-17 and IE-19..IE-21, then settles
(IE-11). A provider "not found" or a network error retries with backoff up to 8 attempts over
about an hour; after that the email settles with `body_state = unavailable`, so the sender and
subject still reach the Inbox. The worker names `tenant_id` in every statement (D-10).

**IE-11. Settle: one action, state plus outbox.** The worker records what it found with
`inbound.email.settle` through the dispatcher, as the IE-9 principal, keyed
`email-inbound:settle:<inboundEmailId>`. In one transaction it checks the lease token, writes
the content columns, the classification, the match and the review state, inserts the
`email_thread_refs` row for the message's own `Message-ID` (direction `in`), sets the row
`ready` or `dropped`, and writes one outbox event `inbox.email.received` `{ inboundEmailId,
contactId, kind }` for a `ready` row. A settled row never settles again: a repeat replays.
`inbound_emails_guard` keeps every content column unchanged after settle for every role,
the service role included (as `inbox_replies_guard`, I-4).

### Safety

**IE-12. Size caps.** Webhook body 256 KiB (IE-8). Provider answer read up to 2 MiB; a larger
message settles with `body_state = too_large` and no text. Stored: sender name 200 characters,
subject one line of 200 characters, text 20,000 characters (`body_state = truncated` past that,
cut on a code point), `References` the last 20 IDs of at most 255 characters each, at most 20
attachment entries. A cut never changes what is matched: matching uses only the IDs kept.

**IE-13. Text only, sanitised.** The hub stores and shows plain text, never HTML:
- It takes the `text/plain` part when there is one. With only HTML, it converts to text on the
  server: drops `script`, `style`, `head`, comments and elements hidden by `hidden`,
  `display:none`, `visibility:hidden` or a zero font size (hidden text is how injected
  instructions hide); keeps a link as `text (url)`; decodes entities; marks `html_only`.
- It removes NUL and other control characters except tab and newline, normalises line ends to
  `\n`, and removes bidirectional override and isolate characters (U+202A..U+202E,
  U+2066..U+2069) from the text, sender name, subject and attachment names.
- The dashboard renders the text as text: no HTML, no remote images, so no tracking pixel loads.
  Links are shown as text and are not clickable in the first slices.
- The authentication signal: the worker reads only the topmost `Authentication-Results` header
  whose authserv-id equals `INBOUND_AUTHSERV_ID` (the provider's receiving server). Lower ones
  can be forged by the sender and are ignored. `auth = pass` needs `dmarc=pass`; `dmarc=fail`
  is `fail`; anything else, or no such header, is `none`.

**IE-14. Attachments.** The first slices fetch no attachment. Each is recorded as `{ name,
contentType, size }` (name cut to 100 characters, path parts and the IE-13 characters removed),
and the Inbox says the message had attachments the hub did not keep. Slice 3 adds storage with a
type allowlist (PDF, PNG, JPEG), at most 10 MiB each and 25 MiB a message, kept under the tenant
key, served only as a download with `Content-Disposition: attachment` and `X-Content-Type-Options:
nosniff`, never shown inline. No attachment is ever opened by a worker, a model or document
intake unless an owner sends it there.

**IE-15. Kinds.** The worker classifies each message from its headers:
- `bounce`: From local part `mailer-daemon` or `postmaster`, or `Content-Type:
  multipart/report; report-type=delivery-status`. Settled `dropped`. It never records a
  suppression: suppressions come only from the provider's signed bounce events (R-8), never from
  mail anyone can send.
- `loop`: From's domain is `INBOUND_EMAIL_DOMAIN` or the sending domain. Settled `dropped`.
- `automated`: `Auto-Submitted` present and not `no`, `X-Autoreply` or `X-Autorespond`, a
  `Precedence` of `bulk`, `junk`, `list` or `auto_reply`, or a `List-Id` or `List-Unsubscribe`
  header. Shown, collapsed; it never sets `needsReply` and never counts as the customer writing
  (IE-27).
- `spam`: `auth = fail` (IE-13), or the provider's spam verdict when it gives one. Kept and shown
  only under the Inbox's spam filter, never bound to a contact automatically.
- `message`: everything else.
No message is silently dropped except `bounce` and `loop`, because a lost enquiry is the failure
this contract exists to stop.

**IE-16. The hub never answers mail by itself.** No acknowledgement, auto-reply, vacation
notice or bounce is ever sent in answer to inbound mail. Every reply is an owner-approved Inbox
reply (I-6). So no mail loop can start here. Any later automation that answers inbound mail
needs a revision of this file, must not answer an `automated`, `bounce` or `spam` message, and
must send `Auto-Submitted: auto-replied` (RFC 3834).

**IE-17. Flood limits.** Per tenant at most 500 messages, and per sender address at most 50, in
24 hours by the injected clock are fetched with content. Messages over a limit settle `ready`
with `body_state = over_limit` (sender and subject only, no fetch) and raise a cron alert. The
limits bound storage and provider calls; they never hide that mail arrived.

**IE-18. The body is data, never instructions.** For any agent, model or tool that later reads
an inbound message:
- The text goes into the prompt only inside a delimited data block that says it was written by
  an outside person. No instruction is taken from it; a rule in the prompt says so.
- Nothing in a message chooses a tenant, a contact, a recipient, an address, an amount, a tool or
  an action. A draft's recipient comes from the contact record, never from model output or the
  message.
- A model that reads inbound text has no tool that sends, approves, pays, deletes or changes
  settings. Its only outputs are a draft (an Inbox reply under I-5) or a proposal (A-5) that an
  owner decides, and the approver sees the real payload (A-12).
- No worker or agent fetches a URL, opens an attachment or follows an instruction found in a
  message.
- Only the personal-data lane may read inbound text (`docs/integrations.md`, model lanes); one
  prompt holds one customer's messages, never another customer's or another tenant's.
- MCP tools that return inbound text say so in their description (H-10 wording gains "inbound
  email text").
- A test puts instruction-like text, hidden HTML text and a fake `Authentication-Results` in a
  message and proves none of them changes routing, matching, classification or any action.

### Threading

**IE-19. Match order.** Within the routed tenant only, the worker looks for the conversation the
message belongs to, in this order, and stops at the first hit:
1. Headers: `In-Reply-To`, then `References` from newest to oldest, each compared exactly (angle
   brackets trimmed) with `email_thread_refs.rfc_message_id`. These are the `Message-ID`s of
   earlier inbound messages and, once the provider is known to keep them, of our own sends
   (open check, "Provider behaviour").
2. The reply reference in the recipient address (IE-6), looked up in `email_thread_refs`.
3. The sender address: contacts of the tenant whose `normalized_email` equals the normalised
   From address.
A hit in step 1 or 2 names a reference row, and with it a contact and the counterpart address
(the pinned recipient of our delivery, or the sender of the earlier inbound message).

**IE-20. When a match binds.** A message joins a customer's thread (`contact_id` set, `review =
matched`) only when:
- step 1 or 2 hit, the reference names a contact, and the From address equals the reference's
  counterpart address; or
- step 3 found exactly one contact and `auth = pass` (IE-13).
Otherwise it is `possible_match` with the candidate contacts (at most 10) when any step found
one, and `unmatched` when none did. A header or reference hit with a different From (a forward,
a colleague, a spoofer) never binds by itself: the sender proved they saw a message, not that
they are the customer. A `spam` message never binds. A reference whose contact is null (an
earlier unlinked message) puts the message with that sender's other unlinked mail (IE-21).

**IE-21. A new, unknown sender.** No contact is created and no consent is recorded. The message
goes to the sender's thread, `e_<senderKey>` with `senderKey = derivedId(tenantId,
"inbound-sender", <normalised From address>)`, which holds every `possible_match` and
`unmatched` message from that address and shows `needsReview`. The owner links the sender to a
contact (IE-25), after creating the contact if needed. A contact made from an email has no
consent grant: transactional replies may go (D-6), marketing may not.

**IE-22. Deals.** An inbound message is bound to a contact, not to a deal. The thread shows the
contact's open deals from CRM. Inbound mail never moves a deal, creates one or sets a value; an
agent may later propose a stage move through approvals.

**IE-23. Contacts never change.** Receiving, matching and settling change no `crm_contacts`,
`crm_contact_consent`, `crm_deals` or `suppressions` row (P-7). Only an owner's link (IE-25)
sets `contact_id` on inbound rows.

### Inbox

**IE-24. Inbox entries and threads.** Needs `inbox-home.md` revision 5 (I-1, I-2, I-3, I-8,
I-9), written by the first slice:
- I-1: a customer thread also exists for a contact with at least one `ready` inbound email of
  kind `message` or `automated`. A sender thread `e_<senderKey>` exists while that sender has an
  unlinked, unrejected `ready` email. `spam` shows only under `GET /v1/inbox/threads?filter=spam`.
- I-2: `e_` joins `c_` and `v_`, with the same 400 and 404 rules.
- I-3: a new entry `email`: sender name and address, subject, text, `bodyState`, `htmlOnly`,
  kind, `auth`, match (`header`, `reply_ref`, `address`, `linked`), attachments, received time.
- I-8: `needsReply` is true when the latest website request or the latest `message` email is
  newer than the latest approved reply. Sender threads set `needsReview`. The preview may show
  email text (140 characters).
Rows that are `fetching` or `dropped` are not shown.

**IE-25. Link and reject.** `inbox.email.link` `{ senderKey, contactId }`, permission `intake`
(owners, as P-12 link): in one transaction it sets `contact_id`, `review = linked`, `linked_by`
and `linked_at` on every unlinked, unrejected email of that sender, and the contact on their
`email_thread_refs` rows. The contact must belong to the tenant (`TenantDenied`). Later replies in
the same conversation then bind by header (IE-20). `inbox.email.reject` `{ senderKey }` (slice 2)
marks them `rejected`; they leave the Inbox and their text is erased after the retention period
(open decision 3). Both take `Idempotency-Key` and are member actions with `ACTION_PERMISSIONS`
entries; the inbound principal cannot run them.

**IE-26. Answering an email (slice 2).** A reply drafted on a thread whose latest entry is an
email defaults its subject to `Re: <their subject>` (cut to 200). The `message.send_requested`
payload gains optional `inReplyTo` (the inbound email ID); the worker then sends `In-Reply-To`
and `References` built from that email's stored IDs, so the customer's mail client threads it.
This needs a revision of D-1 and a test that a payload naming another tenant's email is refused.

### Follow-ups and outreach

**IE-27. The follow-up agent.** Needs `agents.md` revision 5 (G-7, G-8) and `inbox-home.md` I-6:
- G-7 and G-8: an inquiry is skipped `customer_wrote` when the customer has a `ready` inbound
  email of kind `message` newer than the inquiry. The run checks it before calling the model, and
  the draft action re-checks it under its locks. An `automated` message (out of office) does not
  count.
- I-6: approving a reply that the agent drafted (`drafted_by` = the agent actor) answers 409
  `customer_wrote` with `inboundEmailId` when the customer's newest `message` email is newer than
  the draft. The owner reads the email, discards the draft and writes a new one. A member's own
  draft is not refused; the approve screen shows that the customer wrote after the draft.
- A reply that arrives after an approval and before delivery does not stop that delivery
  (Known limits).
- Templated appointment reminders (G-14..G-20) are not stopped by a reply: they are about a
  booking. A customer who asks to cancel by email is shown to the owner, who cancels.

**IE-28. Outreach prospects who write to the hub.** In the settle transaction, a `message` email
whose From equals the address of an open prospect of the same tenant stops that prospect
`replied`, as OS-19 does for Gmail replies, keyed by the inbound email ID. Slice 4, with IE-29.

**IE-29. Outreach reply bodies: the scope change (owner approval needed).** Storing reply text
needs a Gmail scope that reads bodies. The change: the outreach OAuth app's scopes become
`gmail.send` and `gmail.readonly` (OS-2 accepts that set; a mailbox still on `gmail.metadata`
keeps working without bodies). The app is Internal to the Workspace, so Google's verification and
security assessment do not apply. The code stays narrower than the scope:
- only `messages.get` with `format=full` for a message ID that OS-19 classified `reply`; never
  for `owner_reply`, `auto_reply`, `bounce` or an unmatched message, and never `messages.list`,
  `q`, `threads.get` with bodies or attachment downloads (the fetch guard allows only these
  paths, and a test proves no other Gmail path is called);
- the text goes through IE-12, IE-13 and IE-15 and is stored as an `inbound_emails` row with
  `provider = gmail` and the mailbox, in a sender thread (IE-21), never bound to a contact without
  the owner's link;
- an owner answers in Gmail, in the same thread, until a later revision lets the hub send from
  the mailbox.
Rejected alternatives: a hub Reply-To on cold email (a Reply-To on another domain looks like
phishing to filters and readers, and the conversation leaves the mailbox it started in); keeping
metadata only (the hub then never shows what prospects said). Needs `outreach-sequencer.md`
revision (scope, OS-2, OS-19, "Out of scope") and the owner's approval of the wider Gmail
access (`docs/integrations.md`, open decision 4).

**IE-30. Consent and privacy note for outreach replies.** Prospects did not opt in to the
campaign; they chose to answer it. The hub keeps a reply only to let the business answer that
person. It is visible to members with `inbox.drafts` of that tenant only, goes to no model in
this contract, is erased with the prospect on request, and is erased after the retention period
when never linked (open decision 3). Prospects in the EU or UK wait for the GDPR review
(`docs/integrations.md` open question 3); until then a campaign imports only prospects the owner
states are outside them. The wider scope can technically read the whole mailbox: the two
outreach mailboxes are used for outreach only (an operating rule the repo owner keeps), and the
code limits of IE-29 hold.

### Tenancy, plans and configuration

**IE-31. Tenancy and grants.** `inbound_email_addresses`, `inbound_emails` and
`email_thread_refs` have `tenant_id`, forced RLS with the shared `tenant_scope` policy, keys and
foreign keys that include `tenant_id`, and appear in the catalog isolation test. The runtime role
may SELECT its tenant's rows, INSERT only the IE-9 metadata columns of `inbound_emails`, and
UPDATE only the link columns (`contact_id`, `review`, `linked_by`, `linked_at` of `inbound_emails`, and `contact_id` of `email_thread_refs` `in` rows, IE-25). Only the
service role writes addresses, content columns, settlement and `email_thread_refs` `out` rows.
`inbound_email_route` returns no row of a disabled address and nothing but the tenant and
address IDs.

**IE-32. Plans.** `inbound.email.receive` and `inbound.email.settle` join PL-8's list of inbound
records a read-only tenant still runs, so mail is never lost while a plan lapses; the owner reads
it and pays to reply. Inbound mail does not count toward "Emails a month" (PL-1). Needs a
`plans.md` revision.

**IE-33. MCP.** `get_thread` and `list_threads` (`inbox:read`) return email entries; the H-10
description names inbound email text. No tool links, rejects or reads spam. Needs a
`hub-access.md` revision ("What each read scope discloses").

**IE-34. Configuration the Mac sets.** API project: `INBOUND_EMAIL_DOMAIN`,
`RESEND_INBOUND_WEBHOOK_SECRET`, optional `RESEND_INBOUND_WEBHOOK_PREVIOUS_SECRET`. Workers
project: `INBOUND_EMAIL_WORKER`, `INBOUND_EMAIL_DATABASE_URL`, `RESEND_INBOUND_API_KEY`,
`INBOUND_AUTHSERV_ID`, `INBOUND_EMAIL_CRON_SCHEDULE` (build time), and for the delivery worker
`INBOUND_EMAIL_DOMAIN` and `INBOUND_REF_SECRET`. The worker-split test fails if the API bundle
names a worker-only one. Without `RESEND_INBOUND_WEBHOOK_SECRET` the webhook answers 404; without
`INBOUND_EMAIL_DOMAIN` the delivery worker sends no reply reference. Nothing receives until the
owner publishes the MX record.

## Data model

One migration, `supabase/migrations/<timestamp>_inbound_email.sql`. Times are `timestamptz` set
from the injected clock.

| Table | Columns | Constraints |
|---|---|---|
| `inbound_email_addresses` | `tenant_id`, `id`, `handle`, `kind`, `status`, `created_at`, `disabled_at` | PK (`tenant_id`, `id`); unique `handle` across tenants, `^[a-z2-7]{16}$`; `kind` in `reply`; `status` in `active`, `disabled`; one active `reply` per tenant (partial unique); `disabled_at` set exactly when disabled |
| `inbound_emails` | `tenant_id`, `id`, `address_id`, `mailbox_id`, `provider`, `provider_message_id`, `reply_ref`, `status`, `drop_reason`, `kind`, `from_address`, `from_name`, `subject`, `received_at`, `rfc_message_id`, `in_reply_to`, `references` (text[]), `auth`, `body_text`, `body_state`, `html_only`, `attachments` (jsonb), `contact_id`, `match`, `review`, `candidate_contact_ids` (uuid[]), `sender_key`, `lease_token`, `lease_expires_at`, `attempts`, `next_attempt_at`, `created_at`, `settled_at`, `linked_by`, `linked_at` | PK (`tenant_id`, `id`); unique (`tenant_id`, `provider`, `provider_message_id`); FK (`tenant_id`, `address_id`), (`tenant_id`, `mailbox_id`) to `outreach_mailboxes` and (`tenant_id`, `contact_id`); `provider` in `resend`, `gmail`; `address_id` set exactly when `resend`, `mailbox_id` exactly when `gmail`; `status` in `fetching`, `ready`, `dropped`; `drop_reason` in `bounce`, `loop`, set exactly when dropped; `kind` in `message`, `automated`, `spam`, set when ready; `auth` in `pass`, `fail`, `none`; `body_state` in `full`, `truncated`, `too_large`, `over_limit`, `unavailable`; `match` in `header`, `reply_ref`, `address`, `linked`, `none`; `review` in `matched`, `possible_match`, `unmatched`, `linked`, `rejected`; `contact_id` set exactly when `matched` or `linked`; lengths of IE-12; `inbound_emails_guard` (IE-11); indexes (`tenant_id`, `contact_id`, `received_at`), (`tenant_id`, `sender_key`, `received_at`), (`tenant_id`, `from_address`, `received_at`) |
| `email_thread_refs` | `tenant_id`, `id`, `direction`, `rfc_message_id`, `reply_ref`, `delivery_id`, `inbound_email_id`, `contact_id`, `counterpart_address`, `created_at` | PK (`tenant_id`, `id`); unique (`tenant_id`, `rfc_message_id`) where set; unique (`tenant_id`, `reply_ref`) where set; `direction` `out` has `delivery_id` and `reply_ref`, `in` has `inbound_email_id` and `rfc_message_id`; FKs include `tenant_id` |

Also: `inbound_email_route(handle)` (IE-3); the tenant-insert trigger and backfill (IE-2); the
`inbound.email.*` and `inbox.email.*` action types; `email-inbound:` in
`SERVER_IDEMPOTENCY_PREFIXES`.

## Security and isolation

- The tenant comes only from a hub-issued handle (IE-3). Every lookup after that is in the
  tenant's scope under the runtime role or names `tenant_id` under the service role.
- Signatures are checked before any parse or database work (IE-8). The inbound endpoint has its
  own secret.
- The provider key that reads messages lives only in the workers project (IE-10, IE-34).
- No body, address or subject of unrouted mail is stored or logged (IE-4). Logs for routed mail
  carry IDs and reasons, never text.
- Sender-controlled data (From, headers, references, body) can at most put a message in the
  routed tenant's review queue; it can never bind to a contact without proof (IE-20), change CRM
  data (IE-23), write a suppression (IE-15) or start an action (IE-18).
- Text is sanitised and shown as text (IE-13); attachments are not fetched (IE-14).
- The hub never sends mail by itself in answer to inbound mail (IE-16).

## Tests required

Real Postgres under `zs_runtime` unless named otherwise; a fake inbound provider over a stubbed
`fetch`; injected clock; no real provider call.

1. Two-tenant denial: the catalog test covers the three tables; tenant B's runtime session reads,
   inserts, updates and links nothing of tenant A's, including by passing A's IDs, sender keys or
   handles; `inbound_email_route` returns nothing for a disabled handle.
2. Cross-tenant injection: a message to A's handle that carries B's reply reference, an
   `In-Reply-To` of B's `Message-ID` and a From of B's contact lands in A as `unmatched`, and B's
   tables do not change.
3. Unrouted mail: an unknown handle, a disabled handle and a malformed local part each answer
   200 and leave no row and no log line with an address or subject.
4. Webhook verification: missing, stale, forged and previous-secret signatures; 413 over 256 KiB;
   400 for a signed non-JSON body and for an unreadable `email.received`.
5. Idempotency: the same webhook twice, two different `svix-id`s for one message and two
   concurrent deliveries each give one row and one outbox event; a settle repeated after a lost
   answer replays and writes no second event.
6. State plus outbox: a failure injected after the row insert in receive, and after the update in
   settle, leaves neither the row change nor the event.
7. Matching: header hit with the right From binds; header hit with another From is
   `possible_match`; reply-reference hit binds; address-only binds with `auth = pass` and is
   `possible_match` without it; two contacts with one address is `possible_match`; no contact is
   `unmatched` in `e_<senderKey>`; a forged lower `Authentication-Results` is ignored.
8. Safety: HTML-only, hidden HTML text, bidi overrides, control characters, a 21,000-character
   text, a 3 MiB message, attachments recorded and not fetched; bounce and loop are dropped and
   write no suppression; out-of-office is `automated` and sets no `needsReply`; the flood limits.
9. Prompt injection (IE-18): instruction-like text changes no routing, match, kind or action; the
   prompt builder puts inbound text only inside the data block.
10. Sender: the first attempt stores From with the business name and Reply-To with the reference,
    a resend replays the same bytes, and the reference row is written once; a tenant without an
    address falls back to `RESEND_REPLY_TO`.
11. Inbox reads: a customer thread mixes requests, replies and emails in order; `needsReply` and
    `needsReview` as IE-24; link moves a sender's mail into the customer's thread and a later
    reply in that conversation binds by header.
12. Plans: a read-only tenant still receives and settles.
13. Follow-up (slice 2): a customer email after an inquiry skips it `customer_wrote`; an
    out-of-office does not; approving an agent draft older than the customer's email is 409.
14. Acceptance (slice 1): an owner approves a reply; the delivery goes with the reply address; the
    fake provider posts the customer's reply; the worker fetches it; it shows in that customer's
    thread with `needsReply`; tenant B sees nothing.

## First slice (one PR)

Smallest slice that keeps the promise for the common case: a customer who presses Reply on a hub
email, or writes to the business's hub address, is seen in the Inbox.

In it: IE-1..IE-6 (addresses, routing, From name, Reply-To with reference; R-4 and D-8 revisions
for a per-request Reply-To), IE-8..IE-13 and IE-15..IE-18 (webhook, receive, worker, settle,
caps, text, kinds, no automatic answers, flood limits, untrusted body), IE-14 metadata only,
IE-19..IE-25 without `inbox.email.reject`, IE-31..IE-34, the migration, `inbox-home.md` revision
5, the PL-8 and H-10 revisions, tests 1..12 and 14. Off by default: the webhook answers 404 and
the worker runs nothing until the Mac sets IE-34 and the owner publishes the MX record.

Order of the rest, one PR each:
2. Answering in the email thread (IE-26), `inbox.email.reject`, the follow-up agent change
   (IE-27, test 13), and `message.received` for email in Activepieces (its own revision).
3. Attachments storage (IE-14 second half).
4. Outreach reply bodies and prospects who write to the hub (IE-28..IE-30), after the owner
   approves the scope change.
5. Forwarding addresses (`kind = forwarding`) on the same pipeline, with Gmail's forwarding
   confirmation code shown to the owner.
Later, each with its own revision: From on a tenant's verified domain (IE-7), owner
notifications, mailbox OAuth (decision 1 B).

## Built, and left out

Nothing is built. Left out of this contract on purpose:
- Mailbox OAuth for Gmail or Microsoft: verification cost, privacy, and the owner's approval of
  a new connection (decision 1).
- HTML rendering, clickable links and attachment previews: text only until a sanitising
  renderer has its own review.
- Automatic contact creation from email: anonymous input never makes CRM records (P-7).
- Suppressions from inbound bounces: only signed provider events write them (R-8).
- Replies sent from the hub through an outreach Gmail mailbox.
- Deleting the provider's copy of a message: waits on what the provider supports.

## Known limits

- A customer whose mail client ignores Reply-To writes to the shared sender and is not seen.
- A reply that arrives after an owner approved an agent follow-up and before it is delivered does
  not stop that delivery.
- Without an authentication signal from the provider, a new email from a known customer is a
  `possible_match` until the owner links it once; later mail in that conversation binds by header.
- A customer who writes from another address (an alias, a work address) is a new sender until
  linked.
- Header matching on our own sends depends on the provider keeping our `Message-ID` (unverified);
  the reply reference covers replies to our sends without it.
- The provider keeps its own copy of each message for a time the provider sets.

## Open decisions (need the repo owner)

1. **DNS, key and cost.** Publish MX (and the provider's records) for `reply.zerosumsolutions.com`,
   create a Resend key that can read received mail (workers project only), and accept any plan
   change if received mail counts toward Resend's quota (`docs/integrations.md` open question 4).
2. **From name.** The business name alone (recommended; how booking tools usually send) or
   "<business> via ZS Hub" (plainer about the shared sender, lower impersonation risk on a shared
   domain).
3. **Retention.** How long text of unlinked or rejected mail and of outreach replies is kept
   (recommended: 90 days, then the text is erased and the sender, subject and time stay).
4. **Outreach scope and the public address.** Approve `gmail.readonly` on the two outreach
   mailboxes (IE-29) or keep metadata only; and whether owners may publish the hub address as a
   public "email us" address (recommended yes, with rotation), which invites some spam into the
   Inbox's spam filter.
