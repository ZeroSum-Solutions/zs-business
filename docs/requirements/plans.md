# Hub plans: paid subscriptions through Stripe Billing and Shopify App Pricing

Status: draft contract, revision 3 (2026-11-07: PL-15..PL-20, Shopify merchants pay through
Shopify App Pricing, read back from the Partner API). Revision 2 added PL-14, a billing provider
per tenant and per subscription. Revision 1 followed a
GPT-6.1 Sol review of the first draft (mixed intervals, event order, stale checkouts, unpaid
replacements, worker serialization). Code
follows this file; a change to a numbered rule needs a new revision of this file first. Extends `stripe.md` (revision 5): the same Stripe
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
  seconds), but Stripe does not promise order, and `created` has one-second resolution, so it
  cannot order two updates. `GET /v1/subscriptions/<id>` answers the subscription as it is now,
  for a canceled one too. One Checkout Session cannot mix a yearly and a monthly price. The Portal
  cannot change a subscription that has more than one item. A restricted key can be limited to
  reading subscriptions.
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

Each extra-connection add-on unit adds one managed connection. The add-on is monthly, so it is
sold with monthly plans only (Stripe cannot mix intervals in one Checkout). Where PRICING.md is silent this
revision picked: resources and seats count every row the tenant has; tokens count unrevoked
tokens whose expiry has not passed. Enforced in this revision (PL-8): seats on `member.invite`,
managed connections on `connection.connect`, tokens on `automation.token.create`. The other rows
are stated for the dashboard and later rules (Known limits).

**PL-2. Stripe catalog.** Each price carries the `lookup_key` from PRICING.md section 5:
`hub_{solo,studio,pro}_{month,year}`, `hub_{studio,pro}_founding_{month,year}` and
`hub_connection_month`, with metadata `zs_plan`, `zs_interval` (and `founding=true`). The API
holds a map from lookup key to price ID (PL-13). The worker never needs it: it reads the plan from
the subscription item's `price.lookup_key`. An item whose lookup key is not in the catalog makes
the subscription keep the plan it last had (lookup keys can move between prices). A live
subscription whose plan was never recognised (first sight with an unknown key) is held: its row keeps
no plan and status as Stripe answered, the tenant gets the limits of the lowest paid plan (`solo`,
monthly; never unlimited), the event ends `plan_held`, and the checkout action refuses a new
Checkout with 409 `plan_price_hold`. The worker opens the `cron_alerts` row `billing-plan-price`
in the same transaction (PL-10 text, no secret); every billing cron run mails it to `OPS_ALERT_EMAIL`
until a send is accepted. The hold is reconciled, and the alert closes when no tenant is held, as soon as a later
answer for that subscription names a known lookup key (Stripe is read again on every event for it)
or the subscription ends. An ended subscription with an unknown key still ends `mismatch` with no
plan. There is no operator action: fix the price's lookup key in Stripe, then any event for the
subscription reconciles it.

**PL-3. The plan record.** `plan_subscriptions` holds one row per Stripe subscription of a
tenant, as Stripe last answered it: status, plan, interval, founding, extra connections, trial
end, period end, `cancel_at_period_end`, start and end times, and `status_since` (when this
status was first seen). `tenant_plans` holds one row per tenant that has had a checkout, a
subscription or a founding invite: the Stripe customer ID (unique), `founding_invite`, and what
PL-10 derives from the subscriptions: the **effective** subscription and its fields, status
(`none` while there is no recognised subscription), `trial_used`, `founding_started_at`,
`payment_failed_at` and `read_only_after`. A tenant with no row, or with status `none` and no
`read_only_after`, is **comped**: no plan limits and never read-only.
`plan_checkouts` holds each started Checkout like `wallet_topups` holds top-ups.
`plan_invoices` holds one row per Stripe invoice the worker saw: `paid`, `failed` or `resolved`, and when it
first failed.

