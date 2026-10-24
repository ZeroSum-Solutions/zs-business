# M3d: prepaid wallet and message delivery

Status: draft contract for M3d (2026-10-20), revision 5 (2026-10-22). Code follows this file;
a change to a numbered rule needs a new revision of this file first. Revision 5 changes D-6 and
D-9 so a one-click unsubscribe stops marketing email only, and adds D-11 (wallet reservations
for any priced job). D-11 is built (migration `20261023300000_wallet_job_reservations.sql`,
`packages/core/src/wallet/index.ts`); the D-6 and D-9 change is not. Only `message_delivery` has
a registered job table (`DEFAULT_JOB_REGISTRY`): another kind's reservation is refused
`job_kind_unavailable` until its contract adds its table there. Today the one-click POST
records reason `unsubscribe` (`packages/core/src/edge/delivery-session.ts:63`), and any
suppression row blocks every purpose (`packages/core/src/delivery/worker.ts:325-331`,
`policy.ts:75`).

Scope: how an approved outbound message (an Inbox reply today, agent messages later) becomes
exactly one provider send, paid from the tenant's prepaid wallet, and how a recipient stops
messages. Real providers arrive with M5; until then the only adapter is an in-memory fake
behind the provider port, and nothing is sent to anyone. Top-ups (Stripe) arrive with M5;
until then credits are a service-role call.

## Evidence and decisions

- Plan (approved 2026-10-18), checkpoint M3d, and the M3 done criteria: wallet concurrency,
  delivery crash and dedupe, consent re-check and suppression tests.
- Audit note N4 (`packages/db/test/outbox-order.test.ts`): outbox `seq` is not commit order,
  so consumers select unprocessed rows by per-row state and claim work with leases.
- Consent evidence: `crm.md` C-7..C-11 and `public-intake.md` P-8 (`crm_contact_consent`).
- Approval: M3b owns the approval record. Delivery re-checks it through a narrow port
  (D-6) and does not read approval tables itself.
- Provider behaviour (studied from public API docs, in our own words): providers accept an
  idempotency key and drop a repeat of the same key for a limited window (about a day for
  common email APIs). A repeat after the window may send again.
- Marketing one-click unsubscribe stops marketing email only and keeps transactional (booking)
  email; D-6 and D-9 change to match; decided 2026-10-22 (coordinator, standing approval).
  Mailbox-provider bulk-sender rules and CAN-SPAM ask for a working unsubscribe on marketing
  mail, not on booking notices. Bounces, complaints, manual suppressions and SMS `STOP` still
  block every purpose: the first three mean the address is unsafe or the owner said no, and
  carriers enforce `STOP` for every message.
- A recorded consent denial is not used for the marketing opt-out: consent is per contact and
  a denial blocks every purpose (D-6), while an unsubscribe names one address.
