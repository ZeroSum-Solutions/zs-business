# M5: Twilio SMS provider

Status: draft contract for M5, provider 3 of 5 (2026-10-20), revision 3 (2026-10-22). Revision 2
(audit 2026-10-22): T-8 stored replies. Revision 3 adds missed-call text-back, T-10..T-14: a
signed voice webhook for the tenant's number, a press-1 offer after an unanswered call, the
consent and text that follow, voicemail into the Inbox, and limits and replays. T-1..T-9 are
unchanged. T-10..T-14 are not built yet. Code follows this file; a change to a numbered rule
needs a new revision of this file first.

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
- Missed-call text-back (revision 3) is step 3 of the build order in `docs/integrations.md`:
  it costs no model spend and measures call volume before any voice AI
  (`voice-receptionist.md` V-1 waits for it).
- Voice behaviour (studied from Twilio's public voice webhook and TwiML docs, in our own words):
  - A call to a number makes a form POST to the number's voice URL with `CallSid` (`CA` and 32
    hex characters), `AccountSid`, `From`, `To`, `CallStatus` and `Direction`. A withheld
    caller ID arrives as a value that is not E.164 (for example `anonymous`). The answer is
    TwiML. The same `X-Twilio-Signature` scheme as for messaging signs it (T-6).
  - `<Dial timeout="n" action="url">` rings another number; when that leg ends, Twilio POSTs
    the action URL with `DialCallStatus` (`completed`, `busy`, `no-answer`, `failed`,
    `canceled`) and runs the TwiML it gets back.
  - `<Gather input="dtmf" numDigits="1" action="url">` with a nested `<Say>` POSTs `Digits` to
    the action URL when the caller presses a key. With no key before its timeout, Twilio goes
    on to the next verb in the same response.
  - `<Record action="url" recordingStatusCallback="url">` records a message;
    the status callback POSTs `RecordingSid`, `RecordingDuration`, `RecordingStatus` and
    `CallSid` once the recording is stored at Twilio. Recordings can be fetched and deleted
    through the REST API with the account credentials.
  - A voice webhook that answers 5xx or times out makes Twilio use the number's fallback URL.
  - Twilio may send a voice webhook more than once.
- Missed-call text-back needs the caller to press 1 (opt-in) before any text. `delivery.md`
  D-6 is not loosened: every SMS still needs a recorded `granted` SMS consent, checked again at
  delivery: decided 2026-10-22 (coordinator, standing approval).

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
message replays the stored action and gets the same reply: with `app`, each reply given (HELP
included) is stored through the dispatcher (`sms.reply.record`, keyed
`sms-inbound:<MessageSid>:reply`) and a repeat gets that text back, even after the business name
or `help_reply` changed.

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

**T-10. Voice webhooks.** Four routes take Twilio's voice callbacks for a tenant's number:
`POST /webhooks/twilio/voice/<tenantId>` (incoming call), `.../voice/<tenantId>/dial`,
`.../voice/<tenantId>/gather` and `.../voice/<tenantId>/recording`. Each checks, before any
database work, the same things as T-6: a form body of at most 64 KiB, a valid
`X-Twilio-Signature` over the URL rebuilt from `TWILIO_WEBHOOK_BASE_URL` (path and query as
received), and the configured `AccountSid`; any failure is 401 with one fixed body. `CallSid`
must match `^CA[0-9a-f]{32}$` (otherwise 400). The routes answer 404 while `TWILIO_AUTH_TOKEN`
is unset, as T-9 does for messaging.
- Numbers: `voice_numbers` holds, per tenant, the E.164 number (equal to the tenant's
  `sms_numbers` number, so the text comes from the number the caller rang), the
  `forward_to_e164` the call rings first, `ring_seconds` (5..45, default 20),
  `textback_enabled` (default false), the `booking_url` the text carries (an https URL, at
  most 300 characters) and `disclosure_version`. `voice_textback_disclosures` keeps every
  version with its text, append-only for every role, the table owner included, as
  `public-intake.md` P-8 does for page disclosures. Only the service role writes either table
  (`pnpm --filter @zs/api voice:number`, run by an operator).
- The incoming call: `To` must be the tenant's number, or the answer is
  `<Response><Hangup/></Response>` and nothing is stored. Otherwise the route records the call
  in `voice_calls` (T-14) and answers `<Dial timeout="<ring_seconds>"
  action=".../dial">` to `forward_to_e164`. With `textback_enabled` false the `<Dial>` has no
  action URL: a plain forward.