**PL-4. Starting Checkout.** `POST /v1/billing/plan/checkout { plan, interval, extraConnections }`
with an `Idempotency-Key`, owners only (`billing`), runs the action `plan.checkout.create` through
the dispatcher. `extraConnections` is 0 to 20, and above 0 only with `interval=month` (else 400).
The handler first takes the tenant's plan lock (a transaction advisory lock, PL-10). The action
inserts one `plan_checkouts` row
(`pending`) whose ID derives from the key. The price IDs, return URL and trial length reach the
handler as dispatch config from this route, never in the payload, so a caller cannot choose them
and the action cannot run from anywhere else (without the config it is 404). The handler picks,
from the tenant's own row: the founding price when `founding_invite` is set and the plan is Studio
or Pro (Solo never has one); a 14-day trial only when `trial_used` is false; and the stored
customer ID when there is one. It stores all of them with the checkout. A tenant whose plan is
`trialing`, `active` or `past_due` is refused (409 `plan_exists`): it changes plan in the Portal.
**One open checkout per tenant:** while another of the tenant's checkouts is `pending` and less
than an hour old, a new one is refused (409 `checkout_open`, with that checkout's stored URL when
there is one, so the dashboard can reopen it). So no second session carries a trial or a founding
price the first one already used.
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
ends, `trialAvailable` and `trialDays` (the trial a new Checkout would get), `cancelAtPeriodEnd`, `paymentFailedAt`, `readOnlyAfter`, `readOnly`, the limits in force,
the catalog with list prices, and founding prices only for an invited tenant; `checkoutEnabled`
and `portalEnabled` say whether the routes are on. A comped tenant answers status `none`.

