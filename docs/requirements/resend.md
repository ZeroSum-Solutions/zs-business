# M5: Resend email provider

Status: draft contract for M5, provider 1 of 5 (2026-10-20), revision 1. Code follows this file;
a change to a numbered rule needs a new revision of this file first.

Scope: the first real provider behind the M3d provider port (`delivery.md` D-7, D-8). It turns
one delivery attempt into one Resend API call, and turns Resend's signed email events into
suppressions (D-9). Code and tests only: the cloud holds no Resend key and never calls Resend.
Tests talk to an in-process fake HTTP server. The Mac sets the variables in R-6 when the
provider ships.

## Evidence and decisions

- Plan (approved 2026-10-18): M5 providers one at a time, Resend first.
- Provider behaviour (studied from Resend's public API docs and changelog, in our own words):
  `POST /emails` takes an `Idempotency-Key` header of 1 to 256 characters. Resend keeps a key
  for 24 hours. A repeat of the same key and body inside that time returns the first answer
  and sends nothing. The same key with another body is refused with 409
  `invalid_idempotent_request`; a repeat while the first is still running gets 409
  `concurrent_idempotent_requests`. Errors are JSON with `statusCode`, `name` and `message`:
  400 and 422 for a bad request, 401 and 403 for a missing or refused key or domain, 429 for
  rate limits and quotas, 5xx for server errors. Resend has no API that reports on a key
  without sending.
- Webhooks are signed the Standard Webhooks way (Resend delivers them through Svix): headers
  `svix-id`, `svix-timestamp` and `svix-signature`; the signature is HMAC-SHA-256 over
  `<id>.<timestamp>.<raw body>` with the base64 part of the `whsec_` secret, sent as one or
  more space-separated `v1,<base64>` entries. Each email event names one recipient and
  carries the email's tags.

## Numbered rules

**R-1. The adapter.** `createResendProvider({ config, fetch })` implements `DeliveryProvider`
for the email channel. Config and fetch are injected; the adapter reads no environment and no
clock. Its `name` (default `resend`) is what the worker records as the delivery's `provider`.
It refuses an SMS request as `rejected`.

**R-2. Idempotency and the dedupe window.** The delivery's idempotency key (`zsd-<id>`, the
same on every attempt) goes in the `Idempotency-Key` header. The adapter's `dedupeWindowMs`
is Resend's 24 hours and can only be set shorter. The worker's D-8 margin keeps every send
inside it. The request body is built only from the stored request (D-8) and the adapter's
config, in a fixed order, so a resend is the same bytes. Changing `RESEND_FROM` while
deliveries are uncertain makes their resends differ; Resend then answers 409 and those
deliveries end as `outcome_unknown` for an operator, never as a second send.

**R-3. Outcomes.** One HTTP answer maps to one D-7 outcome:
- 2xx with an `id`: `accepted`. 2xx without a readable `id`: `uncertain` (the resend under the
  same key answers with the ID).
- 400, 413, 422: `rejected` (the same request cannot succeed).
- 408, 409: `uncertain` (a request with this key is in flight or was already taken).
- 429 and every other 4xx (401, 403, 404, …): `failed`. Resend refused before acceptance, so the
  reservation is released and the worker retries with backoff up to its attempt cap.
- 5xx, 3xx and anything else: `uncertain`. Redirects are not followed.
- A connection that never opened (refused, DNS failure, unreachable): `failed`. A timeout, a
  reset or any other network error after that: `uncertain`.
Codes are `resend_<status>_<name>` (the error `name`, lower case), or `resend_timeout`,
`resend_connect_<errno>`, `resend_network[_<errno>]`. Response bodies are read up to 64 KiB.
The adapter has no `lookup`, so an outcome still unknown when the window closes, or when a later
check blocks the delivery, becomes a dead letter `outcome_unknown` with the reservation held,
as D-8 says. The resend under the same key inside the window is how an uncertain send is
normally settled exactly once: Resend replays the first answer.

**R-4. What is sent.** `from` and optional `reply_to` come from config; `to` is the one pinned
recipient; `subject` and `text` come from the stored request. The request's headers pass
through, except that the adapter refuses (`rejected`, nothing sent) an email whose headers
lack a `List-Unsubscribe` with an `https` URL and `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (D-9, RFC 8058), any header name that is not a plain token or is
one Resend or the envelope owns (`From`, `To`, `Cc`, `Bcc`, `Subject`, `Reply-To`, …), and
any value with CR, LF or NUL. A subject must be one line; a recipient must be one address.

**R-5. Tags.** Every email carries the tags `zs_tenant` and `zs_delivery` (the UUIDs). They are
how an event names its delivery (R-8). They are set by this system only, never by a recipient.

**R-6. Configuration the Mac sets.** For the sender: `RESEND_API_KEY`, `RESEND_FROM` (a
sender on a domain verified in Resend, with SPF and DKIM), optional `RESEND_REPLY_TO` and
`RESEND_BASE_URL` (https, or http on loopback only). `parseResendEnv(env)` builds the adapter
config from an environment object an entry point passes in. For the webhook endpoint:
`RESEND_WEBHOOK_SECRET` (the endpoint's `whsec_` secret), optional
`RESEND_WEBHOOK_PREVIOUS_SECRET` during a rotation. The Resend webhook should subscribe to
`email.bounced`, `email.complained` and `email.suppressed`; other events are acknowledged and
ignored.

**R-7. Webhook verification.** `POST /webhooks/resend` checks, before parsing or any database
work: all three headers present and well formed, at least one `v1` entry equal (constant time)
to the HMAC by the current or previous secret over the exact bytes received, and a timestamp
within 5 minutes of the injected clock. Any failure is 401 with one fixed body. A valid
signature over a body that is not JSON is 400. Bodies are capped at 256 KiB (413).

**R-8. Events feeding suppression.** A permanent bounce (`email.bounced` whose bounce type is
`Permanent` or absent) and `email.suppressed` record reason `bounce`; `email.complained` records
`complaint`. Transient or undetermined bounces and every other event change nothing. The
tenant and delivery come from the tags (R-5) and are checked under that tenant's scope (runtime
role, RLS): the delivery must exist, be email, have `provider` equal to the adapter's name and a
pinned recipient; a recorded `provider_message_id` must equal the event's `email_id`; the
event's recipient must be the pinned recipient. Anything else is acknowledged (200) and
changes nothing. The suppression goes through the dispatcher with a server-built principal
(`emailFeedbackActorId`) that may run `suppression.record` only, with the idempotency key
`email-feedback:<svix-id>`, so a redelivered webhook replays the stored action. Member and MCP
keys may not use that prefix (D-9). Database errors answer 503, so Resend retries.

## Known limits (revision 1)

- One sender for every tenant. Per-tenant sending domains come later.
- No lookup by key: an unknown outcome past the window waits for an operator (D-8).
- Delivered, opened and clicked events are not stored; nothing reads them yet.
- The worker has no runtime entry point yet; wiring it (cron or queue) on the Mac is the
  M5 deploy step.