- Writes go through the dispatcher with a server-built principal, `voiceActorId(tenantId) =
  derivedId(tenantId, "twilio-voice", "actor")`, that may run `voice.call.record`,
  `voice.textback.optin` and `voice.voicemail.record` only, keyed
  `twilio-voice:<CallSid>:<step>`. `twilio-voice:` joins `SERVER_IDEMPOTENCY_PREFIXES`
  (`approvals.md` A-14).
- A database error answers 503, so Twilio plays the number's fallback URL: a static TwiML
  apology the operator sets in Twilio. No route ever tells a caller a text is coming unless
  the opt-in of T-12 has committed.

**T-11. The offer after an unanswered call.** The dial callback reads `DialCallStatus`:
`completed` (the business answered) and `canceled` (the caller hung up) answer `<Hangup/>`
and nothing else happens. `busy`, `no-answer` and `failed` mean the call was missed. Then the
route offers the text only when all of these hold: `textback_enabled` is true; `From` is
E.164; the caller's number has no SMS suppression (`delivery.md` D-9); the contact with that
number, if any, has no recorded SMS denial (`crm.md` C-9); and T-14's offer limits allow it.
The offer is `<Gather input="dtmf" numDigits="1" timeout="6"
action=".../gather?v=<disclosure_version>">` around a `<Say>` of the current disclosure text,
followed by the voicemail prompt and `<Record>` (T-13). The disclosure says, in the business's
name, "press 1 to get our booking link by text, or leave a message", that one text will come,
that message and data rates may apply, and that STOP opts out. Without an offer the answer is
the voicemail prompt and `<Record>` alone. The decision (`offered` true or false, and why) is
stored on the call's row, so a replayed dial callback answers the same.

**T-12. Press 1: consent, then the normal outbox.** The gather callback acts only when
`Digits` is exactly `1` and the call's row says `offered`. `From`, `To` and the version come
from the stored row and the signed `v`, never from other parameters. One `voice.textback.optin`
transaction, keyed `twilio-voice:<CallSid>:optin`:
- finds the contact with the caller's number, or creates a phone-only one
  (`createOrFindContact`, `crm.md` C-5, C-6);
- inserts one `voice_textback_consents` row (unique per call): `call_sid`, `contact_id`,
  `caller_e164`, `disclosure_version`, the exact `disclosure_text` of that version (the words
  the caller heard), and the transaction time; the table is append-only like the disclosures;
- fills the contact's SMS consent only when it has no record (C-10 semantics): status
  `granted`, source `twilio-voice:<CallSid>`. A recorded grant stays as it is. A recorded
  denial is never replaced; then no
  event is written and the call goes to voicemail;
- commits one `message.send_requested` event (`delivery.md` D-1): channel `sms`, purpose
  `transactional`, the message id derived from tenant and `CallSid`, and the body
  `<name>: Book here: <booking_url> Reply STOP to opt out.` (the opt-out line, D-9). The
  server approves exactly this command, as `public-intake.md` P-3 does, so D-6 finds a direct
  approval.
The worker then treats it like any send: D-1..D-9 apply as written (this file changes none of
them), and D-6 re-checks
suppression and consent at delivery, so a STOP sent after the call still blocks it. The answer
is a `<Say>` that the link is on its way, then the voicemail prompt and `<Record>`. Any other
digit, a missing `offered`, or no key at all records nothing and sends nothing: no press, no
text.

**T-13. Voicemail becomes an Inbox item.** `<Record maxLength="120" timeout="5"
playBeep="true" action=".../recording?step=done" recordingStatusCallback=".../recording">`;
the action step answers `<Hangup/>`. A status callback with `RecordingStatus` `completed` and
a `RecordingDuration` of at least 1 second runs `voice.voicemail.record`, keyed
`twilio-voice:<CallSid>:voicemail`, and inserts one `voicemails` row (unique per call):
`call_sid`, `caller_e164` (null when withheld), `contact_id` (the contact that already has
that number, or the one T-12 made; a voicemail alone never creates a contact, `public-intake.md`
P-7), `recording_sid`, `duration_seconds`, `status` (`new` or `reviewed`), `recorded_at` and
`audio_expires_at` (30 days later). The Inbox lists it as a `voicemail` entry in the caller's
thread (`inbox-home.md` I-1, I-3 need the revision named in Known limits). Owners and staff
with `inbox.drafts` play it through `GET /v1/inbox/voicemails/:id/audio`, which streams the
recording from Twilio; the API keeps no copy. A daily job deletes expired recordings at
Twilio and clears `recording_sid`; the row stays. `transcription.md` may take the voicemail as
a `voicemail` job. Caller speech is data, never instructions.

