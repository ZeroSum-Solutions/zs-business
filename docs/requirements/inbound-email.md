# Inbound email: customer replies reach the Inbox

Status: draft contract, not built (2026-11-10), revision 2 (2026-11-11: the fix round after three
independent reviews; it fixes the settle write path, binding without proof, the authentication
signal, erasure, outreach privacy and routing, and re-cuts the slices). Code follows this file
once its first slice lands; a change to a numbered rule needs a new revision of this file first.
Four choices wait on the repo owner ("Open decisions"); the rules below use the recommended
answer for each, and the first slice can be built on them without code changes if the owner
agrees.

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

What exists today (read 2026-11-10 and 2026-11-11):
- The Inbox has no conversation or message tables. Threads are derived on read from
  `intake_items` (website requests) and `inbox_replies` (`inbox-home.md` I-1,
  `packages/core/src/reads/inbox.ts`). An inbound email is therefore a new entry source, and
  `inbox-home.md` needs a revision for it (IE-24), as `twilio.md` already notes for callbacks.
- Outbound email goes through the delivery outbox (`delivery.md` D-1..D-11) to Resend
  (`resend.md`). `from` and `reply_to` come from one global config, `RESEND_FROM` and the
  optional `RESEND_REPLY_TO` (`packages/core/src/delivery/resend.ts`, R-4, R-6). A customer who
  presses Reply writes to that shared address or to the global Reply-To, and the hub never sees
  it. The adapter refuses `Reply-To` and `Message-ID` as request headers (`RESERVED_HEADERS`),
  and the send API answers with Resend's own ID only, so the hub never learns the `Message-ID`
  of what it sent.
- `POST /webhooks/resend` (`apps/api/src/public/resend-webhook.ts`) verifies Standard Webhooks
  signatures and acts only on bounces, complaints and suppressions; its own comment says
  `email.received` is not subscribed. R-8 binds an event to a tenant only through tags this
  system set, and checks them under that tenant's scope.
- The dispatcher runs every action in `ctx.db.tenant(...)` (`packages/core/src/actions/dispatch.ts`),
  which is `SET LOCAL ROLE authenticated` behind a check that refuses any login that is not an
  unprivileged member of `authenticated` (`packages/db/src/scoped.ts`, `RUNTIME_LOGIN_CHECK`).
  `asService` is `service_role` with no tenant and no dispatcher. A worker that dispatches
  actions therefore holds a second, runtime login and calls `assertRuntimeLogin` at start, as
  `apps/api/src/outreach/start.ts` and `apps/api/src/images/start.ts` do. The dispatcher stores
  every action's payload and result for good, so neither may hold message text.
- Both approval routes run an approved send: the reply route and the generic approve
  (`approveApproval`, A-6 then A-7) call the same `runApproved` in
  `packages/core/src/edge/session.ts`. A check that must hold for every send of a reply lives in
  the `inbox.reply.send` action, not in a route.
- A tenant has at most one contact per normalised email (`crm_contacts_tenant_email`,
  `supabase/migrations/20261017170100_crm.sql`). Normalising is `contactEmailInputSchema`
  (`packages/contracts/src/crm.ts`): trimmed, ASCII only, lower case, a valid address.
- The outreach sequencer reads Gmail with `gmail.metadata` only: it sees that a reply arrived and
  stops the prospect, but never reads a body (`outreach-sequencer.md` OS-19, "Why
  `gmail.metadata`"). Its consent step requires exactly `gmail.send` and `gmail.metadata`
  (OS-2). `outreach_inbound_events` stores no text. Its Known limits say replies are read in
  Gmail and nothing reaches the hub Inbox.
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
- `inbox:read` already discloses message text to whatever holds the token, a model included
  (`hub-access.md`, "What each read scope discloses").
- Read-only tenants still run inbound records (`plans.md` PL-8); server key prefixes are
  reserved (`approvals.md` A-14, `delivery.md` D-9); stored text is data, not instructions
  (`hub-access.md` H-10, `docs/integrations.md` "Untrusted input").

Provider behaviour, verified in Resend's public docs on 2026-11-11 (in our own words; recheck
when each slice starts; until the first real message only the fake provider proves it):
- A domain or subdomain whose MX record points at Resend receives mail for every local part at
  that domain. Each received message raises a signed `email.received` webhook (the same Standard
  Webhooks scheme as R-7). It carries metadata only: Resend's `email_id`, the message's own
  `message_id` header, the bare sender address `from`, the arrays `to`, `cc`, `bcc` and
  `received_for`, the subject and attachment metadata. Resend fills `received_for` from the `for`
  clauses of the message's `Received` headers.
- `GET /emails/receiving/{email_id}` returns the text and HTML parts, the headers (the sender's
  display name is in `headers.from`), `reply_to`, attachment metadata, a signed `raw` download
  URL, and `authentication` with `spf`, `dkim` and `dmarc` results. Resend computes those on its
  receiving server, not from the message's headers, so a sender cannot forge them. Each is
  `pass`, `fail`, `gray`, `unknown` or `processing_failed`, and the object is null for mail
  received before the field existed. `dmarc = gray` means the sending domain has no DMARC policy
  or only `p=none`.
- By default inline images come back inside `html` as base64 `data:` URIs; `html_format=cid`
  keeps them out, and Resend answers in `cid` form anyway when a message is too large to inline.
- **Quota:** each received email counts as one email against the account's daily and monthly
  quota, the same quota that sending uses (the Free plan's 100 a day and 3,000 a month cover
  both).
- **Over quota:** a retrieve of a message that arrived while the account was over quota answers
  403 `email_above_quota`; its content cannot be read at all.
- **Key:** a Resend key is either `sending_access` (send only; anything else answers 401
  `restricted_api_key`) or `full_access` (create, read, update and delete every resource:
  domains, keys, webhooks, contacts). There is no read-only or receive-only key, so the key that
  reads received mail is a full-access key.
- The `email.sent` webhook carries the sent message's `message_id`.

Still unverified, checked in the slice that first depends on it; every rule below holds when the
answer is the unfavourable one:
- whether `bcc` lists a hub address that was only an envelope recipient (a blind copy), and
  whether `to`, `cc` or `bcc` ever reflect the SMTP envelope at all (IE-3);
- whether one message to two hub addresses is one `email_id` or one per recipient (IE-3, IE-9);
- the SMTP size and recipient limits at Resend, and the retrieve rate limit for received mail
  (IE-12, IE-17);
- how long Resend keeps received mail and whether it can be deleted early (one reviewer reports
  30 days with no early deletion; not confirmed here) (Known limits);
- whether repeated headers keep every copy in `headers` (IE-15);
- whether Resend gives any spam verdict (none in the documented fields) (IE-15);
- whether a custom `Message-ID` on a sent email survives to the recipient (IE-19 no longer
  depends on it).

### Decision 1: how mail gets in

