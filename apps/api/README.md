# @zs/api

HTTP API over `@zs/core` (Hono on Node 24). Every write goes through the one action
dispatcher; every read runs as the runtime role under row-level security.

## Run locally

Use the local test cluster on port 55432 (never a Supabase or Rise Scheduler database).

```sh
# 1. Create a dev database on the local cluster.
psql postgres://postgres@127.0.0.1:55432/postgres -c 'CREATE DATABASE zs_dev'

# 2. Apply supabase/migrations (packages/db/src/migrate.ts). Loopback URLs only.
DATABASE_URL=postgres://postgres@127.0.0.1:55432/zs_dev mise exec -- pnpm --filter @zs/api db:migrate

# 3. Make a local env file with a real secret; the API and seed refuse the placeholder.
#    The example env sets JWT_VERIFIER=hs256, as local tokens are HS256.
sed "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" apps/api/.env.example > apps/api/.env
set -a; . apps/api/.env; set +a

# 4. Seed the demo jeweler and print a 7-day dev JWT. It also runs migrations, makes sure
#    the unprivileged zs_runtime login exists, installs the local auth stub (auth.users,
#    auth.sessions), adds the owner (owner@example.com) as a member and starts a session for
#    the token. JWT_SECRET must match the API's.
DATABASE_URL=postgres://postgres@127.0.0.1:55432/zs_dev mise exec -- pnpm --filter @zs/api seed:demo

# 5. Start the API as the runtime role. The example env sets JWT_MAX_TTL_SECONDS=604800 so the
#    7-day dev token works; the default is one hour.
mise exec -- pnpm --filter @zs/api start

curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/v1/crm/contacts
```

`seed:demo` refuses any `DATABASE_URL` that is not `127.0.0.1` or `localhost`. It is
idempotent: fixed IDs and idempotency keys replay instead of duplicating. Bookings are made
only on the first run, from that day's free slots.