**T-14. Limits and replays.** Limits go through `rate_limit_take` (`public-intake.md` P-10),
before the decision they guard:
- offers (T-11): one per caller number per tenant per 24 hours, and 100 per tenant per 24
  hours; a refused charge means no offer, voicemail only;
- voicemails: 5 per caller number per hour and 200 per tenant per day; over the limit the
  answer is a `<Say>` that the mailbox is full, then `<Hangup/>`;
- a limiter that cannot answer means no offer and no recording.
Replays: `voice_calls` holds one row per tenant and `CallSid` (`from_e164`, `to_e164`,
`dial_status`, `offered`, `offer_reason`, `created_at`). Each step's result is stored under
its `twilio-voice:<CallSid>:<step>` key, so a repeated webhook replays the stored TwiML,
charges no limit twice, and writes no second consent, voicemail or event; the message id
derived from `CallSid` keeps a second event from becoming a second send (`delivery.md` D-2).
A `CallSid` is looked up only in the tenant from the signed URL.

## First slice (revision 3)

Migration (`voice_numbers`, `voice_textback_disclosures`, `voice_calls`,
`voice_textback_consents`, `voicemails`, forced RLS with `tenant_scope`, append-only triggers),
the four routes, the three actions with `voiceActorId`, the `voice:number` script and the
`twilio-voice:` prefix. The audio route and the Inbox entry follow the `inbox-home.md`
revision.

Acceptance test (fake Twilio, real Postgres under `zs_runtime`): a signed incoming call to
Halden & Rowe's number answers `<Dial>` with the action URL; a forged signature is 401. A dial
callback `no-answer` answers the `<Gather>` with the current disclosure; `completed` answers
`<Hangup/>`. Gather `Digits=1` creates a phone-only contact with SMS `granted` and source
`twilio-voice:<CallSid>`, one consent row holding the disclosure text, and one
`message.send_requested` event; the delivery worker sends it once through the fake provider.
The same gather replayed sends nothing more. No key, or `Digits=2`, writes nothing. A caller
with a `stop` suppression gets no offer; a STOP after the opt-in blocks the delivery
`suppressed`. A second missed call from the same number within 24 hours gets no offer. A
completed recording writes one `voicemails` row; its replay writes none. Tenant B cannot read
tenant A's calls, consents or voicemails, and a tenant A `CallSid` posted to tenant B's URL
changes nothing.

## Known limits (revision 3)

- `inbox-home.md` needs a revision that adds the `voicemail` entry (I-3) and a thread for a
  caller with no contact (I-1, for example `m_<voicemailId>`) before voicemails show in the
  Inbox. This file does not change I-1..I-9.
- Open question: the forwarded leg, the voicemail minutes and the inbound minutes are charged
  to the platform's Twilio account and are not reserved in the tenant wallet. Whether they move
  to the wallet under `delivery.md` D-11 is not decided. The text itself is priced and reserved
  like any SMS (D-5).
- A caller ID can be spoofed. The harm is bounded: one offer per number per day, the text goes
  only to the number that was shown, a recorded denial or STOP is never overridden, and D-6
  checks again at delivery.
- An opted-in caller whose carrier refuses the text (a landline, error 21614) gets nothing; the
  delivery ends `provider_rejected`.
- Health or medical voicemail is not screened at intake; `transcription.md` X-2 refuses it for
  transcription.

## Known limits (revision 1)

- One number per tenant; no Messaging Service pools or short codes yet.
- An outcome with no callback inside the wait is a dead letter for an operator, who checks
  Twilio's message log and settles it (D-8).
- A `failed` or `undelivered` carrier status after acceptance keeps the charge captured.
- Inbound texts other than keywords are not stored; SMS threads in the Inbox come later.
- Twilio signatures have no timestamp; replays are absorbed by idempotency keys.