| | A. Hub reply address, provider inbound webhook | B. OAuth read of the tenant's Gmail or Microsoft mailbox | C. Forwarding address |
|---|---|---|---|
| How | Every hub email carries `Reply-To: <tenant address>@<inbound domain>`. The inbound domain's MX points at Resend, which posts each message to the hub. | The owner signs in; a worker polls the mailbox and copies customer mail into the hub. | The owner sets a forwarding rule in their own mailbox to the tenant's hub address. Same pipeline as A. |
| Cost | No new vendor. One MX record on a hub subdomain. Each received email counts one for one against the Resend quota that sending also uses, and reading it needs a full-access key (verified). | Google's restricted read scopes for a public app need Google's verification and a yearly paid security assessment before any outside tenant can connect. Microsoft needs publisher verification. Composio's managed apps avoid that but count as a managed connection (PL-1) and pass mailbox content through a third party. | As A. |
| Setup for a non-technical owner | Nothing. The address exists from the start and replies just arrive. | One sign-in, but the consent screen asks to read all their mail, and many Microsoft 365 organisations require an admin to approve it. | Hard. Mail settings, a confirmation code Gmail sends to the forwarding address, and Microsoft 365 blocks automatic forwarding outside the organisation by default. |
| Deliverability | Inbound is unaffected (we run the receiving address). Outbound keeps the shared sender (decision 3). | Best: mail stays in the owner's own mailbox. | Forwarding breaks SPF and often DMARC; forwarded mail is more often flagged, so the authentication signal (IE-13) is weaker. |
| Privacy | The hub sees only mail sent to the business's hub address. | The hub can read every message in the mailbox, personal mail included. A leaked token exposes all of it. | Usually everything the owner gets, unless they write filters. |
| Routing and threading | Address chosen by the hub (IE-3); a per-message reply reference (IE-6). | Strong (provider thread IDs). | The hub address is not in To or Cc, so routing needs an envelope source Resend does not document (IE-3); no reply reference on mail the hub did not send. |

**Recommended: A.** It fixes the lost replies with no owner setup, no new vendor and the least
data. C is a later slice on A's pipeline (a second address kind) for owners who want every
customer email in the hub, once its routing source is settled. B is deferred: it needs the
owner's approval of a new Gmail or Microsoft connection (`docs/integrations.md` rule) and the
verification cost, and only pays off when tenants want their old mailbox history.

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
| From name | business name; "business name via ZS Hub"; the hub's name | The business name from `business_profiles` (IE-5, slice 4). Open decision 2. |
| Reply-To | the tenant's hub address with a reply reference; the owner's own address; none | The tenant's hub address with a per-delivery reply reference (IE-6, slice 3). The owner's own address is how replies get lost from the hub today; none sends replies to the shared sender. |

## Numbered rules

### Addresses and routing

**IE-1. The inbound domain.** One hub subdomain, `INBOUND_EMAIL_DOMAIN` (recommended
`reply.zerosumsolutions.com`, open decision 1), with its MX at the inbound provider. It is
separate from the sending domain, so inbound DNS never touches the sending reputation or the
DKIM, SPF and DMARC records under `mail`. The repo owner publishes the records; no agent changes
DNS.

**IE-2. Tenant addresses.** `inbound_email_addresses` holds a tenant's addresses: `handle` (16
characters of lower-case base32, 80 random bits from the database's `gen_random_bytes`), `kind`
(`reply`; `forwarding` joins with slice 7), `status` (`active`, `retiring`, `disabled`). A handle
is unique across all tenants. A tenant has at most one active `reply` address (partial unique
index). The migration creates one for every tenant; a trigger on tenant insert creates one for
each new tenant. Only the service role writes the table. Rotation (a later owner action) creates
a new active address and moves the old one to `retiring` with `retire_after` 90 days on; a
`retiring` address still routes, so replies to mail already sent are not lost, and the worker
moves it to `disabled` after that time. An operator may disable an address at once (a flood,
IE-17). The address is `<handle>@<INBOUND_EMAIL_DOMAIN>`. No hub email and no dashboard screen
names it before slice 3 (First slice). The owner may then publish it as the business's "email
us" address (open decision 4 covers the spam exposure).

**IE-3. Routing a message to one tenant.** The tenant comes only from a recipient address the
hub issued:
- The webhook reads `to`, `cc` and `bcc` (at most 50 addresses together) and keeps those whose
  domain equals `INBOUND_EMAIL_DOMAIN`, compared in lower case. Recipients at other domains are
  ignored. `received_for` never routes.
- Why: Resend fills `received_for` from the `for` clauses of `Received` headers, text that the
  sender and every relay before Resend can write, so it can name any tenant's handle. `to` and
  `cc` are sender-written too, but a handle named there gets the sender nothing they could not
  get by mailing that handle directly, and Resend documents no field that is the SMTP envelope
  recipient. The log counts hub-domain entries of `received_for` that routing did not use
  (`received_for_unrouted`), never the addresses.
- A kept local part, lower-cased, must match `^[a-z2-7]{16}(\+[a-z2-7]{16})?$`: the handle, and
  an optional reply reference after `+` (IE-6). Anything else is not routed.
- The handle is looked up with `inbound_email_route(handle)`, a `SECURITY DEFINER` function with
  a pinned `search_path` that returns only `tenant_id` and `address_id` of an `active` or
  `retiring` address, executable by the runtime role. Every later read and write runs in that
  tenant's scope (runtime role, RLS), as R-8 does after reading its tags.
- Nothing else picks a tenant: not From, Subject, `In-Reply-To`, `References`, any `X-` header,
  the body, `received_for` or the reply reference. A reference, a header or an address that
  names another tenant's data finds nothing, because every lookup after routing is in the routed
  tenant's scope.
- A message addressed to hub addresses of several tenants is received once per routed tenant,
  each under its own tenant, each with its own action (IE-9).
- Several kept addresses that route to the same tenant (the active and the retiring handle, or
  two references) are collapsed to one action for that tenant before dispatch. The address used
  is the first one with a reply reference, in the order `to`, `cc`, `bcc` and then as listed;
  with no reference, the first in that order. So a redelivered webhook builds the same payload.

**IE-4. Mail that matches no tenant.** A message with no routed recipient (unknown handle,
disabled address, malformed local part, a hub address only in `received_for`) is acknowledged
with 200 and leaves nothing: no row, no body fetch, no reply, no bounce. The log gets one line
with Resend's `email_id` and the reason (`unrouted`), never an address, subject or body. A count
per hour feeds the existing cron alerts. The hub never sends a bounce or notice for unrouted
mail, so a forged sender cannot use it to send backscatter.

### Sender