- Wallet reservations cover any priced job (enrichment call, image job, voice minutes, browser
  run), not only message deliveries: D-11 (`docs/integrations.md`, "Wallet spend beyond
  messages"). Other contracts (`enrichment.md`, `image-port.md`, `voice-receptionist.md`)
  cite D-11 by number.

## Numbered rules

**D-1. The event.** A producer asks for a send by committing an outbox event of type
`message.send_requested` in its action transaction. The payload (`messageSendRequestedSchema`)
names the message, the contact, the channel (`email` or `sms`), the purpose
(`transactional` or `marketing`) and the approved content (email subject and body, or SMS
body). It never carries an address: the worker resolves the contact's current address at
delivery time. It names no approval: the delivery keeps the outbox row's `action_id`, and the
approval of that action is what D-6 re-checks. The Inbox (M3c) emits this event when an
owner approves a reply; M6 agents will too.

**D-2. Ingest by row state.** The worker moves events into `message_deliveries` by selecting
outbox rows of that type whose `processed_at` is null (`FOR UPDATE SKIP LOCKED`), inserting
one delivery each and setting `processed_at`, in one transaction. A delivery is unique per
outbox row and per message, so a repeated event for the same message never becomes a second
send. A payload that fails the schema, or that the database refuses as bad data or a
constraint breach (SQLSTATE classes 22 and 23), is marked processed and reported; the outbox row
stays as the record. Any other database error (a timeout, a deadlock, a lost connection) leaves
the event unprocessed for a later pass.

**D-3. Leases.** A worker claims deliveries that are due (`pending` or `uncertain` with
`next_attempt_at` reached) or whose lease expired, by setting `status = leased`, a fresh
lease token, an owner and an expiry, under `FOR UPDATE SKIP LOCKED`. Every later write for
that delivery checks the token; a worker that lost its lease writes nothing. Time comes from
the injected clock, never from SQL `now()`.

**D-4. Wallet.** One wallet per tenant holds `balance` and `reserved` in integer minor units.
Constraints keep `balance >= 0`, `reserved >= 0` and `reserved <= balance`, so the wallet can
never go negative. Every balance change is an append-only ledger row with a unique
idempotency key (credits, captures); runtime roles cannot write any wallet table and the
service role cannot update or delete ledger rows.

**D-5. Reserve before spend.** Before the provider call the worker reserves the send's price
with one conditional update (`available >= price`) on the wallet row, which serializes
concurrent reservations, so concurrent reservations can never overdraw. A price in another currency than the wallet's
is never covered. Without funds the
delivery waits with backoff and counts an attempt, and after the attempt cap it is a dead
letter `insufficient_funds`. A definite failure releases the reservation; acceptance
captures it.

**D-6. Re-check at delivery.** In the transaction that reserves and starts an attempt, the
worker re-checks, for every attempt:
- suppression of the channel and address (D-9): blocked `suppressed`;
- the contact's consent for the channel: `denied` blocks `consent_denied`; marketing, and
  every SMS, needs `granted`, or it blocks `consent_missing`; a transactional email needs no
  recorded grant. For a `marketing` delivery, a grant whose source starts with
  `twilio-voice:` (`twilio.md` T-12, a caller asking for one booking-link text) does not count
  and blocks `consent_missing` (revision 5);
- the approval of the action that committed the event, through `DeliveryApprovals.check(tx,
  { tenantId, actionId, messageId, contentDigest })`, which must answer `approved`, or it
  blocks `approval_revoked` or `approval_missing`. `approvalsFromRecords` implements the port
  over M3b's `approvalForAction` (approvals.md A-10): a direct approval stands; a stored one
  stands only while `approved`; revoked, expired and rejected block `approval_revoked`;
- a usable address (`no_address`). The send goes to the contact's current address, except
  that while an outcome is unknown it may only be repeated to the address it went to; if the
  contact's address changed, the delivery blocks `address_changed` (after a lookup, D-8). A
  marketing campaign delivery (`marketing-email.md` M-6) is bound to its snapshot address on
  every attempt and blocks `address_changed` as soon as the contact's address differs
  (revision 5).
A blocked delivery sends nothing and releases its reservation. A withdrawal that commits after
an attempt has started does not stop that attempt; it stops every later one. What a suppression
blocks depends on its reason (revision 5): `marketing_unsubscribe` blocks `marketing` deliveries
only, so the person still gets booking notices and replies (`transactional`); `unsubscribe`,
`stop`, `bounce`, `complaint` and `manual` block every purpose, transactional included, until
the row is lifted. A test proves both: with a `marketing_unsubscribe` row for an address, a
marketing delivery to it blocks `suppressed` and a transactional one is sent; with a `bounce`
row, both block `suppressed`.

**D-7. Outcomes.** The provider answers one of: `accepted` (captured, `sent`), `rejected`
(permanent: released, dead letter `provider_rejected`), `failed` (this attempt was not
accepted: released and retried with backoff, unless an earlier attempt under the same key was
uncertain, in which case the outcome stays unknown and the reservation held, as for `uncertain`) or `uncertain` (timeout, lost connection, or any thrown
error: the reservation stays held, `uncertain`). A worker that crashes after starting an
attempt leaves the attempt open, and the next lease holder treats that as uncertain. Provider
adapters (M5) map "a request with this key is in flight" to `uncertain` and a failure the
provider replays for a key to `rejected`.

The producer learns the end state through an optional `onSettled(tx, tenantId, messageId,
"sent" | "failed", at)` hook, called inside the settling transaction; if it throws, the
settlement rolls back and the next lease holder settles again.

A step that throws inside the worker (a database error, a hook that keeps failing) is
reported, counted on the delivery and handed back with backoff, and the rest of the batch goes
on. At `maxStepErrors` the delivery becomes a dead letter `worker_error` that keeps any held
reservation and does not call the hook; an operator settles it like `outcome_unknown`. Error
text is stored cut to 200 characters, and an empty code is stored as `unknown`.

**D-8. Exactly-once settlement and the dedupe window.** Every send of one delivery uses the
same provider idempotency key and the same request: the first attempt stores the subject, text
and headers it sent, and every later attempt replays them, so a config change such as an
unsubscribe secret rotation never alters a resend. Every send happens before `first_attempt_at +
dedupeWindow - margin`, so the provider drops any repeat. An unknown outcome is only ever
resolved at the provider that attempt went to: if the channel's provider has changed since, the
delivery becomes a dead letter `outcome_unknown` (`provider_changed`) with the reservation held. After the window no send happens:
an uncertain delivery is resolved by `provider.lookup(key)` (accepted: captured; not found:
released, dead letter `dedupe_window_expired`) or, without an answer, becomes a dead letter
`outcome_unknown` whose reservation stays held until an operator settles it as sent or not
sent. A reservation moves from `held` to `captured` or `released` once; a partial unique
index allows one captured reservation per delivery.

A provider that drops no repeats (Twilio, `twilio.md` T-2) declares `dedupeWindowMs: 0`: its
window is closed from the first attempt, so an attempt whose outcome is unknown is never
followed by another send. Every later turn asks `provider.lookup(key, { tenantId, deliveryId })`
instead, as after any window: accepted captures (`sent`); not found releases the reservation and
ends as the check that blocked it or `dedupe_window_expired`. Unlike after a closed window, no
answer keeps the delivery `uncertain`, with backoff by the number of lookups, until
`first_attempt_at + outcomeWaitMs` (evidence such as a status callback may still arrive), and only
then is it a dead letter `outcome_unknown` with the reservation held. A send after a definite
answer (`failed`) is not limited by the window, because it cannot repeat an accepted one.

**D-9. Suppression and stop.** `suppressions` holds (channel, address) pairs that must not be
messaged, with a reason (`marketing_unsubscribe`, `unsubscribe`, `stop`, `bounce`, `complaint`,
`manual`); `marketing_unsubscribe` is valid on the email channel only. Writes go
through the dispatcher with a server-built principal per tenant, like the public intake
(P-3). One row per address keeps its first reason, except that a lasting reason (`unsubscribe`,
`bounce`, `complaint`, `manual`) replaces `stop` and `marketing_unsubscribe`, so an address that
opted out of marketing and then bounces stops getting booking email too (revision 5). Rows
recorded as `unsubscribe` before revision 5 keep that reason and keep blocking every purpose;
the migration rewrites no row. Member and MCP idempotency keys may not use the
prefixes the server builds for these actions (`public:`, `unsubscribe:`, `sms-inbound:`,
`sms-status:`, `email-feedback:`), so a
member cannot take a recipient's key first:
- Email: every email carries a `List-Unsubscribe` URL and `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (RFC 8058). The URL holds an unsubscribe token: `zsu1_` and
  64 base64url characters encoding the tenant UUID, the delivery UUID and a 16-byte
  HMAC-SHA-256 tag over `zsu1:<tenantId>:<deliveryId>`. A POST with a valid token
  suppresses the address that delivery went to with reason `marketing_unsubscribe`
  (revision 5; `unsubscribe` before it), whatever the purpose of that delivery. A GET never
  changes anything. The endpoint
  checks the token before any database work: a forged token is rate limited per caller
  address, a valid one per delivery, because one-click POSTs come from a few mailbox-provider
  servers that every recipient shares. The counts are shared by every API instance
  (public-intake.md P-10).
- SMS: an inbound message whose whole text is a stop keyword (`STOP`, `STOPALL`,
  `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `REVOKE`, `OPTOUT`, any case, surrounding
  space and punctuation ignored) suppresses the sender's number with reason `stop` and gets
  one confirmation reply. `START`, `UNSTOP` or `YES` lifts a `stop` suppression only.
  `HELP` or `INFO` gets the help reply. Every SMS carries the opt-out line.
