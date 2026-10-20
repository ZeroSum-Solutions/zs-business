# M3d: prepaid wallet and message delivery

Status: draft contract for M3d (2026-10-20), revision 3. Code follows this file; a change to
a numbered rule needs a new revision of this file first.

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
send. A payload that fails the schema is marked processed and reported; the outbox row stays
as the record.

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
  recorded grant;
- the approval of the action that committed the event, through `DeliveryApprovals.check(tx,
  { tenantId, actionId, messageId, contentDigest })`, which must answer `approved`, or it
  blocks `approval_revoked` or `approval_missing`. `approvalsFromRecords` implements the port
  over M3b's `approvalForAction` (approvals.md A-10): a direct approval stands; a stored one
  stands only while `approved`; revoked, expired and rejected block `approval_revoked`;
- a usable address (`no_address`).
A blocked delivery sends nothing and releases its reservation. A withdrawal that commits after
an attempt has started does not stop that attempt; it stops every later one. Suppression
blocks every purpose, transactional included: a person who opted out hears nothing more until
they opt back in.

**D-7. Outcomes.** The provider answers one of: `accepted` (captured, `sent`), `rejected`
(permanent: released, dead letter `provider_rejected`), `failed` (definitely not accepted:
released, retried with backoff) or `uncertain` (timeout, lost connection, or any thrown
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

**D-9. Suppression and stop.** `suppressions` holds (channel, address) pairs that must not be
messaged, with a reason (`unsubscribe`, `stop`, `bounce`, `complaint`, `manual`). Writes go
through the dispatcher with a server-built principal per tenant, like the public intake
(P-3). One row per address keeps its first reason, except that a lasting reason (`unsubscribe`,
`bounce`, `complaint`, `manual`) replaces `stop`. Member and MCP idempotency keys may not use the
prefixes the server builds for these actions (`public:`, `unsubscribe:`, `sms-inbound:`,
`email-feedback:`), so a
member cannot take a recipient's key first:
- Email: every email carries a `List-Unsubscribe` URL and `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (RFC 8058). The URL holds an unsubscribe token: `zsu1_` and
  64 base64url characters encoding the tenant UUID, the delivery UUID and a 16-byte
  HMAC-SHA-256 tag over `zsu1:<tenantId>:<deliveryId>`. A POST with a valid token
  suppresses the address that delivery went to. A GET never changes anything. The endpoint
  checks the token before any database work: a forged token is rate limited per caller
  address, a valid one per delivery, because one-click POSTs come from a few mailbox-provider
  servers that every recipient shares.
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

## Known limits (revision 3)

- Claims are ordered by due time across tenants, with no per-tenant fairness yet.
- Backoff has no jitter: core has no randomness source, and none is injected yet.
- Top-ups, the SMS provider and inbound SMS webhooks arrive with M5. The email provider is
  Resend (`resend.md`). `creditWallet` and `createInboundSmsSession` are the seams they will
  call.