**IE-5. From (slice 4).** Transactional email keeps the shared sender address from
`RESEND_FROM`. The display name is the tenant's business name (`business_profiles`), one line, at
most 64 characters, with `"`, `<`, `>`, `@`, `\`, control characters and bidirectional overrides
removed; an empty result falls back to the configured name. The worker builds the full From at a
delivery's first attempt and stores it with the request, so every later attempt replays the same
bytes (D-8, R-2). Marketing email keeps M-3 (the tenant's verified domain). Needs revisions of
R-4 and D-8 in the same PR.

**IE-6. Reply-To with a reply reference (slice 3).** Every email the delivery worker sends for a
tenant with an active reply address carries `Reply-To: <handle>+<ref>@<INBOUND_EMAIL_DOMAIN>`,
where `ref` is the first 10 bytes of HMAC-SHA-256 over `zsr1:<tenantId>:<deliveryId>` with
`INBOUND_REF_SECRET`, in lower-case base32 (16 characters). At the first attempt, in the
transaction that stores the request, the worker records the reference in `email_thread_refs`
(direction `out`, the delivery, the contact, the pinned recipient). The reply address is part of
the stored request and is replayed unchanged. The global `RESEND_REPLY_TO` is used only for a
tenant without an active address. The reference proves which delivery a reply answers; it never
chooses the tenant (IE-3). It is the one change slice 3 makes to the live send request, and it
needs revisions of R-4 (a per-request Reply-To) and D-8 (the stored request holds it) in that PR.

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
`email-inbound:<email_id>`, where `email_id` is Resend's ID for the received message (never the
sender's `message_id` header). The prefix joins `SERVER_IDEMPOTENCY_PREFIXES`, so no member or
MCP key can take it first. In one transaction the action inserts the `inbound_emails` row
(status `received`, kind `unclassified`, `body_state = none`, the address, the reply reference
as received, the sender address normalised per IE-19 and the subject as the webhook gave them,
cut per IE-12) and writes one outbox event `inbound.email.received` `{ inboundEmailId }`. The
payload holds IDs, the address, the reference and the subject; it never holds a body. The key is
Resend's `email_id`, not the webhook's `svix-id`, so a redelivered webhook and a second event for
the same message both replay the stored action. A unique index on (`tenant_id`, `provider`,
`provider_email_id`) backs it.

**IE-10. Content worker (slice 2).** `GET /cron/inbound-email` in the workers Vercel project and
`pnpm inbound-email:worker`, sharing one runner, like R-9: bearer `CRON_SECRET`, kill switch
`INBOUND_EMAIL_WORKER` (anything but `on` runs nothing), and a cron entry only when
`INBOUND_EMAIL_CRON_SCHEDULE` is set at build time. It holds two database logins:
- `INBOUND_EMAIL_DATABASE_URL`, a login that may `SET ROLE service_role`: it claims
  `inbound.email.received` outbox rows with `processed_at` null (D-2, `FOR UPDATE SKIP LOCKED`),
  writes the lease on the email row (D-3: token, owner, expiry, attempts, next attempt, injected
  clock), marks the outbox row processed, and runs the retention erasure (IE-35);
- `INBOUND_EMAIL_RUNTIME_DATABASE_URL`, a `zs_runtime` login. The runner calls
  `assertRuntimeLogin` on it before any work and stops if it is privileged. Settle (IE-11) runs
  through the dispatcher on this login only.
Under the lease it reads the message with `RESEND_INBOUND_API_KEY` (worker only, in
`WORKER_ONLY_ENV`) as `GET /emails/receiving/{email_id}?html_format=cid`, applies IE-12..IE-17
and IE-19..IE-21, then settles. It never follows `raw.download_url` and never fetches an
attachment. A 404, a 429, a 5xx or a network error retries with backoff up to 8 attempts over
about an hour; after that the email settles with `body_state = unavailable`. A 403
`email_above_quota` settles at once with `body_state = over_quota` and raises a cron alert: the
content cannot be read, so retrying only spends calls. Any other 401 or 403 stops the run and
alerts (a wrong or sending-only key). The worker names `tenant_id` in every service-role
statement (D-10).

**IE-11. Settle: one action, state plus outbox.** The worker records what it found with
`inbound.email.settle` through the dispatcher, as the IE-9 principal, under the runtime role and
the routed tenant's scope (IE-10), keyed `email-inbound:settle:<inboundEmailId>`:
- The payload is `{ inboundEmailId, leaseToken, contentSha256 }`. The fetched content travels to
  the handler in the dispatch context the worker builds for that one call
  (`DispatchContext.config`, which the dispatcher never stores), and the handler refuses content
  whose SHA-256 differs from the payload's. So no text enters the stored action, and a repeat
  with other content is refused, not applied.
- In one transaction it locks the row, requires `status = received` and the lease token unexpired
  by the injected clock, writes the content and settlement columns, the classification, the
  match and the review state, inserts the `email_thread_refs` row for the message's own
  `Message-ID` when IE-19 allows it (direction `in`), sets the row `ready` or `dropped`, and writes
  one outbox event `inbox.email.received` `{ inboundEmailId, contactId, kind }` for a `ready` row.
  The result holds IDs and states only.
- When it binds a contact it first takes the per-contact lock that `inbox.reply.send` also takes
  (IE-27).
- A settled row never settles again: a repeat replays.
- The database enforces the rest (`inbound_emails_guard`, every role, the table owner included,
  as `inbox_replies_guard`, I-4): see IE-35.
The runtime role's grants (IE-31) allow these writes; the guard allows them only in the one move
from `received` to `ready` or `dropped`, and only the inbound principal may dispatch the action.

### Safety

**IE-12. Size caps.** Webhook body 256 KiB (IE-8). The provider answer is read as a stream and
cut off at 2 MiB, whatever its declared length; a larger answer settles with
`body_state = too_large` and no text. Stored: sender name 200 characters, subject one line of
200 characters, text 20,000 characters (`body_state = truncated` past that, cut on a code point),
`References` the last 20 IDs of at most 255 characters each, at most 20 attachment entries. A
cut never changes what is matched: matching uses only the IDs kept.

**IE-13. Text only, sanitised, and the authentication signal.** The hub stores and shows plain
text, never HTML:
- It takes `text` when there is one. With only `html`, it converts to text on the server: drops
  `script`, `style`, `head`, comments, `img` and elements hidden by `hidden`, `display:none`,
  `visibility:hidden` or a zero font size (hidden text is how injected instructions hide); keeps
  a link as `text (url)`; decodes entities; marks `html_only`.
- It removes NUL and other control characters except tab and newline, normalises line ends to
  `\n`, and removes bidirectional override and isolate characters (U+202A..U+202E,
  U+2066..U+2069) from the text, sender name, subject and attachment names.
- The sender name comes from the display name in `headers.from` of the retrieve answer (the
  webhook's `from` is the bare address), sanitised as above.
- The dashboard renders the text as text: no HTML, no remote images, so no tracking pixel loads.
  Links are shown as text and are not clickable in the first slices.
- The authentication signal is Resend's receiver-computed `authentication.dmarc` only:
  `pass` gives `auth = pass`, `fail` gives `fail`, and `gray`, `unknown`, `processing_failed`, a
  null `authentication` or a missing field give `none`. No `Authentication-Results` or other
  header in the message is ever read for it. DMARC proves the From domain, not the mailbox: any
  user of a domain can pass as another user of the same domain.

**IE-14. Attachments.** The first slices fetch no attachment. Each is recorded as `{ name,
contentType, size }` (name cut to 100 characters, path parts and the IE-13 characters removed),
and the Inbox says the message had attachments the hub did not keep. Slice 5 adds storage with a
type allowlist (PDF, PNG, JPEG), at most 10 MiB each and 25 MiB a message, kept under the tenant
key, served only as a download with `Content-Disposition: attachment` and `X-Content-Type-Options:
nosniff`, never shown inline. No attachment is ever opened by a worker, a model or document
intake unless an owner sends it there.

**IE-15. Kinds.** The worker classifies each fetched message from its headers:
- `bounce`: From local part `mailer-daemon` or `postmaster`, or `Content-Type:
  multipart/report; report-type=delivery-status`. Settled `dropped`. It never records a
  suppression: suppressions come only from the provider's signed bounce events (R-8), never from
  mail anyone can send.
- `loop`: From's domain is `INBOUND_EMAIL_DOMAIN` or the sending domain. Settled `dropped`.
- `automated`: `Auto-Submitted` present and not `no`, `X-Autoreply` or `X-Autorespond`, a
  `Precedence` of `bulk`, `junk`, `list` or `auto_reply`, or a `List-Id` or `List-Unsubscribe`
  header. Shown, collapsed; it never sets `needsReply` and never counts as the customer writing
  (IE-27).
- `spam`: `auth = fail` (IE-13), or a provider spam verdict if one is ever documented. Kept and
  shown only under the Inbox's spam filter, never bound to a contact automatically.
- `message`: everything else that was fetched.
- `unclassified`: the kind of every row before settle, and after settle of a row whose content
  was never read (`body_state` `too_large`, `over_limit`, `over_quota` or `unavailable`). It has
  no headers and no authentication result, so it never binds to a contact, never sets
  `needsReply` and never counts as the customer writing. It goes to the sender's thread with
  `needsReview`, so the owner still sees that mail came.
No message is silently dropped except `bounce` and `loop`, because a lost enquiry is the failure
this contract exists to stop.

**IE-16. The hub never answers mail by itself.** No acknowledgement, auto-reply, vacation
notice or bounce is ever sent in answer to inbound mail. Every reply is an owner-approved Inbox
reply (I-6). So no mail loop can start here. Any later automation that answers inbound mail
needs a revision of this file, must not answer an `automated`, `bounce`, `spam` or
`unclassified` message, and must send `Auto-Submitted: auto-replied` (RFC 3834).

**IE-17. Flood limits and the shared quota.** Resend counts every received email against the
account's daily and monthly quota before the hub sees it, the same quota that sending uses, and
nothing in the hub can stop that count. So:
- Admission: per tenant at most 2,000 received rows in 24 hours by the injected clock. Past that
  the webhook stores nothing for that tenant, answers 200, counts the message in the log
  (`over_admission`, the tenant ID only) and raises a cron alert. This bounds rows, not Resend's
  count.
- Content: per tenant at most 500 messages, and per sender address at most 50, in 24 hours are
  fetched. Messages over a limit settle `ready` with `body_state = over_limit` and kind
  `unclassified` (sender and subject only, no fetch) and raise a cron alert.
- Account: when received mail across all tenants passes `INBOUND_EMAIL_DAILY_ALERT` in 24 hours
  (default 50, half of the Free plan's daily quota), a cron alert fires, because past the quota
  both sending and reading stop (IE-10's `over_quota`).
- Protecting outbound: the operator's levers are to disable a flooded tenant's address (IE-2;
  Resend still counts mail to it, but the sender sees a dead address over time) and, for an
  account-wide flood, to remove the MX record. A paid plan without a daily quota is a condition
  of publishing MX (open decision 1).
The limits bound storage and provider calls; they never hide that mail arrived below the
admission cap.

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
- Only `provider = resend` rows may reach any model, MCP tool, automation token or flow.
  Outreach replies (`provider = gmail`) never do (IE-30).
- A test puts instruction-like text, hidden HTML text and a forged `Authentication-Results:
  dmarc=pass` header in a message whose `authentication.dmarc` is `gray`, and proves none of them
  changes routing, `auth`, matching, classification or any action.

### Threading

**IE-19. Match order (slice 3).** Within the routed tenant only, the worker looks for the
conversation a fetched message belongs to, in this order, and stops at the first hit:
1. Headers: `In-Reply-To`, then `References` from newest to oldest, each compared exactly (angle
   brackets trimmed) with `email_thread_refs.rfc_message_id` of direction `in`: the `Message-ID`s
   of earlier inbound messages. The hub does not learn the `Message-ID` of what it sends (the send
   API returns Resend's ID only and the adapter may not set one), so our own sends are found by
   the reply reference, not by headers. Recording the `message_id` of the `email.sent` webhook
   is a possible later revision, not part of this contract.
2. The reply reference in the recipient address (IE-6), looked up in `email_thread_refs`
   direction `out`.
3. The sender address: the tenant's contact whose `normalized_email` equals the From address
   normalised by `contactEmailInputSchema` (`packages/contracts/src/crm.ts`). A From that fails
   the schema matches no contact. The unique index allows at most one such contact.
A hit in step 1 or 2 names a reference row, and with it a contact and the counterpart address
(the pinned recipient of our delivery, or the sender of the earlier inbound message).
A message's own `Message-ID` is recorded as a direction `in` reference only when it is present,
at most 255 characters, and not already a reference of this tenant. A missing, long or colliding
ID is kept on the row for display and threading of our answer (IE-26) but never used to match,
and the settle still succeeds. Two `email_id`s with the same `Message-ID` and the same From in
one tenant are one message delivered twice: the second settles `ready` with `duplicate_of` set
and is not shown.

**IE-20. When a match binds.** A message joins a customer's thread (`contact_id` set, `review =
matched`) only with proof that does not rest on what the sender typed. Two proofs count:
- **The reference.** Step 2 hit a reference less than 180 days old; From equals that reference's
  pinned recipient; `auth` is not `fail`. The reference is 80 bits of HMAC the sender cannot
  guess; it reaches only the person we mailed, in the Reply-To of one delivery. `match =
  reply_ref`.
- **Authentication.** `auth = pass`, and either step 1 hit with From equal to the reference's
  counterpart (`match = header`) or step 3 found the contact (`match = address`).
Everything else is `possible_match` with the candidate contacts (at most 10) when any step found
one, and `unmatched` when none did. A header hit without `auth = pass` never binds: a
`Message-ID` travels with every copy of a thread, forwards and copies to others included. A
reference hit with a different From (a forward, a colleague, a spoofer) never binds: the sender
proved they saw a message, not that they are the customer. `spam` and `unclassified` messages
never bind. A reference whose contact is null (an earlier unlinked message) puts the message with
that sender's other unlinked mail (IE-21). The Inbox entry shows `auth`, so a bound message
without `auth = pass` reads "sender not verified" (IE-24). The remaining gap (a leaked reference
plus a forged From on a domain without an enforced DMARC policy) is in Known limits.

**IE-21. A new, unknown sender.** No contact is created and no consent is recorded. The message
goes to the sender's thread, `e_<senderKey>` with `senderKey = derivedId(tenantId,
"inbound-sender", <normalised From address>)`, which holds every `possible_match`, `unmatched`
and unclassified message from that address and shows `needsReview`. The owner links the sender to
a contact (IE-25), after creating the contact if needed. A contact made from an email has no
consent grant: transactional replies may go (D-6), marketing may not.

**IE-22. Deals.** An inbound message is bound to a contact, not to a deal. The thread shows the
contact's open deals from CRM. Inbound mail never moves a deal, creates one or sets a value; an
agent may later propose a stage move through approvals.

**IE-23. Contacts never change.** Receiving, matching and settling change no `crm_contacts`,
`crm_contact_consent`, `crm_deals` or `suppressions` row (P-7). Only an owner's link (IE-25)
sets `contact_id` on inbound rows after settle.

### Inbox

**IE-24. Inbox entries and threads.** Needs `inbox-home.md` revision 5 (I-1, I-2, I-3, I-8,
I-9), written by slice 1 for sender threads and extended by slice 3 for customer threads:
- I-1 (slice 1): a sender thread `e_<senderKey>` exists while that sender has an unlinked,
  unrejected email of status `received` or `ready` that is not `spam`. `spam` shows only under
  `GET /v1/inbox/threads?filter=spam` (slice 2).
- I-1 (slice 3): a customer thread also exists for a contact with at least one bound `ready`
  email of kind `message` or `automated`.
- I-2: `e_` joins `c_` and `v_`, with the same 400 and 404 rules.
- I-3: a new entry `email`: sender name and address, subject, text, `bodyState`, `htmlOnly`,
  kind, `auth`, match (`header`, `reply_ref`, `address`, `linked`), attachments, received time.
  A `received` row shows sender, subject and time only, marked as content pending.
- I-8: `needsReply` is true when the latest website request or the latest bound `message` email
  is newer than the latest approved reply. Sender threads set `needsReview`. The preview may
  show email text (140 characters).
- Rows that are `dropped`, and duplicates (IE-19), are not shown.
- Who sees what: the read takes the caller. A member session sees `provider = resend` rows with
  the Inbox's member permission and `provider = gmail` rows only with `inbox.drafts` (IE-30).
  MCP and automation tokens see no email entry until slice 4, then only `provider = resend`
  rows (IE-33).

**IE-25. Link and reject (slice 3; reject in slice 4).** `inbox.email.link` `{ senderKey,
contactId }`, permission `intake` (owners, as P-12 link): in one transaction it takes the
per-contact lock (IE-27), sets `contact_id`, `review = linked`, `linked_by` and `linked_at` on
every unlinked, unrejected email of that sender, and the contact on their `email_thread_refs`
`in` rows. The contact must belong to the tenant (`TenantDenied`). A later reply in the same
conversation then binds when IE-20 allows it. `inbox.email.reject` `{ senderKey }` marks them
`rejected`; they leave the Inbox and their text is erased by IE-35 after the retention period.
Both take `Idempotency-Key` and are member actions with `ACTION_PERMISSIONS` entries; the inbound
principal cannot run them.

**IE-26. Answering an email (slice 4).** A reply drafted on a thread whose latest entry is an
email defaults its subject to `Re: <their subject>` (cut to 200). The `message.send_requested`
payload gains optional `inReplyTo` (the inbound email ID); the worker then sends `In-Reply-To`
and `References` built from that email's stored IDs, so the customer's mail client threads it.
This needs a revision of D-1 and a test that a payload naming another tenant's email is refused.

### Follow-ups and outreach

**IE-27. The follow-up agent (slice 3, with the first email in a customer thread).** Needs
`agents.md` revision 5 (G-7, G-8) and `inbox-home.md` I-6:
- G-7 and G-8: an inquiry is skipped `customer_wrote` when the customer has a bound `ready`
  inbound email of kind `message` newer than the inquiry. The run checks it before calling the
  model, and the draft action re-checks it under its locks. An `automated` or `unclassified`
  message does not count.
- I-6: the `inbox.reply.send` action itself, not a route, refuses a reply that the agent drafted
  (`drafted_by` = the agent actor) with 409 `customer_wrote` and `inboundEmailId` when the
  customer's newest bound `message` email is newer than the draft. Both approval routes run that
  action (the reply route and the generic A-6/A-7 approve, `runApproved` in
  `packages/core/src/edge/session.ts`), so both are covered. The action and settle (IE-11) and
  link (IE-25) take the same transaction lock per tenant and contact (`pg_advisory_xact_lock`),
  so a settle that commits first is always seen by the send. The owner reads the email, discards
  the draft and writes a new one. A member's own draft is not refused; the approve screen shows
  that the customer wrote after the draft.
- A reply that arrives after a send committed and before delivery does not stop that delivery
  (Known limits).
- Templated appointment reminders (G-14..G-20) are not stopped by a reply: they are about a
  booking. A customer who asks to cancel by email is shown to the owner, who cancels.

**IE-28. Outreach prospects who write to the hub (slice 6).** In the settle transaction, a
`message` email whose From equals the address of an open prospect of the same tenant stops that
prospect `replied`, as OS-19 does for Gmail replies, keyed by the inbound email ID.

**IE-29. Outreach reply bodies: the scope change (slice 6, owner approval needed).** Storing
reply text needs a Gmail scope that reads bodies. The change: the outreach OAuth app's scopes
become `gmail.send` and `gmail.readonly`. OS-2 today requires exactly `gmail.send` and
`gmail.metadata`, so OS-2 changes in the same PR to accept either set, and a mailbox still on
`gmail.metadata` keeps working without bodies. The app is Internal to the Workspace, so Google's
verification and security assessment do not apply. The code stays narrower than the scope:
- the fetch guard keeps OS-19's calls (`history.list`, `getProfile`, metadata `messages.get`) and
  adds only `messages.get` with `format=full` for a message ID that OS-19 classified `reply`;
  never for `owner_reply`, `auto_reply`, `bounce` or an unmatched message, and never
  `messages.list`, `q`, `threads.get` with bodies or attachment downloads. A test proves no other
  Gmail path is called;
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

**IE-30. Consent and privacy for outreach replies.** Prospects did not opt in to the campaign;
they chose to answer it. The hub keeps a reply only to let the business answer that person:
- A `provider = gmail` row is visible only in a member session with `inbox.drafts` of that
  tenant (IE-24).
- It never reaches MCP (`get_thread`, `list_threads` and every other tool), an automation token,
  an Activepieces event, an export, or any prompt or model input, the follow-up agent's and the
  personal-data lane's included. The read model filters it out for every caller but a member
  session, and each prompt builder takes `provider = resend` rows only. Tests prove each path.
- It is erased by IE-35 after the retention period when never linked (open decision 3), and
  deleted with every other row of that sender when the person asks (IE-35).
- Prospects in the EU or UK wait for the GDPR review (`docs/integrations.md` open question 3);
  until then a campaign imports only prospects the owner states are outside them.
- The wider scope can technically read the whole mailbox: the two outreach mailboxes are used for
  outreach only (an operating rule the repo owner keeps), and the code limits of IE-29 hold.

### Tenancy, plans and configuration

**IE-31. Tenancy and grants.** `inbound_email_addresses`, `inbound_emails` and
`email_thread_refs` have `tenant_id`, forced RLS with the shared `tenant_scope` policy, keys and
foreign keys that include `tenant_id`, and appear in the catalog isolation test. The runtime role
(`authenticated`, which the API and the worker's runtime login both use):
- may SELECT its tenant's rows, but no lease column;
- may INSERT the IE-9 receive columns of `inbound_emails`;
- may UPDATE the settlement columns of `inbound_emails` (IE-11; the guard limits it to the one
  settle) and the link columns (`contact_id`, `review`, `linked_by`, `linked_at`; IE-25);
- may INSERT `email_thread_refs` rows of direction `in` (settle) and UPDATE their `contact_id`
  (link).
Only the service role writes addresses, the lease columns, direction `out` references (the
delivery worker, IE-6), the retention erasure, and deletes (IE-35). `inbound_email_route` returns
no row of a disabled address and nothing but the tenant and address IDs.

**IE-32. Plans.** `inbound.email.receive` and `inbound.email.settle` join PL-8's list of inbound
records a read-only tenant still runs, so mail is never lost while a plan lapses; the owner reads
it and pays to reply. Inbound mail does not count toward the tenant's "Emails a month" (PL-1),
though it uses the hub's Resend quota (IE-17). Needs a `plans.md` revision (receive in slice 1,
settle in slice 2).

**IE-33. MCP and tokens (slice 4).** `get_thread` and `list_threads` (`inbox:read`) return email
entries of `provider = resend` only; the H-10 description names inbound email text. No tool
links, rejects or reads spam, and no tool ever returns a `provider = gmail` row (IE-30). Before
slice 4 the MCP and token reads return no email entry, so slices 1 to 3 need no `hub-access.md`
change. Needs a `hub-access.md` revision ("What each read scope discloses") in slice 4.

**IE-34. Configuration the Mac sets.** API project: `INBOUND_EMAIL_DOMAIN`,
`RESEND_INBOUND_WEBHOOK_SECRET`, optional `RESEND_INBOUND_WEBHOOK_PREVIOUS_SECRET` (slice 1).
Workers project (slice 2): `INBOUND_EMAIL_WORKER`, `INBOUND_EMAIL_DATABASE_URL` (service),
`INBOUND_EMAIL_RUNTIME_DATABASE_URL` (`zs_runtime`), `RESEND_INBOUND_API_KEY` (a full-access key,
the only kind that reads received mail), `INBOUND_EMAIL_CRON_SCHEDULE` (build time), optional
`INBOUND_EMAIL_DAILY_ALERT` and `INBOUND_EMAIL_RETENTION_DAYS`; for the delivery worker (slice
3) `INBOUND_EMAIL_DOMAIN` and `INBOUND_REF_SECRET`. The worker-split test fails if the API bundle
names a worker-only one. Without `RESEND_INBOUND_WEBHOOK_SECRET` the webhook answers 404; without
`INBOUND_EMAIL_DOMAIN` the delivery worker sends no reply reference. Nothing receives until the
owner publishes the MX record.

**IE-35. The content guard, erasure and deletion.** `inbound_emails_guard` holds for every role,
the service role and the table owner included:
- The receive columns (`tenant_id`, `id`, `address_id`, `mailbox_id`, `provider`,
  `provider_email_id`, `reply_ref`, `from_address`, `sender_key`, `received_at`, `created_at`)
  never change.
- The settlement columns (`status`, `drop_reason`, `kind`, `from_name`, `subject`,
  `rfc_message_id`, `in_reply_to`, `references`, `auth`, `body_text`, `body_state`, `html_only`,
  `attachments`, `match`, `candidate_contact_ids`, `duplicate_of`, `settled_at`) change only in
  the one move from `received` to `ready` or `dropped`, once.
- The link columns (`contact_id`, `review`, `linked_by`, `linked_at`) change at that settle, by
  link (`possible_match` or `unmatched` to `linked`) and by reject (to `rejected`), and in no
  other way.
- The lease columns change only while the row is `received`.
- **The one erasure.** After settle, the only content change allowed is this update, run by the
  retention runner as the service role: `body_text`, `from_name`, `subject`, `attachments`,
  `in_reply_to` and `references` set to null, `body_state` to `erased`, `erased_at` from null to
  the injected time, nothing else changed. The guard refuses any other change to those columns,
  a second erasure, and an erasure of a `received` row. The runner erases, each run, rows older
  than `INBOUND_EMAIL_RETENTION_DAYS` (default 90, open decision 3) that are `rejected`, or were
  never bound or linked to a contact (`provider = gmail` rows included). Address, time, kind and
  links stay, so flood limits and sender threads still work.
- **Deletion.** A person's request to be erased deletes rows instead: `pnpm
  db:hosted-inbound-erase --tenant <id> --address <email>` (Mac only, service role, dry-run,
  backup and receipt per AGENTS.md) deletes every `inbound_emails` row of that sender in that
  tenant, both providers, with their `in` references. Only the service role may delete. It ships
  with slice 2, the first slice that stores text.
- No body ever enters an action payload, an action result, an outbox event or a log, so erasing
  the row erases the text (IE-9, IE-11).

## Data model

One migration per slice that needs one, `supabase/migrations/<timestamp>_inbound_email*.sql`.
Times are `timestamptz` set from the injected clock.

| Table | Columns | Constraints |
|---|---|---|
| `inbound_email_addresses` (slice 1) | `tenant_id`, `id`, `handle`, `kind`, `status`, `created_at`, `retire_after`, `disabled_at` | PK (`tenant_id`, `id`); unique `handle` across tenants, `^[a-z2-7]{16}$`; `kind` in `reply`; `status` in `active`, `retiring`, `disabled`; one active `reply` per tenant (partial unique); `retire_after` set exactly when `retiring`; `disabled_at` set exactly when `disabled` |
| `inbound_emails` (slice 1) | `tenant_id`, `id`, `address_id`, `mailbox_id`, `provider`, `provider_email_id`, `reply_ref`, `status`, `drop_reason`, `kind`, `from_address`, `from_name`, `subject`, `received_at`, `rfc_message_id`, `in_reply_to`, `references` (text[]), `auth`, `body_text`, `body_state`, `html_only`, `attachments` (jsonb), `contact_id`, `match`, `review`, `candidate_contact_ids` (uuid[]), `sender_key`, `duplicate_of`, `lease_token`, `lease_expires_at`, `attempts`, `next_attempt_at`, `created_at`, `settled_at`, `linked_by`, `linked_at`, `erased_at` | PK (`tenant_id`, `id`); unique (`tenant_id`, `provider`, `provider_email_id`); FK (`tenant_id`, `address_id`), (`tenant_id`, `mailbox_id`) to `outreach_mailboxes` (slice 6), (`tenant_id`, `contact_id`) and (`tenant_id`, `duplicate_of`); `provider` in `resend`, `gmail`; `address_id` set exactly when `resend`, `mailbox_id` exactly when `gmail`; `status` in `received`, `ready`, `dropped`; `drop_reason` in `bounce`, `loop`, set exactly when dropped; `kind` in `message`, `automated`, `spam`, `unclassified`, not null; `auth` in `pass`, `fail`, `none`; `body_state` in `none`, `full`, `truncated`, `too_large`, `over_limit`, `over_quota`, `unavailable`, `erased`; `match` in `header`, `reply_ref`, `address`, `linked`, `none`; `review` in `matched`, `possible_match`, `unmatched`, `linked`, `rejected`; `contact_id` set exactly when `matched` or `linked`; `erased_at` set exactly when `body_state = erased`; lengths of IE-12; `inbound_emails_guard` (IE-35); indexes (`tenant_id`, `contact_id`, `received_at`), (`tenant_id`, `sender_key`, `received_at`), (`tenant_id`, `from_address`, `received_at`), (`tenant_id`, `rfc_message_id`) not unique |
| `email_thread_refs` (slice 3) | `tenant_id`, `id`, `direction`, `rfc_message_id`, `reply_ref`, `delivery_id`, `inbound_email_id`, `contact_id`, `counterpart_address`, `created_at` | PK (`tenant_id`, `id`); unique (`tenant_id`, `rfc_message_id`) where set; unique (`tenant_id`, `reply_ref`) where set; `direction` `out` has `delivery_id` and `reply_ref` and no `rfc_message_id`, `in` has `inbound_email_id` and `rfc_message_id`; FKs include `tenant_id` |

Also: `inbound_email_route(handle)` (IE-3); the tenant-insert trigger and backfill (IE-2); the
`inbound.email.*` and `inbox.email.*` action types; `email-inbound:` in
`SERVER_IDEMPOTENCY_PREFIXES`.

## Security and isolation

- The tenant comes only from a hub-issued handle in `to`, `cc` or `bcc` (IE-3). Every lookup
  after that is in the tenant's scope under the runtime role or names `tenant_id` under the
  service role.
- Signatures are checked before any parse or database work (IE-8). The inbound endpoint has its
  own secret.
- The full-access provider key lives only in the workers project (IE-10, IE-34). It can manage
  every Resend resource, so it is set nowhere else, and the worker calls only the retrieve
  endpoint (a fetch guard and a test prove it).
- Every action, settle included, runs through the dispatcher under the runtime role; the service
  role only leases, erases and deletes (IE-10, IE-31, IE-35).
- No body, address or subject of unrouted mail is stored or logged (IE-4). Logs for routed mail
  carry IDs and reasons, never text. No action payload, result or event holds text.
- Sender-controlled data (From, headers, references, body) can at most put a message in the
  routed tenant's review queue; it can never bind to a contact without the reference or
  authentication (IE-20), change CRM data (IE-23), write a suppression (IE-15) or start an action
  (IE-18).
- Text is sanitised and shown as text (IE-13); attachments are not fetched (IE-14).
- Outreach reply text reaches no model, MCP tool, token or flow (IE-30).
- The hub never sends mail by itself in answer to inbound mail (IE-16).

## Tests required

Real Postgres under `zs_runtime` unless named otherwise; a fake inbound provider over a stubbed
`fetch`; injected clock; no real provider call. The slice that first needs each test is in
brackets.

1. Two-tenant denial [1, extended in 2 and 3]: the catalog test covers each table as it lands;
   tenant B's runtime session reads, inserts, updates, settles and links nothing of tenant A's,
   including by passing A's IDs, sender keys or handles; `inbound_email_route` returns nothing
   for a disabled handle and a row for a retiring one.
2. Cross-tenant injection [3]: a message to A's handle that carries B's reply reference, an
   `In-Reply-To` of B's `Message-ID` and a From of B's contact lands in A as `unmatched`, and B's
   tables do not change.
3. Unrouted mail [1]: an unknown handle, a disabled handle, a malformed local part and a hub
   address only in `received_for` each answer 200 and leave no row and no log line with an
   address or subject.
4. Webhook verification [1]: missing, stale, forged and previous-secret signatures; 413 over
   256 KiB; 400 for a signed non-JSON body and for an unreadable `email.received`.
5. Idempotency [1, settle in 2]: the same webhook twice, two different `svix-id`s for one
   `email_id` and two concurrent deliveries each give one row and one outbox event; the active
   and the retiring handle of one tenant in one message give one action; a settle repeated after
   a lost answer replays and writes no second event; a settle with the same key and other content
   is refused.
6. State plus outbox [1, settle in 2]: a failure injected after the row insert in receive, and
   after the update in settle, leaves neither the row change nor the event.
7. Matching [3]: a reference hit with From equal to the pinned recipient binds with `auth`
   `none` and `pass`, and is `spam` and unbound with `fail`; a header hit binds with `auth =
   pass` and is `possible_match` with `none`; address-only binds with `pass` and is
   `possible_match` with `none`; no contact is `unmatched` in `e_<senderKey>`; a reference older
   than 180 days does not bind; an `unclassified` row never binds.
8. Leaked reference [3]: a valid reference with a From that is not the pinned recipient is
   `possible_match` with that contact as a candidate; the same reference with From forged to the
   pinned recipient and `authentication.dmarc = fail` is `spam` and unbound; with `gray` it binds
   and the entry reads "sender not verified" (the Known limit, pinned by this test).
9. Authentication [2]: `pass`, `fail`, `gray`, `unknown`, `processing_failed`, a null object and a
   missing field map as IE-13; a forged `Authentication-Results: dmarc=pass` header changes
   nothing.
10. Routing fixtures [1]: a handle in `to`, in `cc` and in `bcc` routes; a forged `To` naming
    tenant B's handle in mail to tenant A's handle routes to both tenants, each in its own scope,
    and B's row is in a sender thread; a forwarded message with the handle only in
    `received_for` is unrouted and counted.
11. Safety [2]: HTML-only, hidden HTML text, bidi overrides, control characters, a
    21,000-character text, a 3 MiB answer cut at 2 MiB while streaming, `html_format=cid` on every
    retrieve, `raw.download_url` and attachments never fetched; bounce and loop are dropped and
    write no suppression; out-of-office is `automated` and sets no `needsReply`; the flood,
    admission and account limits; a 403 `email_above_quota` settles `over_quota` at once; a
    `Message-ID` that collides with another sender's is kept unused and the settle succeeds; the
    same `Message-ID` and From twice is one shown message.
12. Prompt injection (IE-18) [2]: instruction-like text changes no routing, match, kind or action;
    the prompt builder puts inbound text only inside the data block.
13. Sender [3 for Reply-To, 4 for From]: the first attempt stores Reply-To with the reference
    (and, in slice 4, From with the business name), a resend replays the same bytes, and the
    reference row is written once; a tenant without an address falls back to `RESEND_REPLY_TO`.
14. Inbox reads [1, extended in 3]: a sender thread shows metadata-only entries with
    `needsReview`; a customer thread mixes requests, replies and emails in order; `needsReply`
    as IE-24; link moves a sender's mail into the customer's thread; MCP and token reads return
    no email entry before slice 4.
15. Plans [1, settle in 2]: a read-only tenant still receives and settles.
16. Follow-up [3]: a bound customer email after an inquiry skips it `customer_wrote`; an
    out-of-office or `unclassified` one does not; sending an agent draft older than the
    customer's email is 409 through the reply route and through the generic approve; a settle and
    a send racing on one contact never let the send miss a committed email.
17. Erasure [2]: the retention runner erases exactly the IE-35 columns once; every other update to
    a settled row's content, a second erasure and an erasure of a `received` row fail for the
    service role and the table owner; the erase script deletes one sender's rows of one tenant
    and nothing else.
18. Outreach privacy [6]: a `provider = gmail` row is absent from MCP, token reads, Activepieces
    events and every prompt builder, and visible to a member with `inbox.drafts` only; the Gmail
    fetch guard allows OS-19's calls and `format=full` for a `reply` only.
19. Acceptance [3]: an owner approves a reply; the delivery goes with the reply address; the fake
    provider posts the customer's reply; the worker fetches it; it shows in that customer's
    thread with `needsReply`; the follow-up agent then skips that inquiry; tenant B sees nothing.

## First slice (one PR)

**Slice 1: receive, dark.** The migration for `inbound_email_addresses` and `inbound_emails` with
the guard (IE-2, IE-35 except the erasure runner and the erase script, IE-31 for these two
tables), `inbound_email_route`, the backfill and tenant-insert trigger;
`POST /webhooks/resend/inbound` (IE-8); routing on `to`, `cc` and `bcc` (IE-3, IE-4);
`inbound.email.receive` (IE-9) and its PL-8 entry; the admission cap (IE-17, first point); and
the `inbox-home.md` revision 5 for sender threads only: a metadata-only `email` entry (sender,
subject, time, content pending) in `e_<senderKey>` with `needsReview`, for member sessions; MCP
and token reads return no email entry. Configuration: `INBOUND_EMAIL_DOMAIN` and the webhook
secrets on the API project only. Tests 1, 3, 4, 5, 6, 10, 14 and 15 for receive.

Not in it: no worker, no Resend key, no body, no matching, no customer thread, and no change to
the outbound send request (no From, no Reply-To, no R-4 or D-8 revision). It ships dark: no hub
email names the address and the dashboard does not show it, so no customer writes there; the
Mac may publish MX on the inbound domain for a smoke test with its own mail.

**Why this order and not referenced replies first.** Referenced replies into customer threads
need, together, the live send change (Reply-To, R-4, D-8), the full-access key and the content
worker, sanitising, authentication, matching, the settle write path and the follow-up stop. That
is the riskiest bundle, and it would be the first slice to touch a working send path. Built this
way, slices 1 and 2 add the receiving path and its guards with no customer able to reach it and
nothing outbound changed, and slice 3 then only connects proven pieces. The cost is that customers
see nothing until slice 3; nothing is lost meanwhile, because nothing yet points them at the
address.

Order of the rest, one PR each:
2. **Content, dark.** The worker with both database logins (IE-10), retrieve with
   `html_format=cid` and the stream cap, sanitising and the sender name (IE-12, IE-13), the
   authentication mapping, kinds including `unclassified` (IE-15), content and account limits and
   the quota handling (IE-17), settle (IE-11) and its PL-8 entry, the spam filter, retention
   erasure and the erase script (IE-35), IE-18. Text shows in sender threads only. Tests 5, 6, 9,
   11, 12, 15 and 17.
3. **Replies reach the customer's thread, with the follow-up stop.** Reply-To with the reference
   (IE-6, the R-4 and D-8 revisions), `email_thread_refs`, matching and binding (IE-19, IE-20),
   link (IE-25), customer threads and `needsReply` (IE-24), and the follow-up change in the same
   PR (IE-27, `agents.md` revision 5, `inbox-home.md` I-6), because this is the first slice in
   which a customer's email appears in their thread. The dashboard shows the address from here.
   Tests 2, 7, 8, 13, 16 and 19.
4. Answering in the email thread (IE-26), the From name (IE-5, open decision 2),
   `inbox.email.reject`, MCP and token reads of `provider = resend` email entries (IE-33,
   `hub-access.md` revision), and `message.received` for email in Activepieces (its own revision).
5. Attachments storage (IE-14 second half).
6. Outreach reply bodies and prospects who write to the hub (IE-28..IE-30, test 18), after the
   owner approves the scope change.
7. Forwarding addresses (`kind = forwarding`), with Gmail's forwarding confirmation code shown to
   the owner. Forwarded mail names the business's own address in `to`, not the hub's, so this
   slice first settles a routing source that is not sender-written (IE-3) and needs a revision of
   this file.
Later, each with its own revision: From on a tenant's verified domain (IE-7), owner
notifications, mailbox OAuth (decision 1 B), recording our own `Message-ID` from `email.sent`
(IE-19).

## Built, and left out

Nothing is built. Left out of this contract on purpose:
- Mailbox OAuth for Gmail or Microsoft: verification cost, privacy, and the owner's approval of
  a new connection (decision 1).
- HTML rendering, clickable links and attachment previews: text only until a sanitising
  renderer has its own review.
- Automatic contact creation from email: anonymous input never makes CRM records (P-7).
- Suppressions from inbound bounces: only signed provider events write them (R-8).
- Replies sent from the hub through an outreach Gmail mailbox.
- Routing on `received_for` or any other header-derived recipient (IE-3).
- Deleting the provider's copy of a message: waits on what the provider supports.

## Known limits

- A customer whose mail client ignores Reply-To writes to the shared sender and is not seen.
- A reply that arrives after a send committed and before it is delivered does not stop that
  delivery.
- A leaked reference (the customer forwards our mail with its reply address) plus a From forged
  to the customer's address binds when the customer's domain has no enforced DMARC policy
  (`dmarc = gray`). The entry then reads "sender not verified", and the owner should check before
  acting on it (test 8 pins this). The reference expires after 180 days.
- DMARC proves the domain, not the mailbox: another user of the customer's own domain can pass as
  the customer.
- A new email from a known customer whose domain does not pass DMARC is a `possible_match` until
  the owner links it.
- A customer who writes from another address (an alias, a work address) is a new sender until
  linked.
- A blind copy to the hub address routes only if Resend lists it in `bcc` (unverified); without
  it the message is unrouted and counted.
- Mail over the admission cap (2,000 a tenant a day) is not stored. Mail received while the
  account is over quota keeps sender and subject only.
- Received mail uses the same Resend quota as sending; a flood can stop outbound mail until the
  operator acts (IE-17).
- The provider keeps its own copy of each message for a time the provider sets.

## Open decisions (need the repo owner)

1. **DNS, key and cost.** Publish MX (and the provider's records) for `reply.zerosumsolutions.com`;
   create a full-access Resend key for the workers project only (no narrower key can read received
   mail, and this one can also change domains, keys and webhooks); and choose a plan with room for
   received mail, which counts one for one against the same daily and monthly quota as sending,
   and past which received mail cannot be read (403). The Free plan's 100 a day covers both, so
   one flood would stop outbound mail: recommended is a paid plan without a daily quota before MX
   goes live (`docs/integrations.md` open question 4). Unverified and checked in slice 1 or 2:
   blind copies in `bcc`, one or several `email_id`s per message, size and rate limits, and how
   long Resend keeps received mail.
2. **From name.** The business name alone (recommended; how booking tools usually send) or
   "<business> via ZS Hub" (plainer about the shared sender, lower impersonation risk on a shared
   domain).
3. **Retention.** How long text of unlinked or rejected mail and of outreach replies is kept
   (recommended: 90 days; then text, sender name, subject and attachment names are erased, and
   the address, time and kind stay).
4. **Outreach scope and the public address.** Approve `gmail.readonly` on the two outreach
   mailboxes (IE-29) or keep metadata only; and whether owners may publish the hub address as a
   public "email us" address from slice 3 (recommended yes, with rotation), which invites some
   spam into the Inbox's spam filter.
