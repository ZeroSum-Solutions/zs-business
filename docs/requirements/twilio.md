# M5: Twilio SMS provider

Status: draft contract for M5, provider 3 of 5 (2026-10-20), revision 1. Code follows this file;
a change to a numbered rule needs a new revision of this file first.

Scope: the SMS provider behind the M3d provider port (`delivery.md` D-7, D-8). It turns one
delivery attempt into one Twilio API call, turns Twilio's signed status callbacks into delivery
evidence, and turns inbound STOP, START and HELP texts into suppression changes and replies
(D-9). Code and tests only: the cloud holds no Twilio credentials and never calls Twilio. Tests
talk to an in-process fake HTTP server. The Mac sets the variables in T-9 when the provider
ships. Nothing in v1 produces SMS yet (Inbox replies are email); this makes the channel ready
for M6 agents and later producers.

## Evidence and decisions

- Plan (approved 2026-10-18): M5 providers one at a time; Twilio after Resend and Stripe.
- Provider behaviour (studied from Twilio's public API and webhook docs, in our own words):
  - `POST /2010-04-01/Accounts/<AccountSid>/Messages.json` with a form body (`To`, `From` or
    `MessagingServiceSid`, `Body`, optional `StatusCallback`) and HTTP Basic auth (the account
    SID and auth token, or an API key SID and secret). Success is 201 with a JSON message
    resource whose `sid` starts `SM` (or `MM`). Errors are JSON with `code`, `message`,
    `more_info` and `status`: 400 for a request Twilio will not send (21211 invalid number,
    21610 recipient opted out, 21614 not a mobile number, 21606 sender not usable…), 401 or
    403 for credentials, 404 for an unknown account path, 429 (code 20429) for rate limits,
    5xx for server errors. `Body` is at most 1600 characters.
  - The Messages API documents no idempotency key. A repeat of a request is a second message.
  - Status callbacks are form POSTs to the `StatusCallback` URL with `MessageSid`,
    `MessageStatus` (`queued`, `sending`, `sent`, `delivered`, `undelivered`, `failed`,
    `read`, …), optional `ErrorCode`, `AccountSid`, `From` and `To`. They can arrive out of
    order and more than once.
  - Inbound messages are form POSTs to the number's messaging webhook with `MessageSid`,
    `AccountSid`, `From`, `To` and `Body`. The answer may be TwiML
    (`<Response><Message>…</Message></Response>`), which Twilio sends as the reply.
  - Every webhook carries `X-Twilio-Signature`: base64 of HMAC-SHA1, keyed by the account's auth
    token, over the full URL Twilio called followed by every POST parameter name and value,
    sorted by name. There is no timestamp in the signature.
  - On standard numbers Twilio applies its own opt-out handling: it answers STOP, START and
    HELP itself, still forwards the inbound text to the webhook, and refuses later sends to an
    opted-out number with error 21610.
- Carrier rules (CTIA messaging principles, in our own words): a STOP gets exactly one
  confirmation and then nothing more; HELP gets the sender's name and how to opt out; replies
  name the business.

## Numbered rules

**T-1. The adapter.** `createTwilioProvider({ config, senderFor, findStatus, fetch })`
implements `DeliveryProvider` for the SMS channel. Config, the sender lookup, the status lookup
and fetch are injected; the adapter reads no environment and no clock. Its `name` (default
`twilio`) is what the worker records as the delivery's `provider`. It refuses an email request
as `rejected`.

**T-2. No provider dedupe.** Twilio drops no repeat, so the adapter declares
`dedupeWindowMs: 0` and the worker never sends again after an attempt whose outcome is unknown
(`delivery.md` D-8, revision 4). An unknown outcome is settled by evidence instead (T-5), and
waits for it at most `outcomeWaitMs` (default 24 hours) after the first attempt; after that it
is a dead letter `outcome_unknown` with the reservation held for an operator. A definite
refusal (`failed`) proves nothing was sent, so that send is retried as usual.

**T-3. What is sent.** `To` is the one pinned recipient in E.164. `From` is the tenant's own
number (`sms_numbers`, T-7), looked up through `senderFor(tenantId)` at each send; a tenant
without a number is refused as `rejected` (`twilio_no_sender`) before any call. `Body` is the
stored text (it already ends with the opt-out line, D-9), at most 1600 characters.
`StatusCallback` is `<TWILIO_WEBHOOK_BASE_URL>/webhooks/twilio/status/<tenantId>/<deliveryId>`.
The adapter refuses (`rejected`, nothing sent) a recipient that is not E.164, an empty or
over-long body, a body or sender with NUL, and ids that are not UUIDs.

**T-4. Outcomes.** One HTTP answer maps to one D-7 outcome:
- 2xx with a readable `sid`: `accepted`. 2xx without one: `uncertain`.
- 400, 413, 422: `rejected` (the same request cannot succeed).
- 429 and every other 4xx (401, 403, 404, …): `failed`. Twilio refused before creating a
  message, so the reservation is released and the worker retries with backoff.
- 5xx, 3xx and anything else: `uncertain`. Redirects are not followed.
- A connection that never opened (refused, DNS failure, unreachable): `failed`. A timeout, a
  reset or any other network error after that: `uncertain`.
Codes are `twilio_<status>_<code>` (Twilio's numeric error code when the body has one), or
`twilio_timeout`, `twilio_connect_<errno>`, `twilio_network[_<errno>]`. Response bodies are
read up to 64 KiB.

**T-5. Status evidence and lookup.** A signed status callback (T-6) is recorded as evidence
in `sms_status_events`, one row per message SID and status. The adapter's `lookup` asks
`findStatus(tenantId, deliveryId)`: any recorded status proves Twilio created the message, so
the answer is `accepted` with that SID; no evidence is `unknown`, never `not_found`, because a
callback can be late or lost. The worker settles the uncertain delivery from that answer, once
(captured, `sent`).

**T-6. Webhook verification.** `POST /webhooks/twilio/status/<tenantId>/<deliveryId>` and
`POST /webhooks/twilio/inbound/<tenantId>` check, before any database work: a form body of at
most 64 KiB, an `X-Twilio-Signature` equal (constant time) to the HMAC by the current or
previous auth token over `<TWILIO_WEBHOOK_BASE_URL><path and query as received>` and the sorted
parameters, and an `AccountSid` equal to the configured account. The URL is rebuilt from the
configured base, never from the `Host` header. Any failure is 401 with one fixed body. The tenant
and delivery come from the signed URL and are checked under that tenant's scope (runtime role,
RLS). Signatures carry no timestamp, so a replayed callback is made harmless by idempotency
keys, not by age.
- Status: the delivery must exist, be SMS, have `provider` equal to the adapter's name and a
  pinned recipient equal to `To`; a recorded `provider_message_id` must equal `MessageSid`.
  Anything else is acknowledged (200) and changes nothing. The record goes through the
  dispatcher with a server-built principal (`smsStatusActorId`) that may run
  `sms.status.record` and `suppression.record` only, keyed `sms-status:<MessageSid>:<status>`, so
  a redelivered callback replays. Error 21610 (the recipient opted out at Twilio) also records a
  `stop` suppression for `To`, keyed `sms-status:<MessageSid>:stop`.
- Inbound: `To` must be the tenant's number in `sms_numbers`; otherwise 200 with an empty
  `<Response/>` and no change. A text that is exactly a keyword (D-9) goes to the inbound SMS
  session (`createInboundSmsSession`), keyed `sms-inbound:<MessageSid>`. Other texts change
  nothing yet.
Database errors answer 503, so Twilio retries. That includes a lock wait, serialization failure,
deadlock or statement timeout (55P03, 40001, 40P01, 57014) that the dispatcher reports as a
conflict: a 409 would end Twilio's retries and lose the status or the STOP.

**T-7. Numbers.** `sms_numbers` maps one E.164 number to one tenant (unique across tenants),
with an optional `help_reply` text. Only the service role writes it (`pnpm --filter @zs/api
sms:number`, run by an operator); the runtime role reads its own tenant's row.

**T-8. Keyword replies.** `TWILIO_KEYWORD_REPLIES` chooses who answers STOP, START and HELP:
- `provider` (default): Twilio's own opt-out handling answers, and the webhook answers with an
  empty `<Response/>`, so the recipient never gets two replies. The Mac sets the replies (with
  the business name) in the Messaging Service's opt-out settings.
- `app`: the webhook answers with TwiML, for numbers where Twilio's own replies are off. STOP:
  `<name>: You are unsubscribed and will get no more messages. Reply START to resubscribe.`
  START (only when no other reason keeps the number suppressed): `<name>: You are resubscribed.
  Reply STOP to opt out.` HELP: the number's `help_reply`, or `<name>: Reply STOP to opt out,
  START to resubscribe. Msg & data rates may apply.` `<name>` is the tenant's name.
Either way the suppression list changes the same way (D-9). A repeat of the same inbound
message replays the stored action and gets the same reply.

**T-9. Configuration the Mac sets.**
- Runner (delivery function or Node worker): `SMS_PROVIDER=twilio` (anything else keeps SMS
  refused as `sms_provider_not_configured`), `TWILIO_ACCOUNT_SID`, and either
  `TWILIO_API_KEY_SID` with `TWILIO_API_KEY_SECRET` or `TWILIO_AUTH_TOKEN`,
  `TWILIO_WEBHOOK_BASE_URL` (the API's public https origin), optional `TWILIO_BASE_URL` (https,
  or http on loopback only) and `TWILIO_OUTCOME_WAIT_MS`.
- API function: `TWILIO_AUTH_TOKEN` turns the two webhook routes on (unset: they answer 404),
  with `TWILIO_ACCOUNT_SID`, `TWILIO_WEBHOOK_BASE_URL`, optional
  `TWILIO_PREVIOUS_AUTH_TOKEN` during a rotation and `TWILIO_KEYWORD_REPLIES`.
- In Twilio: each tenant's number gets the messaging webhook
  `<TWILIO_WEBHOOK_BASE_URL>/webhooks/twilio/inbound/<tenantId>` (POST), and a row in
  `sms_numbers`. The number must be registered for A2P 10DLC (or be a verified toll-free
  number) before carriers deliver its messages.

## Known limits (revision 1)

- One number per tenant; no Messaging Service pools or short codes yet.
- An outcome with no callback inside the wait is a dead letter for an operator, who checks
  Twilio's message log and settles it (D-8).
- A `failed` or `undelivered` carrier status after acceptance keeps the charge captured.
- Inbound texts other than keywords are not stored; SMS threads in the Inbox come later.
- Twilio signatures have no timestamp; replays are absorbed by idempotency keys.
