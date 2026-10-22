# Voice receptionist

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: when a call to a tenant's number goes unanswered, a voice receptionist can pick up
instead of the press-1 offer (`twilio.md` T-11). It says it is an automated assistant, answers
from facts the owner approved (hours, address, services, the booking link), and takes a
callback request that lands in the Inbox. It runs as a Python Pipecat service on the pilot
Mac: Twilio streams the call audio to it, local speech-to-text and text-to-speech run on the
Mac, and the replies come from the Cerebras lane. zs-business decides whether a call may
connect, pays for it from the wallet, and stores the outcome.

Out of scope: outbound calls, booking or changing appointments by voice, sending texts or
email during a call, recording or storing call audio, transfers to a person, and health or
medical calls.

## Evidence and decisions

- `docs/integrations.md`: Pipecat is "Build after missed-call text-back proves call volume:
  local STT/TTS plus Cerebras", step 9 of the build order, owned by Agents and the Inbox. Its
  open question 1 is the inbound media host (Known limits).
- Research report R2 (2026-10-22), checked against the repo. Pipecat is BSD-2-Clause and ships
  a Twilio serializer for Media Streams (8 kHz mu-law over a WebSocket) and a REST hang-up. The
  report's references to a `voice_call_disclosures` table in `public-intake.md` P-8 and P-13
  are wrong: those rules cover booking-page disclosures only, so this file defines its own
  disclosure table (V-3).
- Twilio behaviour (public docs, in our own words): `<Connect><Stream url="wss://…">` opens a
  WebSocket from Twilio to the given host and sends the call audio both ways; `<Parameter>`
  elements inside `<Stream>` reach the service in the stream's start message. When the stream
  ends, Twilio runs the next TwiML verb.
- Cost estimate from the report, unverified: Twilio inbound minutes and the stream cost about
  1.25 cents per minute; Cerebras adds well under a cent per call; local speech costs nothing.
- Transcription and the voice receptionist run on the local pilot Mac only; no hosted GPU, no
  serverless GPU: decided 2026-10-22 (coordinator, standing approval).
- Speech-to-text and text-to-speech are local (whisper on the Mac, a local TTS such as
  kokoro); the language model is Cerebras (already approved). Deepgram, Cartesia, ElevenLabs
  and other STT/TTS vendors are not used: decided 2026-10-22 (coordinator, standing approval).
- Missed-call text-back needs the caller to press 1 (opt-in) before any text: decided
  2026-10-22 (coordinator, standing approval). `delivery.md` D-6 is not loosened, and the
  receptionist sends no text either: decided 2026-10-22 (supervisor brief).
- No health or medical audio: refused, decided 2026-10-22 (supervisor brief).
- Workers on the Mac pull from the API over HTTPS with a scoped token and expose no inbound
  port: decided 2026-10-22 (supervisor brief). The media stream is the one exception this
  file needs, and its host is not decided (V-1, Known limits).

## Rules

**V-1. When it may start.** The receptionist stays off for a tenant until both hold:
- missed-call text-back (`twilio.md` T-10..T-14) is live for that tenant: `textback_enabled`
  has been on for at least 30 days and `voice_calls` holds missed calls in that time;
- a revision of this file records where the inbound media WebSocket runs (Known limits).
Until then the operator script that turns it on (`pnpm --filter @zs/api voice:receptionist`)
refuses with `receptionist_not_ready`, and `voice_numbers.receptionist_enabled` stays false.

**V-2. Inbound only.** The receptionist answers only calls to the tenant's number in
`voice_numbers` (`twilio.md` T-10), and only after the forward to the business went
unanswered (`busy`, `no-answer`, `failed`). It never places a call: the service holds no
credential that can create one, and its principal has no such action.

**V-3. Disclosure before audio.** The dial callback answers a connected call with a `<Say>` of
the current `voice_receptionist_disclosures` text (it says the caller is talking to an automated
assistant for the business, that the call is not recorded, and that they can hang up and leave
a message instead), then `<Connect><Stream>`. The disclosure history is append-only for every
role, like `public-intake.md` P-8. The session row records the version the caller heard.