Demo tenant: "Halden & Rowe Fine Jewelry" (invented), with a showroom calendar and a
repair-intake calendar (America/New_York), 12 contacts, a pipeline (Inquiry, Consultation,
Design, Deposit, Delivered; Delivered has outcome `won`), 8 deals (four with a USD value and a
lead source; the delivered one is won on the seed's clock) and 6 bookings. A rerun also sets
the won stage's outcome on a database seeded before stage outcomes existed.

## Provision the first owner

The API refuses every request from a user without a `tenant_members` row, and only owners
invite. A tenant that existed before `20261019090000_members_and_sessions.sql` (the hosted
pilot tenant) therefore has nobody who can act or invite. The database holds no
tenant-to-email data, so the migration cannot backfill an owner; the owner of the
deployment names the person with this owner-run step (`src/provision-owner.ts`):

```sh
# Report what would change, then roll back.
DATABASE_URL=postgres://postgres@127.0.0.1:55432/zs_dev mise exec -- pnpm --filter @zs/api \
  db:provision-owner --tenant <tenant uuid> --email owner@example.com --dry-run
# Apply. --receipt must not exist yet: it is reserved before any database work and always
# records the outcome (result, failed phase, redacted error, committed true/false/"unknown").
DATABASE_URL=postgres://postgres@127.0.0.1:55432/zs_dev mise exec -- pnpm --filter @zs/api \
  db:provision-owner --tenant <tenant uuid> --email owner@example.com --apply --receipt owner-receipt.json
```

One service_role transaction under the tenant's exclusive membership lock. The email is
trimmed and lowercased (the members schema). Without a member for that email it adds an
owner, bound to the Supabase user with that email when one exists, else pending: create the
user (or let them sign up) and run it again to bind. With a member for that email it binds a
pending row, and promotes staff to owner only when the tenant has no active (bound) owner;
otherwise it refuses, since owners change roles in the app. It refuses an unknown tenant, a
row bound to a different user, and a user already bound to another member of the tenant. A
second run reports `unchanged`. A dry run of a new owner shows a member id that the real run
replaces. Output and receipts hold ids, names and role facts only.

Every token must carry the tenant in `app_metadata.tenant_id`, which only the server can set.
Before its transaction commits, the step sets that claim on the bound user (keeping other
`app_metadata` keys) and refuses a user whose claim already names another tenant. The user
signs in again to get a token with the claim. If setting the claim fails, the row rolls back
and a re-run starts over; a claim that is gone from an existing row is set again (`claimed`).
Runs for the same Supabase user take a per-user advisory lock before the tenant's lock and
re-read the claim under it, so two runs for two tenants cannot both bind one user: the second
is refused. An `--apply` run reads both the row and the claim back.

Locally the Supabase user is looked up, and given the claim, in the auth stub's `auth.users`.
Hosted, `db:hosted-provision-owner` (`src/hosted-provision.ts`) runs the same step with the
Supabase Auth admin API in place of the stub; see "Hosted deploy", step 4.

## Environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | API: the runtime LOGIN role (`zs_runtime`); the API refuses to start as a superuser or BYPASSRLS role. Scripts: the local admin URL. |
| `JWT_VERIFIER` | Required: how access tokens are verified. `hs256` (the legacy Supabase JWT secret, needs `JWT_SECRET`) or `jwks` (asymmetric Supabase signing keys, ES256/RS256, needs `JWT_JWKS_URL`). Anything else, or none, is refused. |
| `JWT_SECRET` | `hs256` only, and `seed:demo`: HS256 secret for Supabase-style access tokens (32+ characters). The `.env.example` placeholder is refused. |
| `JWT_JWKS_URL` | `jwks` only: the project's JWKS, `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`. Must be https; plain http only on `127.0.0.1`, `[::1]` or `localhost` (local tests). |
| `JWT_ISSUER` | Optional. When set, tokens must carry this `iss`. |
| `JWT_MAX_TTL_SECONDS` | Longest accepted token lifetime (`exp` minus `iat`), default 3600. Local dev sets 604800 so the 7-day seed token works for seed and dashboard e2e; production keeps the default. |
| `JWT_CLOCK_SKEW_SECONDS` | How far a token's `iat` may lie ahead of the API's clock, 0 to 300, default 60. |
| `SESSION_CHECK` | Required: how a token's session is checked. `supabase` (every hosted deploy) asks Supabase Auth and needs `SUPABASE_URL` and `SUPABASE_ANON_KEY`. `local-stub` asks the loopback auth stub and is refused unless `DATABASE_URL` is on loopback. |
| `SUPABASE_URL` | `supabase` only: `https://<project>.supabase.co`. Must be https; plain http only on loopback. |
| `SUPABASE_ANON_KEY` | `supabase` only: the project's anon (publishable) key, sent as `apikey`. |
| `SESSION_CACHE_SECONDS` | `supabase` only: how long a live answer is reused, 0 to 30, default 5. A sign-out is refused within this long. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins, for example the dashboard dev server. |
| `PORT` | Listen port, default 8787. |
| `DATABASE_CONNECT_TIMEOUT_MS` | Longest wait for a pooled connection, default 5000. Past it the request is 503. |
| `REQUEST_TIMEOUT_MS` | Longest time a `/v1`, `/public/v1`, `/webhooks` or `/oauth` request may take, default 10000 (under the dashboard proxy's 15 s). Past it the request is 503. |
| `RUNTIME_DATABASE_URL` | Seed only, optional: runtime login URL; defaults to `DATABASE_URL` as `zs_runtime`. |
| `DATABASE_CA_CERT` | PEM. When set, the pool verifies the server against it (`rejectUnauthorized`). Required whenever `DATABASE_URL` is not a loopback host (`127.0.0.1`, `::1`, `localhost`), so a hosted API never falls back to plain TCP; only a loopback database runs without TLS. A non-loopback URL, or any URL with a CA, must carry no query string, because pg lets URL ssl options (`sslmode=no-verify`, `ssl=false`, a `host` override) replace the config. Hosted: `supabase/hosted/supabase-root-2021-ca.crt`. |
| `DATABASE_POOL_MAX` | Pool size per process, 1 to 50, default 10. Vercel sets 3: each serverless instance has its own pool. |
| `PUBLIC_BOOKING_KEY_SECRET` | Signs public booking page keys (32+ characters; the `.env.example` placeholder is refused). Unset, the public booking routes are off. |
| `PUBLIC_BOOKING_KEY_PREVIOUS_SECRET` | Optional, during a key rotation: keys signed with it still verify. |
| `PUBLIC_BASE_URL` | Public origin of the booking page and embed script, default `http://localhost:<PORT>`. |
| `PUBLIC_CLIENT_IP_HEADER` | Optional: a header the host overwrites on every request (Vercel: `x-vercel-forwarded-for`), used for the per-address limits. Only when the API is reachable through that host alone. |
| `PUBLIC_TRUSTED_PROXIES` | Optional, instead of the header: comma-separated CIDRs whose `X-Forwarded-For` entries count. |
| `PUBLIC_RATE_ADDRESS_WRITES`, `PUBLIC_RATE_ADDRESS_READS`, `PUBLIC_RATE_TENANT_WRITES` | Optional overrides of the public rate limits. |
| `UNSUBSCRIBE_TOKEN_SECRET` | Verifies the email unsubscribe tokens that the delivery worker signs with the same secret (32+ characters; the `.env.example` placeholder is refused). Unset, the unsubscribe routes are off. They use `PUBLIC_CLIENT_IP_HEADER` or `PUBLIC_TRUSTED_PROXIES` and the `PUBLIC_RATE_ADDRESS_*` limits, counted in their own buckets. |
| `UNSUBSCRIBE_TOKEN_PREVIOUS_SECRET` | Optional, during a rotation: links signed with it still verify. |
| `RESEND_WEBHOOK_SECRET` | The signing secret of the Resend webhook endpoint, as Resend shows it (`whsec_` then base64, at least 24 bytes). Anything else is refused. Unset, `POST /webhooks/resend` is off. |
| `RESEND_WEBHOOK_PREVIOUS_SECRET` | Optional, during a rotation: events signed with it still verify. Needs `RESEND_WEBHOOK_SECRET`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_LIVEMODE`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | Stripe wallet top-ups (stripe.md S-9), all or none. None set: top-ups and `POST /webhooks/stripe` are off. A secret or restricted key (`sk_`/`rk_`), the endpoint's `whsec_` secret, `true` or `false` matching the key's mode, and https return URLs. |
| `STRIPE_WEBHOOK_PREVIOUS_SECRET`, `STRIPE_CURRENCY`, `STRIPE_TOPUP_MIN`, `STRIPE_TOPUP_MAX`, `STRIPE_API_VERSION`, `STRIPE_BASE_URL` | Optional: a rotation secret, `usd`, 500 and 50000 minor units, the account's default API version, `https://api.stripe.com`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`, `GOOGLE_RETURN_URL`, `GOOGLE_STATE_SECRET`, `GOOGLE_TOKEN_PUBLIC_KEY`, `GOOGLE_CHANNEL_SECRET` | Google Calendar busy sync (google-calendar.md G-12), all or none. None set: connecting, `GET /oauth/google/callback` and `POST /webhooks/google/calendar` are off. The OAuth web client's ID and secret; `https://<api host>/oauth/google/callback` (also registered in Google Cloud); the dashboard page the callback lands on; a state signing secret (32+ characters); base64 of the DER SPKI of the X25519 key whose private half only the calendar runner holds; the push channel secret (32+ characters, the same as the runner's). URLs must be https (plain http only on loopback). |
| `GOOGLE_STATE_PREVIOUS_SECRET`, `GOOGLE_OAUTH_BASE_URL`, `GOOGLE_TOKEN_BASE_URL`, `GOOGLE_API_BASE_URL` | Optional: a rotation secret (states it signed keep verifying for their 10 minutes), and base URLs for tests (`https://accounts.google.com`, `https://oauth2.googleapis.com`, `https://www.googleapis.com`). |

Only `src/main.ts`, `src/vercel.ts` and the `src/scripts/*` entry points read the
environment or the system clock. Everything else gets them through `createApp(deps)`.
Both servers build the app with `createServer(env, clock)` (`src/server.ts`), which checks
the runtime login before it serves.

## Auth

`Authorization: Bearer <JWT>`, verified like a Supabase Auth access token: signature, `exp`,
`aud = authenticated`, `role = authenticated`, `iss` when `JWT_ISSUER` is set, and a required
`iat`. A token whose `iat` is more than `JWT_CLOCK_SKEW_SECONDS` ahead of the clock is refused,
and its lifetime (`exp` minus `iat`) must be at most `JWT_MAX_TTL_SECONDS`. Within the skew, a
full-lifetime token from an issuer whose clock runs slightly ahead is still accepted.
`sub` is the actor, `app_metadata.tenant_id` is the tenant the token claims and `session_id`
(required) is the Supabase Auth session.

Then, on every request:

1. **Live session.** The session check must say the token's Supabase session is still live.
   Otherwise 401 `Unauthorized`. Supabase deletes the session on sign-out, so a token is
   refused after sign-out, not at its `exp`. With `SESSION_CHECK=supabase` the API calls
   Supabase Auth `GET /auth/v1/user` with the caller's own token and the anon key: 200 with
   the token's user (not banned, not deleted) is live; 401, 403 or 404 is ended. Any other
   answer, a timeout or a network error fails closed with 503 `Unavailable`, never 401, so the
   dashboard keeps its cookies through an outage. Only live answers are cached, for
   `SESSION_CACHE_SECONDS` (default 5, at most 30, never past the token's `exp`), keyed by a
   hash of the token. Hosted Supabase keeps `auth.*` to itself, so no migration grants on it
   and the runtime role never reads it. `SESSION_CHECK=local-stub` asks
   `zs_local_auth.session_is_live` from the loopback auth stub (`@zs/db/local-auth`) that tests
   and `seed:demo` install; its tables have RLS on and no policies, as on hosted Supabase.
2. **Membership.** In one transaction, `tenant_members` must hold an active row for `sub` in
   the claimed tenant. Otherwise 403 `Forbidden`, answered like another tenant's row. A
   removed member is refused on the next request, including a replay of an earlier
   idempotency key: the check runs before the replay lookup.
3. **Role.** The member's role must allow the route. `owner` may do everything: members,
   billing, plan, publish (booking page keys and embed snippets) and intake (website request
   review). `staff` may use the calendar, customers and inbox drafts (`ROLE_PERMISSIONS` in
   `@zs/contracts`); deciding approvals, which sends replies (`approve`), and Home results
   (`reports`) are owners only. Otherwise 403. The anonymous `/public/v1` routes take no token: a signed
   booking page key names the tenant, and they may run the one public action only. Likewise a
   signed unsubscribe token names the tenant and delivery, and may record one suppression only.

Member writes hold an exclusive per-tenant advisory lock and every other request a shared
one, so a role change or removal is never interleaved with a request it affects.

The signing method is explicit config, never inferred from the token: `JWT_VERIFIER=hs256`
accepts only HS256 tokens signed with `JWT_SECRET`; `JWT_VERIFIER=jwks` accepts only ES256 or
RS256 tokens signed by a key in `JWT_JWKS_URL` (fetched and cached by `jose`'s
`createRemoteJWKSet`), so an HS256 token is refused there and an ES256 token under `hs256`.
When the JWKS cannot be fetched (a timeout, a network error, a non-200 answer or a body that
is not a JWKS) the API answers 503 `Unavailable` with `Retry-After`, not 401: the token was
never judged, so the dashboard keeps its cookies. 401 stays for bad signatures, unknown keys
and bad claims.
`parseServerEnv` parses the `JWT_*` variables with `jwtEnvSchema` from `@zs/core` and `main.ts`
builds the verifier with `createVerifierFromConfig(env.jwt, clock)`.

The verifiers (`createHs256Verifier`, `createJwksVerifier`) and the steps above live in
`@zs/core` (`edge/auth.ts`, `edge/session-check.ts`, and
`authenticate(deps, verifier, sessionCheck, token)` in `edge/authenticate.ts`), so the MCP server runs exactly the same checks on every tool call.
`src/auth.ts` re-exports them.

## Routes (`/v1`, JSON)

| Method and path | Result |
|---|---|
| `GET /healthz` | `{ ok: true }`, no auth. Liveness: the process answers. |
| `GET /readyz` | `{ ok: true }`, or 503 when a bounded `SELECT 1` fails. No auth. |
| `GET /v1/booking/resources` | `{ items: ResourceSummary[] }` |
| `GET /v1/booking/slots?resourceId&from&to[&zone]` | free slots; `from`/`to` are UTC instants with milliseconds, at most 31 days |
| `GET /v1/booking/bookings?[resourceId&][from&][to&]limit&(cursor|offset)` | page of bookings in start order; with `from`/`to`, only those overlapping `[from, to)` |
| `POST /v1/booking/bookings` `{ resourceId, startsAt }` | 201 booking; 409 if the slot is taken |
| `GET /v1/crm/contacts?[search&][sort&][ids&]limit&(cursor|offset)` | page of contacts, newest first or `sort=name`; `search` matches part of a name, email or phone; `ids` is up to 100 comma-separated IDs |
| `GET /v1/crm/contacts/:id` | one contact; 404 if unknown or another tenant's |
| `POST /v1/crm/contacts` `{ displayName?, email?, phone?, mode?, consent? }` | 201 created, 200 matched an existing contact |
| `GET /v1/crm/pipelines` | `{ items: PipelineSummary[] }` with ordered stages, each with its `outcome` (`open`, `won`, `lost`) |
| `GET /v1/crm/deals?[pipelineId&][contactId&]limit&(cursor|offset)` | page of deals (`DealSummary`: the deal plus `value` `{ amountMinor, currency }` or null, `leadSource`, `wonAt`), most recently updated first |
| `POST /v1/crm/deals` `{ contactId, pipelineId, stageId, title }` | 201 deal |
| `POST /v1/crm/deals/:id/stage` `{ pipelineId, stageId, expectedRevision }` | 200 deal; 409 `stale_revision`. Entering a `won` stage sets `wonAt` to the write's time; leaving it clears it |
| `POST /v1/crm/deals/:id/details` `{ expectedRevision, value, leadSource }` | 200 `DealSummary`, revision + 1; 409 `stale_revision` with `currentRevision`. `value` is null or `{ amountMinor, currency }` (ISO 4217); `leadSource` null or `website`, `referral`, `phone`, `email`, `walk_in`, `social`, `ads`, `other`. Owners and staff |
| `GET /v1/inbox/threads?limit&(cursor|offset)` | page of `ThreadSummary`, latest activity first: one `customer` thread (`c_<contactId>`) per contact with a website request or a reply that is not discarded, one `visitor` thread (`v_<intakeItemId>`) per request not linked to a contact. Owners and staff |
| `GET /v1/inbox/threads/:threadId` | the summary plus `phone`, `entries` (requests and replies, oldest first, the latest 200) and `olderEntries`; 400 for a malformed ID, 404 for an unknown or another tenant's thread. Owners and staff |
| `POST /v1/inbox/replies` `{ contactId, body, subject? }` | 201 draft reply (body 1..5000 characters, subject one line 1..200, default "Message from <business name>"), plus a pending approval to send it (`inbox.reply.send`, see `/v1/approvals`); 403 for another tenant's contact. Owners and staff |
| `POST /v1/inbox/replies/:id/approve` `{}` | 200 approved reply: approves the reply's open approval (proposing a new one if it expired or was withdrawn) and runs the send as this owner, writing one outbox event `message.send_requested` with the exact subject and text; a same-key retry replays. 409 `not_draft` (with `status`), `no_email`, or `approved_by_other` (with `approvedBy`) when another owner approved it and must finish the send. Owners only. Nothing is sent here (M3d) |
| `POST /v1/inbox/replies/:id/discard` `{}` | 200 discarded reply, and its pending approval withdrawn where the caller may; 409 `not_draft` (with `status`). Owners and staff |
| `GET /v1/home/results?[zone&][weekStart]` | `HomeResults`: leads, bookings, won deals and revenue by source, this week so far against the same span of last week; `zone` an IANA zone (default `UTC`), `weekStart` `monday` (default) or `sunday`; both ranges as UTC instants from the injected clock. Owners only |
| `GET /v1/me` | `{ tenantId, userId, memberId, role, permissions }`, any member |
| `GET /v1/members` | `{ items: Member[] }`, owners only |
| `POST /v1/members` `{ email, role }` | 201 pending invite (no user yet); 409 `member_exists`; owners only |
| `POST /v1/members/:id/role` `{ role }` | 200 member; 409 `last_owner` when it would leave no owner; owners only |
| `DELETE /v1/members/:id` | 200 removed member; 409 `last_owner`; owners only |
| `GET /v1/wallet` | `{ currency, balance, reserved, available }` in minor units (`walletSummarySchema`); all zero before the first credit; owners only (`billing`) |
| `GET /v1/wallet/top-ups` | `{ items: TopUp[] }`, newest first, at most 20; owners only |
| `POST /v1/wallet/top-ups` | `{ amount }` in minor units with `Idempotency-Key`: 201 `{ topup, checkoutUrl }` (stripe.md S-1, S-2). The same key replays the same top-up and Checkout Session. 409 `topup_closed` once the top-up is no longer pending or 25 minutes old; 409 `wallet_currency` when the wallet already holds another currency; 503 when Stripe is unreachable or busy (retry with the same key); 404 when Stripe is not configured. Owners only |
| `GET /v1/calendar/connections` | `{ items: CalendarConnection[] }`, newest first, at most 100: `{ id, provider, resourceId, calendarId, accountEmail, status, lastSyncedAt, lastError, createdAt }`, never a token (google-calendar.md G-5). Owners and staff |
| `POST /v1/calendar/google/connect` `{ resourceId }` | With `Idempotency-Key`: 200 `{ authorizeUrl }`, `Cache-Control: no-store` (G-1). Changes nothing: send the browser there. The connection ID derives from the tenant and the key; the URL carries a signed state (10 minutes) and a PKCE challenge. 409 `idempotency_key_reused` once the key's connection exists for another resource or is no longer active; 403 for another tenant's resource; 404 when Google is not configured. Owners only (`publish`) |
| `POST /v1/calendar/connections/:id/disconnect` | With `Idempotency-Key`: 200 `{ actionId, result: CalendarConnection }` (G-5). `active` or `reauthorize` becomes `disconnecting` (the calendar runner revokes the grant and removes its blocks); `disconnecting` and `disconnected` answer as they are. 404 for an unknown or another tenant's connection. Owners only |

Staff cannot invite, remove or change roles, including their own. An invite is a pending row
with no `user_id`; the runtime role cannot set `user_id` (binding an invite to a signed-up
user is M2b's invite worker).

A page is `{ items, limit, offset, nextOffset, nextCursor }`. Pass `nextCursor` back as
`cursor` for the next page: it names the last row returned, so rows added or moved ahead of
it while you page are neither repeated nor skipped, which `offset` cannot promise. A cursor
belongs to one list and sort; it is not combined with `offset`.

Every `POST` and `DELETE` needs an `Idempotency-Key` header (1-200 characters). Repeating a request with
the same key returns the stored result with the original status; reusing a key with a
different body, or on another endpoint, is 409 `idempotency_key_reused`. Keys are per tenant.
Target IDs derive from the tenant and the key.

Errors always use `apiErrorBodySchema` from `@zs/contracts`:
`{ "error": { "code", "message", "details" } }`. Codes and statuses: `ValidationFailed` 400,
`Unauthorized` 401, `Forbidden` 403 (another tenant's row or an unknown ID, answered alike),
`NotFound` 404, `Conflict` 409 (`details.reason`: `slot_unavailable`, `overlap`,
`stale_revision`, `id_in_use`, `idempotency_key_reused`, `binding_mismatch`,
`concurrent_update`, `split_identity`, `identity_mismatch`, `last_owner`, `member_exists`,
`disclosure_changed`, `already_reviewed`, `not_draft` (with the reply's `status`), `no_email`, `approved_by_other` (with `approvedBy`);
anything else is `conflict`),
`Internal` 500 with no internal detail, `Unavailable` 503 with `Retry-After: 1`. Each code has
one fixed `message`.

## Unsubscribe (`/public/v1/unsubscribe/:token`, no auth)

Every email carries `List-Unsubscribe: <…/public/v1/unsubscribe/zsu1_…>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (delivery.md D-9). On only when
`UNSUBSCRIBE_TOKEN_SECRET` is set.

| Method and path | Result |
|---|---|
| `GET /public/v1/unsubscribe/:token` | 200 HTML confirmation with a form that posts back to the same URL. Changes nothing, since mail scanners fetch links. |
| `POST /public/v1/unsubscribe/:token` | RFC 8058 one-click: suppresses the address that delivery went to, then 200 HTML "You are unsubscribed". The body is not required: `List-Unsubscribe=One-Click` (form-urlencoded or multipart), the page's form or an empty body all work. A repeat replays the stored action (one suppression, one action). |

Both answer HTML on success, whatever `Accept` says; errors use the shared JSON error shape. A
forged token, another tenant's delivery, an SMS delivery or one with no pinned address all get
the same 404 `NotFound` body as other public routes. Before any database work each request
spends one count from the caller's address bucket (reads and writes apart, limits from
`PUBLIC_RATE_ADDRESS_*`); past the limit it is 429 `RateLimited` with `Retry-After`. Bodies
are capped at 8 KiB (413). Responses are `Cache-Control: no-store`,
`Referrer-Policy: no-referrer`, and the page loads nothing from anywhere (CSP
`default-src 'none'`, its one inline style pinned by hash, no script).

## Resend webhook (`/webhooks/resend`, no auth)

Resend posts email events here (resend.md R-7, R-8). On only when `RESEND_WEBHOOK_SECRET` is
set. Subscribe the endpoint to `email.bounced`, `email.complained` and `email.suppressed`;
other email events are acknowledged and change nothing.

The route checks the Standard Webhooks signature (`svix-id`, `svix-timestamp`,
`svix-signature`, or the `webhook-*` names) over the raw body before it parses anything or
touches the database. `RESEND_WEBHOOK_PREVIOUS_SECRET` also verifies during a rotation. A
timestamp more than 5 minutes from the API's clock is refused.

| Event | Effect |
|---|---|
| `email.bounced`, permanent (or no bounce type) | Suppresses the address as `bounce`. |
| `email.bounced`, transient or undetermined | Nothing. |
| `email.complained` | Suppresses the address as `complaint`. |
| `email.suppressed` | Suppresses the address as `bounce`. |

The tenant and delivery come from the email's tags (`zs_tenant`, `zs_delivery`), set when the
delivery worker sent it. They are checked against the `message_deliveries` row under that
tenant's own scope: the provider must be `resend`, the event's `to` must hold the delivery's
recipient address, and a recorded Resend ID must equal the event's `email_id`. The address
suppressed is the delivery's own, with source `resend:<event type>:<delivery id>`. A
redelivery with the same `svix-id` replays the stored action (one suppression, one action).

| Answer | When |
|---|---|
| 401 `Unauthorized` | Missing, wrong or stale signature. One body for all of them. |
| 400 `ValidationFailed` | Signed, but the body is not JSON. |
| 413 `ValidationFailed` | Body over 256 KiB. |
| 200 `{"handled":true}` | The suppression is recorded, or replayed. |
| 200 `{"handled":false,"reason":…}` | Signed, but nothing to do: an event that suppresses nothing, a shape it does not read, no tags, or no matching delivery. Resend does not retry it. |

## Stripe webhook (`/webhooks/stripe`, no auth)

Stripe posts events here (stripe.md S-3). On only when the `STRIPE_*` variables are set.
Subscribe the endpoint to `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
`charge.dispute.funds_withdrawn` and `charge.dispute.funds_reinstated`.

The route checks `Stripe-Signature` over the raw body (current or previous secret, 5 minutes of
tolerance) before it parses anything or touches the database, then stores the event once by
its ID in `stripe_events`. It moves no money: the billing runner does (below).

| Answer | When |
|---|---|
| 401 `Unauthorized` | Missing, wrong or stale signature. One body for all of them. |
| 400 `ValidationFailed` | Signed, but not a Stripe event. |
| 413 `ValidationFailed` | Body over 256 KiB. |
| 503 `Unavailable` | The database did not answer; Stripe delivers it again. |
| 200 `{"received":true,"stored":…}` | Stored, already stored, or from the other mode (dropped). |

## Google OAuth callback (`/oauth/google/callback`, no auth)

Google sends the owner's browser here after the consent screen (google-calendar.md G-2). On only
when the `GOOGLE_*` variables are set. The request is anonymous: what it may do comes from the
signed `state` alone (tenant, member, resource, connection ID, 10-minute expiry; current or
previous `GOOGLE_STATE_SECRET`). With a valid state it exchanges the code with the PKCE verifier
derived for that connection, seals the refresh token with `GOOGLE_TOKEN_PUBLIC_KEY` for that
tenant and connection, drops the access token, and runs `calendar.google.connect` as the member
the state names, under the reserved key `oauth-google:<connection id>`. That member must still be
an owner. Connecting a resource that already has a connection moves the old one to
`disconnecting`. Every answer is `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

| Answer | When |
|---|---|
| 400 `ValidationFailed` | Missing, forged, tampered or expired `state`. No redirect: nothing proves where the caller came from. |
| 303 to `GOOGLE_RETURN_URL?calendar=connected` | Connected, or a reload of a callback that already connected (the code is not sent again). |
| 303 to `…?calendar=error&reason=denied` | Google sent `error` (the owner declined). |
| `reason=exchange_failed` | No code, or Google refused or did not answer the exchange. |
| `reason=no_refresh_token`, `reason=scope_missing` | Google granted no refresh token, or not `calendar.events`. Nothing is stored. |
| `reason=forbidden` | The member is no longer an owner of the tenant, or the resource is gone. Checked before the code is spent. |
| `reason=conflict` | Another connect for the same resource committed at the same moment. |
| 503 `Unavailable` | The database did not answer. |

## Google Calendar webhook (`/webhooks/google/calendar`, no auth)

Google posts here when a watched calendar changes (G-8). On only when the `GOOGLE_*` variables are
set; the calendar runner opens channels only when `GOOGLE_WEBHOOK_URL` names this route. The route
checks `X-Goog-Channel-Token` against `HMAC-SHA-256(GOOGLE_CHANNEL_SECRET, X-Goog-Channel-ID)` in
constant time before any database work, then stores the channel ID, `X-Goog-Message-Number` and
`X-Goog-Resource-State` once in `calendar_push_notifications`. The body is ignored. The runner marks
the channel's connection due; a push carries no calendar data, so a forged one could only cause an
early sync.

| Answer | When |
|---|---|
| 401 `Unauthorized` | Missing or wrong channel ID or token. One body for all of them. |
| 400 `ValidationFailed` | A valid token with a malformed message number or resource state. |
| 413 `ValidationFailed` | Body over 4 KiB (Google sends none). |
| 503 `Unavailable` | The database did not answer; Google delivers it again. |
| 200 `{"received":true,"stored":…}` | Stored, or already stored. |

## Database pool and request limits

`createServer` (`src/server.ts`) builds the runtime pool with `createRuntimePool` from
`@zs/db`, for both `main.ts` and `vercel.ts`. A lost idle connection (a restart, failover or
network drop) is logged as `Database pool error <SQLSTATE>` without the URL, at most 10 a
minute, and the next request opens a new connection; the process does not exit. A request
waits at most `DATABASE_CONNECT_TIMEOUT_MS` for a connection; when 50 requests already wait,
the next is refused at once. Each `/v1` request has a deadline (`REQUEST_TIMEOUT_MS`) that
also ends when the caller disconnects: its transaction then sends no further statement or
`COMMIT` and rolls back, and the API answers 503 `Unavailable`. Like any failed transaction it
first rolls back to the work savepoint and clears the backend's session state (see "Hosted
deploy"); these recovery statements are not gated by the deadline, only bounded to 2 s each.
Each transaction's statement and lock timeouts are capped at the time left before the
deadline, so Postgres cancels a statement still running when the deadline passes. A statement
still running just after the deadline, or when the caller disconnects, is abandoned: its
connection is closed rather than reused, and the statement ends within that same cap. An
abandoned statement leaves no chance to clear the backend, so once the work has begun it is
reported through `onResetFailure` (logged as `Session reset failed`). The API and MCP send no
`pg_cancel_backend` (`createScopedDatabase`'s `cancel` stays `"none"`; `createServer` sets it
explicitly): behind Supavisor's transaction pooler the backend that ran a statement may
already serve another request. Nothing is committed by a request that answers 503 before its
`COMMIT`. A `COMMIT` abandoned at the deadline (`DatabaseUnavailable("commit_unknown")`) may
have applied; like any 503 write, it replays its committed result when the caller retries
with the same `Idempotency-Key`. The MCP server uses the same pool settings (4 connections).

## Hosted deploy

Projects, URLs and refs are listed in the root `README.md`, "Hosting". Every step is
owner-run from the repo root. Credentials reach the scripts only through the environment,
for example `zsvault run --env NAME=<vault id> -- <command>`, never argv or a file in the repo.
Hosted URLs use the Supavisor pooler `aws-0-us-east-1.pooler.supabase.com`, user
`<role>.<ref>`, database `postgres`, and no query string:
port 5432 (session mode) for roles, migrations, seed and backups (`db:hosted-backup` refuses 6543); port 6543 (transaction
mode) for the API. The scripts check the host, role and ref (`src/hosted.ts`) and verify TLS
against the pinned Supabase Root 2021 CA.

1. **Roles, once per project.** As the project's `postgres` login (`PGPASSWORD`), with
   `ZS_MIGRATOR_PASSWORD` and `ZS_RUNTIME_PASSWORD` (32+ printable ASCII characters) in the
   environment:
   ```sh
   ZS_MIGRATOR_VERIFIER=$(node supabase/hosted/scram-verifier.mjs ZS_MIGRATOR_PASSWORD) \
   ZS_RUNTIME_VERIFIER=$(node supabase/hosted/scram-verifier.mjs ZS_RUNTIME_PASSWORD) \
   psql "host=aws-0-us-east-1.pooler.supabase.com port=5432 user=postgres.<ref> dbname=postgres sslmode=verify-full sslrootcert=supabase/hosted/supabase-root-2021-ca.crt" \
     -X -f supabase/hosted/bootstrap-roles.sql
   ```
   Supabase logs DDL (`log_statement=ddl`), so the server only receives SCRAM-SHA-256
   verifiers, never a plaintext password. The script creates `zs_migrator` (LOGIN
   CREATEROLE; owns every table it creates) and `zs_runtime` (LOGIN, member of
   `authenticated` only), creates `btree_gist`, and asserts that neither role is superuser,
   BYPASSRLS or REPLICATION. A rerun with new passwords rotates both; then update
   `DATABASE_URL` in Vercel and redeploy the API. Every psql and pg_dump call uses
   `sslmode=verify-full` with the pinned CA.
2. **Back up, dry-run, apply.** Back up with the wrapper, which binds the archive to the
   project. With `ZS_TARGET_REF` and `SERVICE_DATABASE_URL` (postgres, port 5432):
   ```sh
   mise exec -- pnpm --filter @zs/api db:hosted-backup --out ~/Backups/zs-business/<ref>-<date>.dump
   ```
   It runs `pg_dump -Fc` of `public`, `zs_internal` and `extensions` (`PG_DUMP` or `PATH`;
   credentials only in pg_dump's own environment, `sslmode=verify-full` with the pinned CA),
   reads the migration ledger before and after (it must not move), and writes
   `<dump>.manifest.json`: project ref, archive name, size, sha256, start time and the full
   ledger with checksums. Neither file may exist yet. Then, with `ZS_TARGET_REF` and
   `MIGRATOR_DATABASE_URL` (zs_migrator, port 5432):
   ```sh
   mise exec -- pnpm --filter @zs/api db:hosted-migrate --dry-run
   mise exec -- pnpm --filter @zs/api db:hosted-migrate --apply --backup <dump> --receipt <file.json>
   ```
   `--apply` first reserves the receipt file (an existing file or a missing folder is refused
   before any database work), then checks the login, dry-runs, and checks the backup. It
   refuses a backup without its manifest, a manifest for another project than
   `ZS_TARGET_REF` (a preview dump with the same tables and ledger fails here), a sha256 or
   size that differs from the file, a manifest or archive older than two hours, a manifest
   ledger that differs from the live one by name or checksum, an archive pg_restore cannot
   read end to end, one that lacks the definition or data of any table now in `public` or
   `zs_internal`, or (for an upgrade) one whose own ledger differs; `pg_restore` comes from
   `PG_RESTORE` or `PATH`. The apply rolls back unless it runs exactly the migrations and
   checksums the dry run reported. Every outcome lands in the receipt: `result`
   (`committed` or `failed`), `failedPhase` (`login-check`, `dry-run`, `backup-check`,
   `apply` or `ledger-check`), the error with connection strings and passwords redacted,
   and `committed`: `false` for any failure before the apply, otherwise read back from the
   ledger (`true`, `false` or `"unknown"`). It also holds migration names, checksums, the
   login's attributes and the backup's size, sha256, creation time and manifest facts, never
   credentials. If the receipt cannot be written, the script prints it to stderr. Use a new
   receipt name for a retry. `--migrations <dir>` points at another directory, for
   rehearsing an upgrade from a partial set. Receipts go outside the repo.
3. **Seed (fake data only).** `ZS_TARGET_REF`, `SERVICE_DATABASE_URL` (postgres, port 5432)
   and `RUNTIME_DATABASE_URL` (zs_runtime): `pnpm --filter @zs/api seed:hosted`. It does not
   migrate and prints ids and counts only. The seed writes through the action path as its own
   owner member, whose user id names no Supabase user, and removes that member when it is
   done (the action history keeps the record). It takes no arguments and never calls
   Supabase Auth or writes a real person's membership: the tenant has no member until step 4
   runs. The summary prints the tenant id and, under `nextSteps`, the exact step 4 commands
   for it (dry run, backup, then apply with a receipt).
4. **Owner.** There is no static token: every person signs in through the dashboard with
   Supabase Auth (an email link), and the API checks each token's session with Supabase Auth
   (`SESSION_CHECK=supabase`). A tenant needs an owner first ("Provision the first owner").
   With `ZS_TARGET_REF`, `SERVICE_DATABASE_URL` (postgres, port 5432) and
   `SUPABASE_SERVICE_ROLE_KEY` (the project's service_role or `sb_secret_` key; a JWT key
   must name `ZS_TARGET_REF` in its `ref` claim):
   ```sh
   mise exec -- pnpm --filter @zs/api db:hosted-provision-owner --tenant <uuid> --email <addr> --dry-run
   mise exec -- pnpm --filter @zs/api db:hosted-backup --out ~/Backups/zs-business/<ref>-<date>.dump
   mise exec -- pnpm --filter @zs/api db:hosted-provision-owner --tenant <uuid> --email <addr> \
     --apply --backup ~/Backups/zs-business/<ref>-<date>.dump --receipt <file.json>
   ```
   The user is found by exact email, and given `app_metadata.tenant_id`, through the Auth
   admin API at `https://<ref>.supabase.co` (never `auth.users`); a user whose claim names
   another tenant is refused. Signups are disabled, so create the user first (Supabase
   dashboard > Authentication > Add user), or run it once to leave a pending owner and again
   to bind. `--apply` takes the same guards as `db:hosted-migrate`: the receipt is reserved
   before any Auth or database call, the backup must pass the same manifest and archive
   checks (this project, under two hours old, the live ledger and every table), and the
   receipt records every outcome (`failedPhase`: `dry-run`, `backup-check`, `apply` or
   `verify`) with ids and role facts only; errors are redacted, and the key is never printed.
5. **Deploy.** From the repo root (`.vercelignore` keeps secrets and build output out of the
   upload), with `VERCEL_TOKEN` in the environment:
   ```sh
   VERCEL_ORG_ID=team_ZovXSbiQdKR8CvRpDYfAzbAr VERCEL_PROJECT_ID=prj_rQtMc5wZyNnH6MnVmFvfRwFepawQ \
     mise exec -- pnpm dlx vercel@latest deploy --yes [--target preview | --prod]   # API
   VERCEL_ORG_ID=team_ZovXSbiQdKR8CvRpDYfAzbAr VERCEL_PROJECT_ID=prj_uTGH5yuyXfr6w9lAihGj1HcDxSdp \
     mise exec -- pnpm dlx vercel@latest deploy --yes [--target preview | --prod]   # dashboard
   ```
   The API builds with `pnpm build:vercel` (`scripts/build-vercel.mjs`): esbuild bundles
   `src/vercel.ts` into one Node 24 function under `.vercel/output` (Build Output API).
   API env per target: `DATABASE_URL` (zs_runtime, port 6543), `DATABASE_CA_CERT`,
   `DATABASE_POOL_MAX=3`, `JWT_VERIFIER` with `JWT_SECRET` or `JWT_JWKS_URL`, `JWT_ISSUER`
   (`https://<ref>.supabase.co/auth/v1`), `SESSION_CHECK=supabase`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, and for public booking `PUBLIC_BOOKING_KEY_SECRET`, `PUBLIC_BASE_URL`
   and `PUBLIC_CLIENT_IP_HEADER=x-vercel-forwarded-for`. The bundle carries `static/` for the
   booking page. Hosted: keep public intake disabled (leave `PUBLIC_BOOKING_KEY_SECRET` unset)
   until a shared limiter is configured; the public rate limits are counted per function instance.
   Dashboard env per target: `ZS_API_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `DASHBOARD_TRUST_PROXY=1`. Both set
   `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the pinned pnpm.
6. **Check.** `pnpm --filter @zs/api check:hosted` runs the negative checks against one
   project and its deploys and exits 1 on any failure: unprivileged runtime login, migrator
   refused at runtime, every SET ROLE / SET SESSION AUTHORIZATION escape refused, forced RLS
   and owner on every tenant table, two-tenant denial in SQL, over HTTP and through the
   dashboard proxy, 200 concurrent pooled transactions (on 10 connections, with `maxWaiting`
   256 so none is refused `busy`; every one must settle and succeed, and a refusal fails with
   its code) and 120 concurrent HTTP requests with no crossover, the runtime URL on the deployment's transport (default Supavisor
   transaction mode, port 6543; pass `-- --expect-transport=session` for 5432; any other
   port fails as unsupported; `-- --abandon-rounds=N` sets the abandoned-transaction probe's
   rounds), a session-contamination probe (in 20 rounds, committed and
   throwing transactions leave a custom setting, `application_name`, a session advisory
   lock, a temp table, a held cursor and a `LISTEN` behind; later transactions must see
   none of it, and must have run on a backend a committed and a throwing transaction used
   first, by `pg_backend_pid()`, or the probe fails with "no handoff observed"), an
   abandoned-transaction probe (below), no failed session cleanup in any scoped transaction (counted through `createScopedDatabase`'s
   `onResetFailure`), and real Supabase sessions over HTTP. It creates two temporary Auth
   users (synthetic `example.com` addresses): A, a `staff` member of tenant A (a temporary
   `tenant_members` row written through `SERVICE_DATABASE_URL`), and B, who claims a random
   tenant and is a member of nothing. Both sign in with a password. A reads tenant A's
   records and `/v1/me`. B gets 403 on every call, also for tenant A's ids. A missing token,
   a wrong issuer, a forged signature, a token minted with `JWT_SECRET` that names no live
   session, and a signed-out session all get 401. The Data API check reads the table list
   from `supabase/migrations/` and from the catalog (`public` and `zs_internal`). As `anon`
   and as user A it first calls an RPC that does not exist: PostgREST checks the token first,
   so only "no such function" (404 `PGRST202`) or "schema not exposed" (406 `PGRST106`) shows
   the Data API accepted it. Then neither may call `record_action_and_event` (sent with
   `Content-Profile` and `Accept-Profile` `public` and every argument), and for every table
   `/rest/v1` must refuse SELECT, INSERT, UPDATE and DELETE. Only these denials pass: 42501
   permission denied (401 or 403), `PGRST106` (406), `PGRST205` or `42P01` table not exposed
   (404), and, for reads, updates and deletes, 200 with no rows. Rejected credentials (401, or
   `PGRST300` to `PGRST303`) fail, since they prove nothing about authorization, and so do
   an outage, an accepted write or a migration table missing from the catalog
   (`src/data-api-probe.ts`). No probe can change a row. Write probes in SQL always roll
   back. The removal of the temporary member and of both users is checked too. Its header
   lists the environment it needs; `VERCEL_PROTECTION_BYPASS` passes Vercel Authentication
   on preview.

   The abandoned-transaction probe ("abandoned in-flight transactions leave no session state
   on reused backends", `abandonedTransactionProbe` in `src/hosted-probes.ts`) covers what the
   local tests cannot: what Supavisor's transaction mode does with a backend whose client
   closed the connection mid-transaction. In 10 rounds, 4 tenant-B transactions each take a
   session advisory lock, `PREPARE` a statement and set a session setting, start a 1 s
   `pg_sleep` and are abandoned through their `AbortSignal` after 100 ms, so
   `createScopedDatabase` closes the connection without cleaning the backend (each is
   reported through `onResetFailure`, counted by this check and not by the session-reset
   check). Once the sleeps end, 12 scoped readers per round check their own backend for the
   lock (`pg_locks`), the statement (`pg_prepared_statements`) and the setting
   (`current_setting`). An observer on a second, plain pool against the runtime URL polls
   once per round and then every 100 ms until no probe lock is held, for at most 5 s. Each
   poll is one `SELECT` that checks its own backend for the same markers and reads
   `pg_locks` for probe locks held by any backend. The observer never runs the scoped
   cleanup, so a dirty backend it lands on stays dirty and is reported, not erased. Every
   reader and poll records its backend pid; `reused` counts those that ran on a backend
   abandoned before them (`reusedBy` splits readers and observer). The result is one of:
   - **clean**: `reused` is above 0 and nothing saw leftover state. The check passes.
   - **contaminated**: a reader or observer poll saw leftover state, or a backend still held
     a probe lock after 5 s. The check fails in either mode. **Switch the runtime
     `DATABASE_URL` to session mode (port 5432) and run the checks with
     `-- --expect-transport=session` until the cause is fixed.**
   - **inconclusive**: nothing saw leftover state, but nothing ran on an abandoned backend
     either (`reused: 0`, for example because Supavisor destroyed those backends), or the
     abandonments did not happen as planned. Nothing is proven, so in transaction mode the
     check fails. Rerun with more rounds, for example
     `pnpm --filter @zs/api check:hosted -- --abandon-rounds=40` (1 to 200; default 10). If
     reuse never shows, switch to session mode as above. In session mode an inconclusive
     result passes when the only reason is `reused: 0`.

   The check's `verdict` field states the result and the next step. On direct Postgres the
   backend ends with its connection, so the local test sees `inconclusive`; simulated
   poolers in `test/hosted-probes.test.ts` cover the clean and contaminated cases. The hub
   (Devin's Mac) runs `check:hosted` against the Supabase preview branch, with
   `ZS_TARGET_REF` and the three database URLs set to that branch; cloud sessions and CI
   never run it.

Hosted settings that the scripts do not manage:
- The Data API (PostgREST) exposes only `graphql_public`; tenant tables are not reachable
  through it even before RLS.
- Supabase Auth: signups disabled, custom SMTP through Resend (`smtp.resend.com:465`, a
  sending-only key for `mail.zerosumsolutions.com`), site URL and redirect allow list set to
  the dashboard origin. GoTrue cannot set Reply-To, so the email text names
  devin@zerosumsolutions.com.
- The API project has no Vercel Authentication (its callers are the dashboard and MCP
  clients, which present a bearer token). Dashboard previews are protected; pass the
  `x-vercel-protection-bypass` header for automated checks.
- The dashboard's sign-in attempt limiter is in memory, so on Vercel each serverless
  instance counts on its own; Supabase Auth's own email rate limit still bounds the links sent.

## Delivery runner (`/cron/delivery`, `pnpm delivery:worker`)

Runs the delivery worker, so an approved Inbox reply is sent (resend.md R-9). Off unless
`DELIVERY_WORKER=on`.

| Variable | Meaning |
|---|---|
| `DELIVERY_WORKER` | Kill switch. `on` runs; anything else, or unset, runs nothing. |
| `CRON_SECRET` | 32+ characters. Vercel Cron sends it as `Authorization: Bearer …`. Unset, the route is 404. |
| `DELIVERY_DATABASE_URL` | A login that may `SET ROLE service_role` (postgres on hosted Supabase), never the runtime login. Non-loopback hosts need `DATABASE_CA_CERT` and no query string. |
| `DELIVERY_PRICE_EMAIL`, `DELIVERY_PRICE_SMS_SEGMENT`, `DELIVERY_CURRENCY` | What one email and one SMS segment take from the wallet, in minor units (`usd` by default). |
| `UNSUBSCRIBE_TOKEN_SECRET`, `DELIVERY_UNSUBSCRIBE_BASE_URL` | Signs the List-Unsubscribe links; the same secret as the API. The URL is the https address of `/public/v1/unsubscribe`. |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`, `RESEND_BASE_URL` | The Resend sender (R-6). `RESEND_FROM` must be on a domain verified in Resend. |
| `DELIVERY_RUN_BUDGET_MS`, `DELIVERY_CLAIM_LIMIT`, `DELIVERY_PROVIDER_TIMEOUT_MS`, `DELIVERY_INTERVAL_MS`, `DELIVERY_WORKER_ID` | Optional tuning: 20000, 2, 5000, 15000 (Node worker only) and `delivery`. Limit × (timeout + 500 ms) + 1 s must fit the budget; the cron function allows at most 20000. |
| `DELIVERY_CRON_SCHEDULE` | Build time only. Adds the Vercel cron for `/cron/delivery`, for example `*/5 * * * *`. Unset, there is no cron. |

`GET /cron/delivery` answers 401 without the right bearer, 200 `{ ran: false }` with the switch
off, 200 `{ ran: true, passes, ingested, claimed, sent, retried, blocked, dead, errors,
budgetSpent }` after a run, and 503 when a run fails (the next run picks the work up again).
It is its own Vercel function; the API function never opens the service login.

## Billing runner (`/cron/billing`, `pnpm billing:worker`)

Applies stored Stripe events to wallets (stripe.md S-4..S-8): a paid top-up credits once, a
refund or dispute takes money back without the balance going negative (the rest is `owed`,
and the wallet reserves nothing until it is repaid). Off unless `BILLING_WORKER=on`.

| Variable | Meaning |
|---|---|
| `BILLING_WORKER` | Kill switch. `on` runs; anything else, or unset, runs nothing. |
| `CRON_SECRET` | The same bearer as `/cron/delivery`. Unset, the route is 404. |
| `BILLING_DATABASE_URL` | A login that may `SET ROLE service_role`, never the runtime login. Non-loopback hosts need `DATABASE_CA_CERT` and no query string. |
| `BILLING_CLAIM_LIMIT`, `BILLING_RUN_BUDGET_MS`, `BILLING_INTERVAL_MS` | Optional tuning: 50, 20000 and 30000 (Node worker only). The cron function allows a budget of at most 20000. |
| `BILLING_CRON_SCHEDULE` | Build time only. Adds the Vercel cron for `/cron/billing`. Unset, there is no cron. |

`GET /cron/billing` answers like `/cron/delivery`, with `{ ran: true, passes, claimed,
outcomes, budgetSpent }` after a run. Events that end `mismatch`, `orphaned` or `not_ours` are
logged for an operator.

## Calendar runner (`/cron/calendar`, `pnpm calendar:worker`)

Runs the Google Calendar worker (google-calendar.md G-6..G-10): it syncs busy time from each active
connection into external blocks, keeps one push channel per connection when `GOOGLE_WEBHOOK_URL`
is set, pushes confirmed bookings to the calendar as events, and cleans up disconnecting
connections (revoke, remove blocks). It alone holds the token private key. Off unless
`CALENDAR_WORKER=on`.

| Variable | Meaning |
|---|---|
| `CALENDAR_WORKER` | Kill switch. `on` runs; anything else, or unset, runs nothing. |
| `CRON_SECRET` | The same bearer as `/cron/delivery`. Unset, the route is 404. |
| `CALENDAR_DATABASE_URL` | A login that may `SET ROLE service_role`, never the runtime login. Non-loopback hosts need `DATABASE_CA_CERT` and no query string. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The same OAuth client as the API. |
| `GOOGLE_TOKEN_PRIVATE_KEY` | Base64 of the DER PKCS#8 of the X25519 key whose public half is the API's `GOOGLE_TOKEN_PUBLIC_KEY`. Only this function holds it. |
| `GOOGLE_CHANNEL_SECRET` | The same channel secret as the API (32+ characters). |
| `GOOGLE_WEBHOOK_URL` | Optional: `https://<api host>/webhooks/google/calendar`. Unset, no channels are opened and syncs run on the poll interval only. |
| `GOOGLE_EVENT_TITLE` | Optional: the title of every pushed event, default `Booked`. No customer data. |
| `GOOGLE_OAUTH_BASE_URL`, `GOOGLE_TOKEN_BASE_URL`, `GOOGLE_API_BASE_URL` | Optional, for tests. |
| `CALENDAR_RUN_BUDGET_MS`, `CALENDAR_INTERVAL_MS` | Optional tuning: 20000 and 60000 (Node worker only). The cron function allows a budget of at most 20000. |
| `CALENDAR_CRON_SCHEDULE` | Build time only. Adds the Vercel cron for `/cron/calendar`. Unset, there is no cron. |

`GET /cron/calendar` answers like `/cron/delivery`, with `{ ran: true, passes, counts,
budgetSpent }` after a run: `counts` sums the worker's passes (`synced`, `pushed`, `disconnected`,
`channelsOpened`, …). A run makes passes until one moves nothing or the budget is spent.
Reauthorize, failed syncs, failed pushes and channel failures are logged for an operator.
