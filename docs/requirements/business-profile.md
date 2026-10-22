# Business profile

Status: draft contract, not built (2026-10-22). Code follows this file once its first slice
lands; a change to a numbered rule needs a new revision of this file first.

Scope: one profile per tenant that says who the business is: the name customers see, the legal
name, a phone number, a time zone, a default currency and a postal address. The owner edits it
in Account → Settings. Other features read it: the deal value field (BP-8), marketing footers
(`marketing-email.md`), and any screen that needs the business's own day rather than the
viewer's.

Out of scope: per-location profiles, tax settings, logos and brand colours, opening hours (the
booking resources keep their own zone and availability, `booking.md`), and changing the wallet
currency (fixed by its first credit, `stripe.md`).

## Evidence and decisions

- Audit 2026-10-22 (U1/U2 visual reviews, U2 follow-ups): the Settings screen shows "Business
  name" and "Time zone" fields that save nothing, because no settings route and no business time
  zone exist. `tenants` holds only `tenant_id` and `name`
  (`supabase/migrations/20261017150322_shared_actions.sql:28`). Fix PR #42 made the screen say
  plainly that nothing saves; this contract replaces that with a real profile.
- Audit V-20: the deal dialog takes Currency as free text next to real selects. Currency
  becomes a select of ISO 4217 codes, defaulting to the business profile's currency: decided
  2026-10-22 (coordinator, standing approval).
- `crm.md` C-14 and `inbox-home.md` H-1 already require deal currencies to be ISO 4217 codes and
  refuse to move a deal stored under another code (`invalid_currency`). This contract keeps that.
- Time zones follow the booking resources' rule: `UTC` or an IANA name the database knows
  (`booking_resources_time_zone_known`, `supabase/migrations/20261018090000_function_hardening.sql:10`).
- Deploy order: the API and the dashboard deploy on their own. `GET /v1/me?include=profile`
  (PR #42) showed the pattern: new response fields are opt-in or optional, and readers ignore
  unknown keys, so either deploy order works (BP-10).
- `marketing-email.md` needs a postal address before any marketing send; the profile is where
  it lives.

## Rules

**BP-1. One row per tenant.** `business_profiles(tenant_id PK → tenants, display_name,
legal_name, phone_e164, time_zone, currency, postal_address jsonb, revision, updated_by,
updated_at)` with forced RLS by `tenant_id`. The row is created with the tenant: `display_name`
copies `tenants.name`, `currency` is `USD`, every other field is null and `revision` is 1. A
migration backfills a row for every existing tenant.

**BP-2. Field shapes.** `display_name` 1..120 characters after trimming. `legal_name` null or
1..200. `phone_e164` null or an E.164 number (`+` and 8..15 digits). `time_zone` null or a zone
BP-3 accepts. `currency` a three-letter ISO 4217 code BP-4 accepts. `postal_address` null or
`{ line1, line2?, city, region?, postalCode?, country }` with `country` an ISO 3166-1 alpha-2
code and each line 1..120 characters. Text passes the repo's Postgres text check (no NUL, no
lone surrogates). A value outside these shapes is `ValidationFailed` with the field's path.

**BP-3. Time zone.** `UTC` or an IANA name in `pg_timezone_names`, checked by a trigger as
booking resources are. Null means "not set": screens then use the viewer's zone for display and
booking resources keep their own zone. Setting it never changes a resource's zone, a booking, a
quiet-hours setting or a stored instant.

**BP-4. Currency.** An active ISO 4217 code from one list shared by the contracts package and
the dashboard (`packages/contracts/src/currency.ts`, generated from a pinned ISO list, not from
the runtime's `Intl`), so the API and every browser agree. Changing it changes only the default
for new values (BP-8); it never converts or rewrites a stored amount, a deal value or the
wallet.

**BP-5. Read.** `GET /v1/business` returns the profile and its `revision` to any member of the
tenant (staff need the time zone and currency to work the calendar and deals). `phone_e164` and
`postal_address` are included; nothing else about the tenant is.

**BP-6. Write.** `business.profile.update` with `{ expectedRevision, changes }`, where `changes`
holds only the fields being set (a field set to null clears it, except `display_name` and
`currency`, which cannot be null). Owner only: it needs a new `business` permission that
staff do not hold (`packages/contracts/src/members.ts`). It runs through the dispatcher with an
idempotency key like every action, so a replay returns the first result.

**BP-7. Compare and set.** The update applies only when `expectedRevision` equals the stored
revision, then increments it. Otherwise it is `Conflict` with `details.reason =
"stale_revision"` and `details.currentRevision`, and the dashboard reloads the saved values and
says someone else changed them, as the deal dialog does.

**BP-8. Currency select (audit V-20).** The deal dialog's Currency field is a select of the
BP-4 codes, labelled with the code and its English name ("EUR · Euro"). A deal with no value
starts at the profile's currency; a deal with a value shows its stored currency. A stored code
that is not in the list (an old deal) shows as an extra option marked "not supported", and
saving a value under it is refused, matching C-14's `invalid_currency`.

**BP-9. Display name.** `display_name` is the name the dashboard header, the account menu and
`GET /v1/me?include=profile` show as `businessName`. Updating it also updates `tenants.name`
in the same transaction, so older readers see the same name.

**BP-10. Deploy order.** New response fields are optional for readers; the dashboard treats a
missing `GET /v1/business` (404 from an older API) as "profile not available yet" and keeps the
Settings form read-only with that reason. The API never requires a field an older dashboard
does not send.

**BP-11. Demo mode.** The demo adapter stores the profile in its in-memory store, so Save
works there and says it is sample data that resets, never "saved to your business".

**BP-12. Tenancy.** A member of tenant A cannot read or update tenant B's profile through the
route, the action or direct SQL as the runtime role: a two-tenant denial test covers all three.

## First slice

Migration (`business_profiles`, backfill, time zone trigger, RLS), the currency list in
contracts, `GET /v1/business`, `business.profile.update` with the `business` permission, the
Settings form wired to both, and the deal dialog's currency select.

Acceptance test: an owner saves legal name, time zone `Europe/London` and currency `EUR`; the
response carries revision 2 and `GET /v1/business` returns the values. A second save with
`expectedRevision: 1` is `Conflict` `stale_revision` with `currentRevision: 2`. A staff member's
save is 403. Time zone `Mars/Base` and currency `XXZ` are `ValidationFailed` with their paths.
A new deal's currency select starts at `EUR`; an existing USD deal still shows USD. Tenant B
cannot read tenant A's profile. The dashboard e2e saves the form in demo mode and the Home
header shows the new display name.

## Known limits

- Opening hours and per-location details stay on booking resources.
- Changing the profile currency does not touch the wallet; a tenant whose wallet is in another
  currency sees prices in the wallet's currency (`delivery.md` D-5).
- The Home screen still shows the viewer's zone for dates; moving business-day logic (for
  example "today" on Home) to the profile zone is a later revision of `inbox-home.md`.