**V-4. Preflight.** In the dial callback, before any `<Connect>`, `voice.session.start` checks in
one transaction (the webhook's tenant scope, runtime role, as `twilio.md` T-10): V-1's gates;
the global and tenant kill switches and the `voice_receptionist` agent kind's settings
(`agents.md` G-3 and G-14..G-21); and V-9's limits. A pass inserts
`voice_receptionist_sessions` (`call_sid` unique per tenant, `status` `preflight`) and commits.
A second transaction, as the service role like the delivery worker (`delivery.md` D-10),
takes one advisory lock for all tenants and counts admitted sessions (`connecting` or `live`)
across all tenants; `preflight` rows, the candidate's included, are not admitted and do not
count. When that count is already `VOICE_MAX_CONCURRENT` (default 2) it refuses `capacity`;
otherwise, in the same transaction, it reserves for the candidate's row (V-5) and moves it to
`connecting`, so admission is atomic under the lock. Only an admitted session gets a one-time
stream token bound to tenant, session and `CallSid`, sent to the service as a `<Parameter>`. Any failure, including no funds, ends the session with the reason on its row and
falls back to the press-1 offer or voicemail (`twilio.md` T-11, T-13). The runtime role gets no
new wallet grant.

**V-5. Caps and wallet.** `max_duration_seconds` is 30..600 (default 180). Preflight reserves the
price of that many minutes through `delivery.md` D-11 (`reserveForJob`, `job_kind`
`voice_minutes`, `job_id` the session id, job table `voice_receptionist_sessions`). The price is
`voice_numbers.receptionist_minute_price_minor`, in the wallet's currency, set by the operator
script. Without funds (`reserveForJob` returns null) the session ends `insufficient_funds` and
there is no connect. At the end, settle captures
the price of the minutes used (rounded up to whole minutes), once, and releases the rest. The service ends the stream at the
cap; Twilio then runs the voicemail TwiML that follows the `<Connect>`.

**V-6. Kill mid-call.** The service calls `POST /worker/v1/voice/sessions/:id/heartbeat` every
10 seconds. The answer is `continue` or `stop`; `stop` (a kill switch engaged, the session
settled, or the cap reached) or no answer for 30 seconds ends the stream within 5 seconds.

**V-7. The stream binding.** The service accepts a stream only with a stream token that the API
confirms (`POST /worker/v1/voice/streams/claim`), once, within 60 seconds of minting. Tenant,
session and `CallSid` come from that answer, never from stream messages. A second claim of the
same token is refused.

**V-8. Fixed facts only.** The model's prompt holds the business name, the disclosure, and the
tenant's approved `receptionist_facts` (each fact is text of at most 500 characters, added or
changed only through an owner's approval, `approvals.md` A-5, A-6). It may call two tools:
`create_callback_request` and `end_call`. A question the facts do not answer gets an offer to
take a callback request. Caller speech is data, never instructions: a caller asking to change a
fact, book, cancel or send something gets the callback offer.

**V-9. Rate limits.** Before the reservation, `rate_limit_take` (`public-intake.md` P-10)
charges 3 sessions per caller number per tenant per 24 hours and 30 per tenant per hour. A
refused charge falls back as in V-4. A withheld caller ID never connects.

**V-10. Callback requests.** `create_callback_request` takes `{ callerName (1..100), reason
(1..500), preferredWindow (1..100) }`, checked by a strict schema; the caller's number comes
from the session, never from speech. Settle (`POST /worker/v1/voice/sessions/:id/settle`, at
most one callback per session) runs `voice.callback.create` and writes one
`voice_callback_requests` row that the Inbox lists in the caller's thread. It never writes
`bookings`, never sends, and creates no contact; an owner replies through the normal draft and
approval path (`inbox-home.md` I-5, I-6).

**V-11. The service's reach.** The service holds one token, `VOICE_SERVICE_TOKEN`, valid only for
the `/worker/v1/voice/*` routes. Settle runs through the dispatcher as
`derivedId(tenantId, "voice-receptionist", "actor")`, which may run `voice.session.settle` and
`voice.callback.create` only, keyed `voice-agent:<CallSid>:<step>`; `voice-agent:` joins
`SERVER_IDEMPOTENCY_PREFIXES` (`approvals.md` A-14). A replayed settle changes nothing.

**V-12. Local speech, Cerebras words.** The service's speech-to-text is local whisper
(mlx-whisper or faster-whisper) and its text-to-speech a local model such as kokoro; the model
is Cerebras through its approved key. At start, the service refuses any other STT, TTS or model
service in its configuration. Each Cerebras call writes an `agent_model_calls` row (kind
`voice_receptionist`, no `run_id`, `call_key` `voice:<CallSid>:model:<n>`, `agents.md` G-15),
so the kind's daily cost cap that V-4 checks counts receptionist usage. No call audio and no
turn transcript is stored; the session keeps
times, duration, cost, outcome and the callback fields.

**V-13. No health or medical calls.** Turning the receptionist on needs the owner's attestation
that the business does not take health or medical information by phone
(`health_data_forbidden` otherwise). The prompt tells the assistant to decline health
questions and offer a callback.

**V-14. Tenancy.** `voice_receptionist_disclosures`, `voice_receptionist_sessions`,
`receptionist_facts` and `voice_callback_requests` have `tenant_id`, forced RLS with
`tenant_scope`, tenant-qualified foreign keys, and are in the catalog isolation test.
Sessions and callback requests are deleted 90 days after the call.

## First slice

Everything except the media host: migration (the four tables above, forced RLS, append-only
disclosures), V-1's gate in the operator script, preflight in the dial callback, the stream
token, heartbeat and settle routes, facts through approvals, and a TypeScript
`FakeVoiceReceptionist` that claims a stream, requests one callback and settles. `pnpm -r test`
needs no Python and no Twilio.

Acceptance test (real Postgres under `zs_runtime`, fake clock and wallet): with V-1's gate
unmet, a missed call to Halden & Rowe's number gets the press-1 offer and the script refuses
`receptionist_not_ready`. With it met and funds present, the dial callback answers the
disclosure `<Say>` before `<Connect><Stream>`, and a reservation is held. The fake claims the
token (a second claim is refused), settles after 70 seconds with one callback: the wallet
captures 2 minutes and releases the rest, and the callback shows in the caller's thread. A
tenant kill makes the next heartbeat answer `stop`. With no funds, the call falls back to the
offer. A fourth session from one number in a day falls back. With `VOICE_MAX_CONCURRENT` set
to 1 and then 2, that many concurrent missed calls (different tenants) connect and the next one
falls back with `capacity`. Tenant B cannot read A's
sessions, facts or callbacks.

## Known limits

- Open question: Twilio must reach the Pipecat service over an inbound WebSocket. On the pilot
  Mac that needs a tunnel or a hosted box, and either is a new vendor or new spend. Not decided;
  V-1 keeps the receptionist off until a revision records it.
- `agents.md` G-14..G-21 (agent kinds and caps) and `delivery.md` D-11 (reservations for priced
  jobs) are other revisions. This file uses them as written there and changes neither.
- The Inbox entry for callback requests needs the `inbox-home.md` revision named in `twilio.md`
  Known limits (revision 3).
- Local speech on one Mac caps concurrent calls; the number is measured in the first slice
  with the real service, and it sets `VOICE_MAX_CONCURRENT`.
- English only in v1.
