# Hub plans: paid subscriptions through Stripe Billing

Status: draft contract, revision 1 (2026-11-07). Code follows this file; a change to a numbered
rule needs a new revision of this file first. Extends `stripe.md` (revision 5): the same Stripe
account, webhook endpoint, event inbox (`stripe_events`) and billing worker carry plan events.
Prices come from `zs-agency-site/design/PRICING.md` (final, 2026-11-07), section 1B and section 5.

Scope: an owner picks a Hub plan (Solo, Studio or Pro, monthly or yearly), with extra managed
connections as an add-on, and pays through Stripe Checkout in subscription mode. Stripe's signed
events move the tenant's plan record: the plan, its limits, the trial, a failed payment, the
grace period and the drop to read-only. The owner manages the card, invoices and cancelling in
Stripe's Customer Portal. Usage (texts, voice, lookups) stays on the prepaid wallet
(`stripe.md` S-1..S-8, `delivery.md` D-4); a plan never moves wallet money.

Out of scope for this revision: the seat, texting-number, extra-email and guided set-up add-ons
(their prices exist in PRICING.md section 5; each needs a rule here before it is sold), changing
the add-on quantity after Checkout, proration previews, taxes beyond Stripe's defaults, metered
billing, and requiring a plan of a tenant that never had one (Known limits).

## Evidence and decisions

- Prices (Devin, 2026-11-07, PRICING.md): Solo $49 / month or $490 / year, Studio $99 or $990,
  Pro $199 or $1,990. Founding rate for the first 25 businesses on Studio or Pro, invite only:
  $69 / $690 and $139 / $1,390. Extra managed connection $10 / month. Usage stays on the wallet.
- Founding is a **separate price** on the Studio and Pro products, not a coupon (PRICING.md
  section 5): a code could be applied to another plan, a price the Hub alone chooses cannot.