- Email bounces and complaints: a signed provider event suppresses the address its delivery
  went to with reason `bounce` or `complaint` (`resend.md` R-8).

**D-10. Tenancy.** Every table has `tenant_id`, forced RLS and the tenant policy, and is in the
catalog isolation test. The worker runs as the service role (the outbox processing entry
point) and names `tenant_id` in every statement.

**D-11. Reservations for any priced job (revision 5).** A wallet reservation names a
job by `job_kind` and `job_id` instead of only a message delivery. The kinds are
`message_delivery`, `enrichment` (`enrichment.md` E-8), `image_job`, `voice_minutes` and
`browser_run`; a new
kind needs a revision of this file and a contract that names its job table and its price. The
rules of D-4 and D-5 hold for every kind:
- Reserve before the vendor call. `reserveForJob(tx, { tenantId, jobKind, jobId,
  reservationId, amount, currency, now })` runs in the transaction that starts the job's
  attempt, as one conditional update on the wallet row (`balance - reserved >= amount`, the
  wallet's currency, `owed = 0`). It returns null without funds, and the job then makes no
  vendor call; its own contract says whether it waits or ends `insufficient_funds`. Only the
  service role reserves (D-4).
- One hold, one capture. Partial unique indexes allow one `held` and one `captured`
  reservation per (`tenant_id`, `job_kind`, `job_id`). A reservation moves from `held` to
  `captured` or `released` once, and the capture writes one ledger row keyed
  `capture:<reservationId>` (D-4).
- Capture the real cost, release the rest. `captureReservation` takes an optional `amount` no
  larger than the held amount; it captures that amount and returns the remainder to `available`
  in the same transaction. A capture above the held amount is refused (`capture_exceeds_hold`)
  and changes nothing. A job never spends past its hold: a voice call ends or hands off before
  its reserved minutes run out, and a browser run stops at its reserved step count.
- Release on failure. A definite failure (the vendor refused, or the job was blocked before
  the call) releases the hold. An unknown outcome keeps the hold until the job's own lookup or
  an operator settles it, as D-7 and D-8 say for messages.
- Stale holds. A sweep reports `held` reservations older than 24 hours by the injected clock as
  `stale_hold`, with tenant, kind and job. It never captures or releases them itself.
Migration: `wallet_reservations` gains `job_kind` (text, checked against the list above) and
`job_id` (uuid), both backfilled from existing rows as `message_delivery` and `delivery_id`, then
`NOT NULL`. `delivery_id` stays, now nullable, with its foreign key to `message_deliveries`;
a check keeps `delivery_id` set and equal to `job_id` exactly when `job_kind =
'message_delivery'`. The two partial unique indexes move from `delivery_id` to (`job_kind`,
`job_id`). Other kinds have no foreign key: `reserveForJob` locks the job's row in its own table
under the same tenant (`FOR UPDATE`) and refuses `job_not_found` if it is absent. The delivery
worker keeps its D-5 behaviour through `reserveFunds`, which calls `reserveForJob` with kind
`message_delivery`. Tests: two concurrent reservations for different kinds can never overdraw;
a second hold for the same job is refused by the index; a partial capture returns the rest to
`available`; and a two-tenant denial test covers the new columns.

## Known limits (revision 5)

- Claims are ordered by due time across tenants, with no per-tenant fairness yet.
- Backoff has no jitter: core has no randomness source, and none is injected yet.
- Top-ups arrive with M5; `creditWallet` is the seam they call. The email provider is Resend
  (`resend.md`); the SMS provider and inbound SMS webhooks are Twilio (`twilio.md`).
- An email opt-out from a booking notice stops marketing only (D-6). A recipient who wants no
  email at all asks the business, and the owner records a `manual` suppression. A self-serve
  "stop all email" choice on the unsubscribe page is an open question.
- D-11 has no top-up of a running hold: a job that needs more than it reserved ends and starts a
  new job with a new reservation. Per-kind prices live in each kind's contract.
