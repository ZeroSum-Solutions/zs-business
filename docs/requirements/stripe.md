# M5: Stripe wallet top-ups

Status: draft contract for M5, provider 2 of 5 (2026-10-20), revision 2. Code follows this file;
a change to a numbered rule needs a new revision of this file first.

Scope: owners add money to the M3d prepaid wallet (`delivery.md` D-4) through Stripe Checkout,
and Stripe's signed events move the wallet: a paid top-up credits it once, a refund or a
dispute takes the money back without the balance ever going negative. Code and tests only: the
cloud holds no Stripe key and never calls Stripe. Tests use an in-process fake Stripe server.
Everything is off until the Mac sets the variables in S-9.

## Evidence and decisions

- Plan (approved 2026-10-18): M5 providers one at a time; Stripe after Resend. M3d left
  top-ups to M5 (`creditWallet` is the seam).
- Provider behaviour (studied from Stripe's public API docs, in our own words): a Checkout
  Session is created with a form-encoded `POST /v1/checkout/sessions` and answers its `id` and
  hosted `url`. A request with an `Idempotency-Key` that Stripe has seen in the last 24 hours
  replays the first answer; the same key with other parameters is refused. A session can be
  given `metadata`, a `client_reference_id`, metadata for the payment it creates
  (`payment_intent_data[metadata]`) and an `expires_at` between 30 minutes and 24 hours ahead.
  Webhooks carry a `Stripe-Signature` header `t=<unix seconds>,v1=<hex>[,v1=…]`; `v1` is
  HMAC-SHA-256 over `<t>.<raw body>` keyed with the endpoint secret (`whsec_…`) as text.
  Stripe may deliver an event more than once and in any order. Events used here:
  `checkout.session.completed` (with `payment_status` `paid`, or `unpaid` for a delayed
  method), `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `checkout.session.expired`, `charge.refunded` (the charge's `amount_refunded` is the running
  total), `charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`.
- Runtime roles never write wallet money (D-4). So the webhook only stores the event, and the
  billing worker (service role, like the delivery worker) moves money.

## Numbered rules

**S-1. Starting a top-up.** `POST /v1/wallet/top-ups { amount }` with an `Idempotency-Key`,
owners only (`billing`), runs the action `wallet.topup.create` through the dispatcher. It
inserts one `wallet_topups` row (`pending`) whose ID derives from the key, so a retry names the
same top-up. The amount is whole minor units between `STRIPE_TOPUP_MIN` and `STRIPE_TOPUP_MAX`
in the configured currency. Off (404) without Stripe config.

**S-2. The Checkout Session.** After the action commits, the route asks Stripe for a session
with `Idempotency-Key: zst-<topup id>`: one line item of the amount, `client_reference_id` and
`metadata` and `payment_intent_data[metadata]` naming `zs_tenant` and `zs_topup`, the
configured success and cancel URLs, and `expires_at` one hour after the top-up was created.
Every parameter derives from the stored row and config, so a retry is the same request and
Stripe replays the same session. Stripe refuses an `expires_at` less than 30 minutes ahead, so
a retry later than 25 minutes after creation, or for a top-up that is no longer `pending`, is
refused (409 `topup_closed`) instead of risking a refused or second session.
Answers: 201 `{ topup, checkoutUrl }`; Stripe unreachable, 429 or 5xx: 503 (retry with the same
key); any other Stripe refusal: 500.

**S-3. Webhook intake.** `POST /webhooks/stripe` checks, before parsing or any database work,
that a `v1` entry equals (constant time) the HMAC by the current or previous secret over the
exact bytes, and that `t` is within 5 minutes of the injected clock. Failure: 401. A signed
body that is not a JSON event (`id` `evt_…`, `type`, `livemode`, `data.object`) is 400. An
event whose `livemode` differs from `STRIPE_LIVEMODE` is acknowledged and dropped. Otherwise the
event is inserted into `stripe_events` once by its ID (a redelivery changes nothing) and the
answer is 200. Bodies are capped at 256 KiB. Database errors answer 503, so Stripe retries.
`stripe_events` is a platform table, not a tenant table: the runtime role may insert into it
and nothing else; only the service role reads it.

**S-4. Processing.** The billing worker (service role) claims unprocessed events oldest first
(`FOR UPDATE SKIP LOCKED`, due by `next_attempt_at`), applies each in its own savepoint and
marks it processed with an outcome. The tenant and top-up always come from our own
`wallet_topups` row: through `metadata.zs_tenant` and `zs_topup` on a session event (the row
must exist in that tenant), or through the stored `stripe_payment_intent_id` for charge and
dispute events. An event whose top-up is not known yet (a refund that arrives before its
payment) waits with backoff and is retried, up to `maxAttempts`, then ends `orphaned` for an
operator. Unknown event types end `ignored`.

**S-5. Paid: credit once.** `checkout.session.completed` with `payment_status` `paid`, or
`checkout.session.async_payment_succeeded`, for a `pending` top-up: the session's `amount_total`
and `currency` must equal the top-up's, or the top-up becomes `mismatch` and nothing is
credited. Otherwise the worker records the session and payment IDs, credits the wallet with the
ledger key `stripe:topup:<id>` and marks the top-up `paid`. The ledger key makes a second credit
impossible, whatever events repeat. `async_payment_failed` marks a pending top-up `failed`;
`expired` marks it `expired`. A paid top-up never goes back to another status.

**S-6. Refunds and disputes never go negative.** A refund debits the growth of the charge's
`amount_refunded` over what is already recorded, capped at the top-up amount; an older,
smaller total changes nothing. `charge.dispute.funds_withdrawn` debits the dispute amount;
`charge.dispute.funds_reinstated` credits it back. A debit takes what is available
(`balance - reserved`) and records the rest as `owed` on the wallet: the balance never goes
below zero and held reservations stay covered. While a wallet owes anything it reserves nothing
(D-5 gains `owed = 0`), so no send is paid from money that was taken back. Every later credit,
and every billing worker pass, first repays `owed` from what is available. Each debit or
reinstatement is recorded once in `wallet_billing_events` by its Stripe reference (refund
total, dispute ID and direction), so repeats and reordering are safe.

**S-7. Tenancy.** `wallet_topups` and `wallet_billing_events` have `tenant_id`, forced RLS, the
tenant policy, and are in the catalog isolation test. The runtime role reads its own tenant's
rows and may insert a pending top-up through the action; it never updates money columns. The
worker names `tenant_id` in every statement.

**S-8. Running it.** `GET /cron/billing` is its own Vercel function, with the same Bearer
`CRON_SECRET` check as `/cron/delivery`; `pnpm billing:worker` is the Node loop. The kill switch
is `BILLING_WORKER=on`. The build adds a Vercel cron only when `BILLING_CRON_SCHEDULE` is set.
A run stops starting passes once `BILLING_RUN_BUDGET_MS` is spent; the cron entry refuses a
budget over 20 s, since Vercel stops its function at 30 s (the Node loop may run longer).

**S-9. Configuration the Mac sets.** API function: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
(optional `STRIPE_WEBHOOK_PREVIOUS_SECRET`), `STRIPE_LIVEMODE` (`true` or `false`),
`STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, optional `STRIPE_CURRENCY` (`usd`),
`STRIPE_TOPUP_MIN` and `STRIPE_TOPUP_MAX` (minor units), `STRIPE_API_VERSION`,
`STRIPE_BASE_URL`. Billing function: `BILLING_WORKER=on`, `CRON_SECRET`,
`BILLING_DATABASE_URL` (a login that may `SET ROLE service_role`). In Stripe: a webhook
endpoint at `https://<api host>/webhooks/stripe` for the events listed above.

## Known limits (revision 2)

- One currency, the wallet's. Taxes and receipts are Stripe's defaults.
- The wallet summary does not show `owed` yet; the dashboard reads a strict shape.
- No Stripe lookup: a lost webhook is recovered by Stripe's own retries for up to three days.