- Trial: **14 days, card required, once per tenant** (PRICING.md section 1B: "14-day free trial
  with a card on file"). Checkout always collects a card, so a trial converts on its own.
- Grace: **7 days** after the first failed renewal payment the plan stays on; then the tenant is
  read-only until a payment succeeds or a new subscription starts.
- Provider behaviour (studied from Stripe's public API docs, in our own words): a Checkout Session
  with `mode=subscription` takes catalog prices as line items (`line_items[n][price]`, quantity),
  an optional existing `customer`, `subscription_data[metadata]` (copied onto the subscription),
  `subscription_data[trial_period_days]`, `payment_method_collection=always` and `expires_at`, and
  creates the customer itself when none is given. The completed session names its `customer` and
  `subscription`. A Customer Portal session is `POST /v1/billing_portal/sessions` with `customer`,
  `return_url` and an optional `configuration`, and answers a short-lived hosted `url`.
  Subscription events (`customer.subscription.created`, `.updated`, `.deleted`) carry the whole
  subscription: `status` (`trialing`, `active`, `past_due`, `unpaid`, `canceled`, `incomplete`,
  `incomplete_expired`, `paused`), `customer`, `metadata`, `items.data[]` with each item's
  `price` (`id`, `lookup_key`) and `quantity`, `trial_end`, `cancel_at_period_end`, `ended_at`, and
  the period end (on the subscription in older API versions, on each item in newer ones).
  Invoice events (`invoice.paid`, `invoice.payment_failed`) carry `id`, `customer`, the
  subscription (`subscription` in older versions, `parent.subscription_details.subscription` and
  its `metadata` in newer ones), `amount_due` and `currency`. Every event has `created` (Unix
  seconds). Events may repeat and arrive in any order. The Portal cannot change a subscription
  that has more than one item.
- Tenants that exist today (Zero Sum, tenant 1, and the pilot tenants) never subscribed. They keep
  working as they do: this revision limits and locks only tenants that have had a subscription.

## Numbered rules

**PL-1. Plans and what they unlock.** The catalog lives in `packages/contracts` (one source for the
API, the worker and the dashboard). Amounts are USD cents.

| | Solo | Studio | Pro |
|---|---|---|---|
| Monthly / yearly | 4,900 / 49,000 | 9,900 / 99,000 | 19,900 / 199,000 |
| Founding monthly / yearly | not offered | 6,900 / 69,000 | 13,900 / 139,000 |
| Team seats (`tenant_members` rows) | 2 | 6 | 15 |
| Bookable resources | 1 | 3 | 10 |
| Managed connections (connections.md; Google Calendar not counted) | 1 | 3 | 10 |
| MCP and automation tokens (hub-access.md; unrevoked, unexpired) | 0 | 2 | 10 |
| Model-assisted agents with approvals | no | yes | yes |
| Voice receptionist and missed-call text-back | no | no | yes |
| Agent daily model cap, cents | 100 | 100 | 300 |
| Emails a month | 1,000 | 4,000 | 15,000 |

Each extra-connection add-on unit adds one managed connection. Where PRICING.md is silent this
revision picked: resources and seats count every row the tenant has; tokens count unrevoked
tokens whose expiry has not passed. Enforced in this revision (PL-8): seats on `member.invite`,
managed connections on `connection.connect`, tokens on `automation.token.create`. The other rows
are stated for the dashboard and later rules (Known limits).

**PL-2. Stripe catalog.** Each price carries the `lookup_key` from PRICING.md section 5:
`hub_{solo,studio,pro}_{month,year}`, `hub_{studio,pro}_founding_{month,year}` and
`hub_connection_month`, with metadata `zs_plan`, `zs_interval` (and `founding=true`). The API
holds a map from lookup key to price ID (PL-12). The worker never needs it: it reads the plan from
the subscription item's `price.lookup_key`. An item whose lookup key is not in the catalog makes
the event `mismatch` and changes nothing.

**PL-3. The plan record.** `tenant_plans` holds one row per tenant that has had a subscription
or a founding invite: plan, interval, founding, status (`none` until the first subscription event,
then Stripe's), extra connections, Stripe customer and subscription IDs (each unique), trial end,
period end, `cancel_at_period_end`, `trial_used`, `founding_invite`, `founding_started_at`,
`payment_failed_at`, `read_only_after` and the `created` of the last applied subscription event.
A tenant with no row, or with status `none`, is **comped**: no plan limits and never read-only.
`plan_checkouts` holds each started Checkout like `wallet_topups` holds top-ups.
`plan_invoices` holds one row per Stripe invoice the worker saw: `paid` or `failed`, and when it
first failed.

**PL-4. Starting Checkout.** `POST /v1/billing/plan/checkout { plan, interval, extraConnections }`
with an `Idempotency-Key`, owners only (`billing`), runs the action `plan.checkout.create` through
the dispatcher. `extraConnections` is 0 to 20. The action inserts one `plan_checkouts` row
(`pending`) whose ID derives from the key. The price IDs, return URL and trial length reach the
handler as dispatch config from this route, never in the payload, so a caller cannot choose them
and the action cannot run from anywhere else (without the config it is 404). The handler picks,
from the tenant's own row: the founding price when `founding_invite` is set and the plan is Studio
or Pro (Solo never has one); a 14-day trial only when `trial_used` is false; and the stored
customer ID when there is one. It stores all of them with the checkout. A tenant whose plan is
`trialing`, `active` or `past_due` is refused (409 `plan_exists`): it changes plan in the Portal.
Off (404) without plan config.

**PL-5. The Checkout Session.** After the action commits, the route asks Stripe for a session with
`Idempotency-Key: zsp-<checkout id>`: `mode=subscription`, the plan price (quantity 1) and, when
`extraConnections` is above 0, the add-on price with that quantity; the stored customer or none;
`client_reference_id` and `metadata` and `subscription_data[metadata]` naming `zs_tenant` and
`zs_checkout`; the stored trial days; `payment_method_collection=always`; success URL
`<return>?checkout=success`, cancel URL `<return>?checkout=cancelled`; and `expires_at` one hour
after the checkout was created. Every parameter derives from the stored row, so a retry is the same
request and Stripe replays the same session. The URL Stripe answers is stored once and returned on
later retries. The same 25-minute retry window and `topup_closed`-style answer apply
(409 `checkout_closed`). Answers: 201 `{ checkout, checkoutUrl }`; Stripe unreachable, 409, 429 or
5xx: 503; any other refusal: 500.

**PL-6. The Customer Portal.** `POST /v1/billing/portal` (owners, `billing`) answers
`{ url }` for a Portal session of the tenant's stored customer, with the return URL and the
optional configuration ID from config. It writes nothing of ours, so it is not an action; it is
refused (409 `no_customer`) before any subscription event named a customer, and is 404 without
plan config. The Portal configuration (set in Stripe) lets an owner update the card, see
invoices and cancel at period end, and switch only between the six list prices: founding prices
are never listed there.

**PL-7. Reading the plan.** `GET /v1/billing/plan` (owners, `billing`) answers the plan record as
the dashboard needs it: plan, interval, status, founding, extra connections, trial and period
ends, `cancelAtPeriodEnd`, `paymentFailedAt`, `readOnlyAfter`, `readOnly`, the limits in force,
the catalog with list prices, and founding prices only for an invited tenant; `checkoutEnabled`
and `portalEnabled` say whether the routes are on. A comped tenant answers status `none`.

**PL-8. Read-only and limits, on the one action path.** The dispatcher checks the plan record in
the action's own transaction, after an idempotent replay is answered and before the handler, for
every action of every principal. **Read-only** means `read_only_after` is set and at or before the
injected clock. A read-only tenant may run only: `plan.checkout.create`, `wallet.topup.create`,
`suppression.record`, the inbound and worker records (`sms.status.record`, `sms.reply.record`,
`voice.call.record`, `voice.voicemail.record`, `voice.textback.optin`, `transcription.job.complete`,
`transcription.job.fail`, `catalog.intake.result`, `catalog.intake.fail`, `media.variant.stage`,
`media.variant.fail`), the stops (`agent.kill`, `agent.kind.kill`, `browser.kill`,
`agent.run.finish`, `agent.run.stall`, `agent.kind.run.finish`, `agent.cost.warn`) and the
removals (`member.remove`, `connection.disconnect`, `calendar.google.disconnect`,
`automation.token.revoke`, `approval.reject`, `approval.revoke`, `inbox.reply.discard`). Anything
else is refused with 409 `plan_read_only`. Reads always work, so an owner can see and export the
data. **Limits** (PL-1) apply to a tenant whose record names a plan: before `member.invite`,
`connection.connect` and `automation.token.create`, the dispatcher takes a per-tenant transaction
lock, counts, and refuses at the limit with 409 `plan_limit` (`{ limit, used, resource }`). Two
concurrent requests therefore cannot both take the last slot.

**PL-9. Webhook intake.** Unchanged `stripe.md` S-3: the same endpoint, signature check, mode
check and inbox. The Stripe endpoint adds `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and
`invoice.payment_failed`.

**PL-10. Applying events, in any order.** The billing worker (service role) applies plan events
under `stripe.md` S-4 (one event per transaction, savepoint, backoff, `orphaned`). The tenant
always comes from our own rows: through `metadata.zs_tenant` and `zs_checkout` naming a
`plan_checkouts` row of that tenant, or through the stored customer ID. An invoice for a customer
not known yet waits (S-4 backoff). Rules:
- `checkout.session.completed` with `mode=subscription`: marks the checkout `completed` and stores
  the customer ID on the tenant's record (creating the row). `checkout.session.expired` marks a
  pending checkout `expired`.
- A subscription event is a snapshot. It is applied only when its `created` is at or after the
  last applied one for the tenant, and never to a subscription already `canceled` (terminal). It
  sets plan, interval, founding (from the plan item's lookup key), extra connections (the add-on
  item's quantity), status, trial end, period end and `cancel_at_period_end`; sets `trial_used`;
  and sets `founding_started_at` the first time a founding price starts. A different subscription
  for a tenant whose tracked one is still `trialing`, `active` or `past_due` ends `duplicate` for an
  operator and changes nothing.
- `invoice.paid` marks the invoice `paid` (terminal: a later failure of the same invoice changes
  nothing). `invoice.payment_failed` marks it `failed` and keeps the earliest failure time (the
  event's `created`).
- After each event the worker recomputes, from the rows alone: `payment_failed_at` is the earliest
  failure among the tracked subscription's `failed` invoices (none: null), and `read_only_after` is
  `payment_failed_at + grace` while the status is `trialing`, `active` or `past_due`; for `canceled`,
  `unpaid`, `incomplete_expired` or `paused` it is the earliest of that and when the status was
  first seen (`ended_at` when given, else the event's `created`); otherwise null. A paid invoice or a
  new subscription therefore lifts read-only, and replaying any event changes nothing.

**PL-11. Founding.** An operator (service role, `setFoundingInvite`) sets `founding_invite` on a
tenant; it refuses a 26th tenant counted by `founding_invite` or `founding_started_at`. The server
alone chooses a founding price (PL-4); no founding price ID ever reaches a browser. When a
founding subscription is deleted, the tenant loses `founding_invite` and pays list price on its
next Checkout; its `founding_started_at` stays, so the slot stays used.

**PL-12. Tenancy and roles.** `tenant_plans`, `plan_checkouts` and `plan_invoices` have
`tenant_id`, forced RLS, the tenant policy and are in the catalog isolation test, with a
two-tenant denial test under the runtime role. The runtime role reads its own tenant's rows; it may
insert a pending checkout through the action and update only its stored session URL; it never
writes `tenant_plans` or `plan_invoices`. The worker names `tenant_id` in every statement.

**PL-13. Configuration.** API function (beside S-9): `STRIPE_PLAN_PRICES`, a JSON object from
every PL-2 lookup key to its `price_…` ID (all eleven, or the variable is refused);
`STRIPE_PLAN_RETURN_URL` (https, the dashboard's plan page); optional `STRIPE_PLAN_TRIAL_DAYS`
(0 to 30, default 14); optional `STRIPE_PORTAL_CONFIGURATION` (`bpc_…`). Plans are on only when
the S-9 Stripe variables and these are set; none of them is set on the workers project. Billing
function: optional `BILLING_PLAN_GRACE_DAYS` (1 to 30, default 7). Core reads none of them from
the environment; the entry points parse them and pass them in, with the clock.

## Known limits (revision 1)

- A tenant that never subscribed is comped. Requiring a plan of new tenants needs a rule here.
- Bookable resources, model-assisted agents, voice, the agent daily cap and the email allowance
  are stated in PL-1 but not enforced by this revision.
- The add-on quantity is chosen at Checkout; the Portal cannot change a two-item subscription, so
  an owner with the add-on changes plan or quantity through support until a rule adds a route.
- Messages queued before a tenant turns read-only may still be sent by the delivery worker.
- The founding cap counts invites, not sign-ups; the operator invites.