**PL-8. Read-only and limits, on the one action path.** The dispatcher checks the plan record in
the action's own transaction, after an idempotent replay is answered and before the handler, for
every action of every principal. **Read-only** means `read_only_after` is set and at or before the
injected clock. A read-only tenant may run only: `plan.checkout.create`, `wallet.topup.create`,
`suppression.record`, the inbound and worker records (`sms.status.record`, `sms.reply.record`,
`voice.call.record`, `voice.voicemail.record`, `voice.textback.optin`, `transcription.job.complete`,
`transcription.job.fail`, `catalog.intake.result`, `catalog.intake.fail`, `media.variant.stage`,
`media.variant.fail`; not `voice.textback.optin`, which starts an outbound text), the stops (`agent.kill`, `agent.kind.kill`, `browser.kill`,
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
under `stripe.md` S-4 (one event per transaction, savepoint, backoff, `orphaned`), and first takes
the tenant's plan lock, so two events of one tenant never interleave. The tenant always comes from
our own rows: through `metadata.zs_tenant` and `zs_checkout` naming a `plan_checkouts` row of that
tenant, or through a stored subscription or customer ID. Anything not known yet waits (S-4
backoff). **An event only says which subscription to look at:** the worker reads it again with
`GET /v1/subscriptions/<id>` (PL-13 read key) and stores that answer, so the order and repeats of
events do not matter. Stripe unreachable is an error (S-4 retry); a subscription Stripe does not
know ends `not_ours`. An event that waits or ends `not_ours` writes nothing: its savepoint is rolled
back, so a retry starts from the same rows. Rules:
- `checkout.session.completed` with `mode=subscription`: marks the checkout `completed`, stores the
  customer ID on the tenant's record (creating the row) and reads the session's subscription.
  `checkout.session.expired` marks a pending checkout `expired`.
- `customer.subscription.*`: reads that subscription.
- `invoice.paid` marks the invoice `paid` (terminal: a later failure of the same invoice changes
  nothing). `invoice.payment_failed` marks it `failed` and keeps the earliest failure time (the
  event's `created`). Both then read the invoice's subscription.
- Storing a subscription sets its row from Stripe's answer. `status_since` changes only when the
  status does (to the end time Stripe gives for an ended one, else the worker's clock).
- After each event the worker derives the tenant's record from its rows alone. The **effective**
  subscription is the latest-started one in `trialing`, `active` or `past_due` with a recognised
  plan; with none, the latest-started recognised one. `payment_failed_at` is the earliest failure
  among the effective subscription's `failed` invoices while Stripe says it is `past_due` (so an
  invoice Stripe voided or forgave never counts), else null. When a `past_due` or `unpaid`
  subscription turns `trialing` or `active`, its `failed` invoices become `resolved`, so a later
  failure starts a fresh grace; a new failure of a `resolved` invoice counts from its new time. `read_only_after` is
  `payment_failed_at + grace` (or null) while the effective subscription is in one of those three;
  otherwise it is the `status_since` of the latest subscription in `canceled`, `unpaid`,
  `incomplete_expired` or `paused`, or null when none ever ended. So an `incomplete` replacement
  never lifts read-only, a paid invoice or a new paying subscription does, and replaying any event
  changes nothing. A second paying subscription is reported (`duplicate`) and the latest one wins.
- `trial_used` is true once the tenant has any subscription; `founding_started_at` is the start of
  its first founding subscription. When a founding subscription is first seen ended, the tenant
  loses `founding_invite`.

**PL-11. Founding.** An operator (service role, `setFoundingInvite`, like the other operator
scripts) sets `founding_invite` on a tenant; under a global advisory lock it refuses a 26th tenant
counted by `founding_invite` or `founding_started_at`. The server
alone chooses a founding price (PL-4); no founding price ID ever reaches a browser. When a
founding subscription is deleted, the tenant loses `founding_invite` and pays list price on its
next Checkout; its `founding_started_at` stays, so the slot stays used.

**PL-12. Tenancy and roles.** `tenant_plans`, `plan_subscriptions`, `plan_checkouts` and `plan_invoices` have
`tenant_id`, forced RLS, the tenant policy and are in the catalog isolation test, with a
two-tenant denial test under the runtime role. The runtime role reads its own tenant's rows; it may
insert a pending checkout through the action and update only its stored session URL; it never
writes `tenant_plans`, `plan_subscriptions` or `plan_invoices`. The worker names `tenant_id` in every statement.

**PL-13. Configuration.** API function (beside S-9): `STRIPE_PLAN_PRICES`, a JSON object from
every PL-2 lookup key to its `price_…` ID (all eleven, or the variable is refused);
`STRIPE_PLAN_RETURN_URL` (https, the dashboard's plan page); optional `STRIPE_PLAN_TRIAL_DAYS`
(0 to 30, default 14); optional `STRIPE_PORTAL_CONFIGURATION` (`bpc_…`). Plans are on only when
the S-9 Stripe variables and these are set; none of them is set on the workers project. Billing
function: `BILLING_STRIPE_KEY`, a restricted key that may only read subscriptions (`rk_…`, same
mode as `STRIPE_LIVEMODE`); without it plan events wait and end `orphaned`. Optional
`BILLING_STRIPE_BASE_URL` and `BILLING_PLAN_GRACE_DAYS` (1 to 30, default 7). Core reads none of them from
the environment; the entry points parse them and pass them in, with the clock.

**PL-14. Billing provider.** Shopify App Store policy requires a Shopify merchant to pay every
app-related fee, the extra-connection add-on included, through the Shopify Billing API. Other
tenants keep Stripe. So the plan record names its provider and nothing outside the Stripe code
assumes Stripe:
- `tenant_plans.billing_provider` is `stripe` (the default) or `shopify`. `plan_subscriptions`
  and `plan_invoices` carry a `provider` too; a subscription or invoice ID is unique per
  provider, and only a `stripe` row must look like a Stripe ID (`sub_…`, `in_…`).
- The PL-1 limits, the PL-8 gate and the PL-10 derivation read the plan, status and
  `read_only_after`, never the provider, so a later Shopify worker fills the same rows and the
  rest of the hub keeps working unchanged.
- A tenant whose provider is not `stripe` gets no Stripe Checkout (PL-4) and no Stripe Portal
  (PL-6): both answer 409 `billing_provider`. GET /v1/billing/plan (PL-7) shows
  `billingProvider` and reports Checkout and the Portal as off for it. The Stripe worker
  (PL-10) never resolves such a tenant from a stored customer or subscription, and a Stripe
  answer for it ends `not_ours`.
- Who sets `billing_provider`: an operator (service role), through `setShopifyBilling` (PL-17).

## Shopify billing (revision 3)

Evidence (shopify.dev, read 2026-11-07, in our own words; sources at the end of this section):
- App Store requirement 1.2: an app in the Shopify App Store bills every app charge through
  Shopify App Pricing or the Billing API. Off-platform billing is not allowed "unless you've
  been notified otherwise by Shopify". No published exemption covers an app that connects an
  outside service the merchant already pays for. The listing may link a page that describes
  charges billed outside Shopify, but that is a listing field, not an exemption. 1.2.3: the
  merchant changes plan without support and without reinstalling.
- Shopify App Pricing (renamed from Managed Pricing) is the default for new public apps. Plans,
  prices and the trial are set in the Partner Dashboard (listing > Pricing content). Shopify
  hosts the plan selection page at
  `https://admin.shopify.com/store/<store handle>/charges/<app handle>/pricing_plans`, creates
  the charge, and handles trials, proration, upgrades and downgrades. The app must not call
  `appSubscriptionCreate`. Up to eight public plans and any number of private plans (a store
  can be authorised for up to eight). Each plan can have a monthly and a yearly price, and a
  per-plan welcome link (an outside URL gets `plan_handle` and `shop` appended).
- Usage meters (App Events API, fixed, graduated or volume price) bill monthly only, cannot sit
  on a yearly-only plan, and have no usage cap. Events are accepted with 202 and any billing
  error shows only in the Dev Dashboard.
- Subscription state comes from the Partner API: `activeSubscription(appId, shopId)` answers the
  shop's current contract (billing period, `trialEndsAt`, `currentBillingCycle`,
  `cancelAtEndOfCycle`, `items[].handle`, `pendingUpdate`) or `null` when there is none. It needs
  a Partner API client with the **Manage apps** permission; the token is scoped to the Partner
  organisation, not to a store. Rate limit: four requests a second per client. Errors arrive as
  GraphQL errors (for example "Shop not found"), throttling as 429.
- Apps enrolled in App Pricing after 2026-04-28 get no `APP_SUBSCRIPTIONS_UPDATE` webhook and no
  `charge_id` on the redirect. Changes outside a redirect (cancel, freeze, uninstall) are read
  from the Partner API.
- Billing API (now "Manual Pricing", legacy): our own plan page and `appSubscriptionCreate`
  calls with the shop's Admin API token, and webhooks for status. Once an app opts in to App
  Pricing it cannot create new Billing API recurring charges.
- Our setup: the shop's OAuth token lives in Composio (connections.md), so our code holds no
  Admin API token. The prod app "ZS Business Connections" (Partner org 5300652, app
  444984655873) is set to Public distribution.

**PL-15. Shopify App Pricing, not the Billing API.** A tenant whose `billing_provider` is
`shopify` buys and changes its plan only on Shopify's hosted plan selection page. Our code never
creates a Shopify charge. Reasons: it is the default and recommended path for new public apps;
it needs no Admin API token, which Composio holds and which we would otherwise reach only
through its proxy; plan changes without support (1.2.3) are Shopify's page; and the Partner API
token is ours. No Stripe charge of any kind is made for such a tenant: no plan Checkout or Portal
(PL-14) and no wallet top-up (`wallet.topup.create` and the top-up session answer 409
`billing_provider`, stripe.md S-1). Its paid usage (texts, voice, lookups) is off until a rule
adds a Shopify usage meter; a wallet balance it already holds is still spent.

**PL-16. The Shopify catalog.** Set in the Partner Dashboard, from PL-1:
- Three public plans, Solo, Studio and Pro, each with the monthly and yearly list price of PL-1
  ($49 / $490, $99 / $990, $199 / $1,990), and a 14-day free trial. Shopify's own trial rules
  apply to a Shopify tenant (it counts trial days per shop), not PL-4's once-per-tenant rule.
- Two private plans, Studio Founding and Pro Founding ($69 / $690 and $139 / $1,390), each
  authorised by the operator for one store only after `setFoundingInvite` (PL-11) accepted that
  tenant, so the 25-place cap still counts it. When the operator ends an invite, they also remove
  the store's access to the private plan in the Partner Dashboard; the runner never clears
  `founding_invite` for a Shopify tenant, because it cannot tell a cancellation from a freeze.
- The extra-connection add-on is **not sold** to Shopify tenants in this revision. A Shopify
  tenant that needs more managed connections moves up a plan. Each plan's listing text names its
  connection limit (PL-1). An App Pricing usage meter can
  carry the add-on later (a new rule here first); it would be monthly only, with no cap.
- Each plan's welcome link is the relative path `/?plan=welcome` (2026-11-07), so Shopify opens
  the embedded app at `/shopify/app?plan=welcome` (connections.md C-29); the app reads the plan
  there. The dashboard's `?shopify=welcome` handling (PL-19) stays for a merchant who opens the
  hub's plan page.
- The Shopify plan handles map to our plans by configuration (PL-20): the five keys `hub_solo`,
  `hub_studio`, `hub_pro`, `hub_studio_founding` and `hub_pro_founding`, each to one handle. The
  interval comes from the contract's billing period: `EVERY_30_DAYS` is `month`, `ANNUAL` is
  `year`.

**PL-17. Linking a tenant to its shop.** An operator (service role, `setShopifyBilling`) sets a
tenant's `billing_provider` to `shopify` with the shop's GID (`gid://shopify/Shop/<n>`, unique
across tenants) and its `<name>.myshopify.com` domain, under the tenant's plan lock. Refusals, so
no tenant pays twice and no Stripe payment lands after the switch:
- 409 `stripe_plan_active` while a Stripe subscription of the tenant is not ended (any status but
  `canceled`, `unpaid`, `incomplete_expired`), or while a plan checkout of the tenant is
  `pending` and less than 24 hours old (a Checkout Session lives one hour; PL-5), or while any
  wallet top-up of the tenant is `pending`, whatever its age: a delayed payment method can settle
  a completed top-up Checkout days later (stripe.md S-2). Only Stripe's `checkout.session.expired`
  or `async_payment_failed` event, or an operator, closes one.
- 409 `shop_taken` when another tenant names the shop, or holds a row for it in
  `plan_subscriptions` (a shop's row ID is global). Moving a shop between businesses is an
  operator data change. 409 `shop_invalid` for a malformed GID or domain. The check runs under
  a lock on the shop too (taken after the plan lock), so two businesses linking one shop at once
  get one link and one `shop_taken`.
- 409 `shopify_plan_active` when the tenant already names another shop whose row is `trialing`
  or `active`. Relinking from an ended shop is allowed; the old row stays as history.
- Setting the provider back to `stripe` clears the shop and is refused (409
  `shopify_plan_active`) while the current shop's row is `trialing` or `active`.
A link does not change a comped tenant: it stays comped until a Shopify contract is seen.
Creating a top-up and the Stripe worker's checkout, subscription and invoice events take the
same plan lock before they read the provider, so a link and a new Stripe charge never both
commit. The lock key is the tenant ID in Postgres's own UUID spelling, so one tenant written in
upper or lower case takes one lock. The worker resolves the tenant from its stored Stripe rows
whatever its provider, and for a tenant another provider bills it ends `not_ours` (never `wait`,
so nothing is retried) before any write or Stripe call; it only marks a pending plan checkout
`expired` or `completed`, so the row never looks open, and a plan checkout or top-up start re-reads the provider before each Stripe call.
`tenant_plans` gains `shopify_shop_id`, `shopify_shop_domain`, `shopify_synced_at`,
`shopify_sync_failures` and `shopify_next_sync_at` (PL-18); a Shopify row in `plan_subscriptions`
must have a shop GID as its ID. The PL-10 derivation picks the effective subscription only among
rows of the tenant's current provider, and for `shopify` only the current shop's row; ended rows
of any provider still count for `read_only_after`. `tenant_plans.stripe_subscription_id` names
the effective subscription only when it is a Stripe one.

**PL-18. Reading the Shopify plan.** The billing runner (`/cron/billing`, stripe.md S-8), after
its Stripe passes, runs one Shopify pass when PL-20 is configured: up to
`BILLING_SHOPIFY_SYNC_LIMIT` linked tenants whose `shopify_next_sync_at` is null or due, least
recently synced first, until the runner's deadline. Calls are made one at a time, at least 500 ms
apart (two a second, half the Partner API limit, so a second overlapping runner stays under it).
Just before each call it re-reads the tenant without a lock and skips it, with no call, when
another run has synced it or stored a failure backoff since it was picked (link, shop,
`shopify_synced_at` and a due `shopify_next_sync_at` must still match), so overlapping runners
do not spend calls twice. For each tenant it asks `activeSubscription` for the tenant's shop while it holds no transaction,
connection or lock, so a slow Partner API never blocks the tenant's own actions. Then, in one
transaction under the tenant's plan lock, it re-reads the link (a tenant relinked, unlinked or
synced by another run since it was picked is skipped and the answer dropped), stores the answer as
that shop's row in `plan_subscriptions` (provider `shopify`, ID the shop GID), and derives the
record with the PL-10 derivation (the same code). With a deadline, a call starts only when at
least two seconds remain after the 500 ms pause (the pause follows a call, never a skip); the
call's timeout and the transaction's lock and statement waits are cut to the time left, keeping
one second for the commit, and never raised above the service defaults. With under two seconds
left the pass reads nothing. Every stored answer, `null` included, sets `shopify_synced_at` to the
clock and clears `shopify_sync_failures` and `shopify_next_sync_at`.
- A contract whose `trialEndsAt` is after the clock is `trialing`; any other contract is
  `active`. `trial_end` is `trialEndsAt`, `current_period_end` is the end of
  `currentBillingCycle`, `cancel_at_period_end` is `cancelAtEndOfCycle`, and
  `extra_connections` is 0.
- The plan is the first item whose handle is in the PL-16 map, and only together with a known
  billing period. Otherwise the outcome is `mismatch` (reported), and a row that is not ended keeps the plan and interval it had; a row that
  never had both ends `mismatch` and gives no plan (it still holds the status). A new contract
  after an ended row that names no known plan also ends `mismatch` but writes no row: the ended
  row stays, so the tenant stays read-only until a known plan is seen (overwriting it would
  leave the tenant comped, with no limits).
- `null` (no contract) turns a stored row that is not ended into `canceled`, with `ended_at`
  and `status_since` the clock. With no stored row, nothing is written. A contract seen after
  the row ended is a new one: `started_at` is the clock.
- The pass never takes an error for `null`: an unreachable Partner API, a GraphQL error, an
  `errors` field that is not a list, a malformed answer, an answer over 64 KiB or an answer for another shop writes
  nothing to the plan rows and is reported. It adds one to `shopify_sync_failures` and sets
  `shopify_next_sync_at` to the clock plus one minute doubled per failure, at most one hour, so
  failing shops never starve the others; that write applies only while the link and
  `shopify_synced_at` are still the ones picked, so an older failure never undoes a newer sync.
  Throttling (HTTP 429, or a GraphQL error "Too many requests" or code 429 in a 200 answer), 5xx,
  any other non-2xx status (a bad token, an unknown API version or a redirect: the same for every shop),
  an unreachable Partner API, an answer cut off mid-body and a database error also end the pass,
  except a lock or statement wait that runs out on one tenant (its plan lock held elsewhere): that
  tenant is counted as an error and backed off, and the pass goes on while time is left. The
  failure write takes no plan lock, so a stuck lock never keeps one tenant first in every pass.
  Reported text never carries the Partner token: upstream messages are cut to 200 characters with
  token-like strings removed. The Shopify pass starts only if the Stripe
  passes left time before the runner's deadline; the run summary carries it as `shopify`.
- Shopify handles failed payments itself (it freezes the store). The hub adds no grace for a
  Shopify tenant: a contract that disappears makes the tenant read-only as an ended Stripe
  subscription does (PL-10), and a contract seen again lifts it.
- Founding: a Shopify founding plan sets `founding_started_at` like a Stripe one, so the place
  stays counted (PL-11). `founding_invite` is left to the operator (PL-16).
- The PL-1 limits and the PL-8 gate read the same `tenant_plans` fields, so nothing else changes.
  The record lags Shopify by about the cron interval times the number of linked tenants divided
  by the sync limit. An uninstall cancels the contract; until the next read the tenant keeps its
  plan. On reinstall Shopify asks for a plan again (1.2.2) and the next read stores it.

**PL-19. API and dashboard for a Shopify tenant.** GET /v1/billing/plan (PL-7) adds
`shopifyManageUrl`: the plan selection page of PL-15 for the tenant's shop domain, when the
tenant is Shopify-billed, has a domain and `SHOPIFY_BILLING_APP_HANDLE` is set; otherwise null.
For a Shopify tenant, `checkoutEnabled` and `portalEnabled` are false and `trialAvailable` is
false (Shopify owns the trial). The API refuses its wallet top-ups (409 `billing_provider`,
PL-15), checked again before each Stripe call, a replay included. The plan conflict reasons
(`plan_exists`, `checkout_open` with its `checkoutUrl`, `checkout_closed`, `no_customer`,
`founding_full`, `billing_provider`) leave the API as documented reasons. The dashboard plan page
shows a Shopify tenant no Stripe plan buttons and no add-on field. It shows a **Manage billing in Shopify** link to `shopifyManageUrl` (with the plan
and without one), or, when it is null, the words "Open your Shopify admin, then Settings > Apps".
After `?shopify=welcome` (Shopify's own welcome link opens the embedded app instead, C-29) it reads the plan every 15 seconds for ten minutes, even when the plan
is already active (a change from one active plan to another keeps the status), and says a change
can take a few minutes to show. `plan_price_hold` (PL-2), `plan_read_only` and `plan_limit` (PL-8, with `resource`,
`limit` and `used` when valid) also leave the API as documented reasons.

**PL-20. Configuration.** Billing runner (workers project), all four or none (a partial set is
refused at start): `BILLING_SHOPIFY_PARTNER_ID` (the number in the Partner Dashboard URL),
`BILLING_SHOPIFY_PARTNER_TOKEN` (a Partner API client token with only Manage apps; it is not a
store token and reads every shop of the organisation, so it lives only on the billing function),
`BILLING_SHOPIFY_APP_ID` (the numeric app ID) and `BILLING_SHOPIFY_PLAN_HANDLES` (JSON from the
five PL-16 keys to handles, all five, distinct). Optional: `BILLING_SHOPIFY_SYNC_LIMIT` (1 to 100,
default 20), `BILLING_SHOPIFY_API_VERSION` (default `2026-10`) and `BILLING_SHOPIFY_BASE_URL`
(for tests: an https origin, or http on a loopback host only; default
`https://partners.shopify.com`). API function: optional
`SHOPIFY_BILLING_APP_HANDLE` (the app handle in the plan selection URL). No Stripe variable
changes. Core reads none of them from the environment.

Sources (fetched 2026-11-07):
- https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements (1.2, 1.2.1-1.2.3)
- https://shopify.dev/docs/apps/launch/billing
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing (plan page, welcome links,
  Partner API status, no webhooks after 2026-04-28, limitations)
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page
- https://shopify.dev/docs/api/partner/2026-07/active-subscription and
  https://shopify.dev/docs/api/partner/2026-07/objects/ActiveSubscription
- https://shopify.dev/docs/api/partner (authentication, Partner API clients, rate limits)
- https://shopify.dev/docs/api/app-events (client-credentials token for usage events)
- https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices (C. Pricing)

## Known limits (revision 3)

- **Before the listing is submitted:** an App Store install does not yet create or bind a hub
  tenant. A merchant who installs gets no tenant and no PL-17 link by itself, and the operator
  links by hand. App Store review installs the app, so an install path (verified shop, tenant,
  link, then the plan selection page) needs a rule in connections.md first.
- Shopify tenants cannot buy the extra-connection add-on (PL-16) or wallet usage (PL-15).
- A linked Shopify tenant that never chooses a plan is comped, as any tenant without a plan.
- A Shopify freeze is not told apart from a cancellation: both read as no contract (PL-18), so a
  frozen store's hub turns read-only until Shopify unfreezes it.
- `pendingUpdate` (a plan change at the next cycle) is not stored; the record changes when the
  contract does.
- A Stripe plan Checkout that completes after a PL-17 link (only possible past the 24-hour gate)
  is not applied; the operator refunds it in Stripe.
- A Stripe Portal session opened just before a PL-17 link commits stays usable for its short
  life. It cannot charge: the link needs every Stripe subscription ended, and the Portal starts
  none, so at most the owner edits a card or reads old invoices.
- A shop bills one business for good: its row ID is global, so moving a shop to another tenant
  is an operator data change (PL-17 `shop_taken`).

- A tenant that never subscribed is comped. Requiring a plan of new tenants needs a rule here.
- Bookable resources, model-assisted agents, voice, the agent daily cap and the email allowance
  are stated in PL-1 but not enforced by this revision.
- The add-on quantity is chosen at Checkout; the Portal cannot change a two-item subscription, so
  an owner with the add-on changes plan or quantity through support until a rule adds a route.
- Messages queued before a tenant turns read-only may still be sent by the delivery worker.
- Media uploads and transcription upload tickets that do not go through the dispatcher are not
  refused by PL-8; nothing they store is used until an action runs, and that action is refused.
- A second paying subscription (possible only through Stripe itself) is reported, not cancelled.
- The founding cap counts invites, not sign-ups; the operator invites.
