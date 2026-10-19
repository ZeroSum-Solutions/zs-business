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
Design, Deposit, Delivered), 8 deals and 6 bookings.

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
After the row commits, the step sets that claim on the bound user (keeping other
`app_metadata` keys) and refuses a user whose claim already names another tenant. The user
signs in again to get a token with the claim. If setting the claim fails, the row stays
committed and a re-run sets it (`claimed`). An `--apply` run reads both the row and the claim
back.

Locally the Supabase user is looked up, and given the claim, in the auth stub's `auth.users`. The hosted entry point
(Supabase Auth admin API, `SERVICE_DATABASE_URL`) arrives with the M2b hosting scripts, and
the hosted seed must then create the demo tenant's owner member too.

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
| `DATABASE_POOL_MAX` | Runtime pool size, default 10. |
| `DATABASE_CONNECT_TIMEOUT_MS` | Longest wait for a pooled connection, default 5000. Past it the request is 503. |
| `REQUEST_TIMEOUT_MS` | Longest time a `/v1` request may take, default 10000 (under the dashboard proxy's 15 s). Past it the request is 503. |
| `RUNTIME_DATABASE_URL` | Seed only, optional: runtime login URL; defaults to `DATABASE_URL` as `zs_runtime`. |

Only `src/main.ts` and the `src/scripts/*` entry points read the environment or the system
clock. Everything else gets them through `createApp(deps)`.

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
   answer, a timeout or a network error fails closed with 500 `Internal`, never 401, so the
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
   billing, plan and publish. `staff` may use the calendar, customers and inbox drafts
   (`ROLE_PERMISSIONS` in `@zs/contracts`). Otherwise 403.

Member writes hold an exclusive per-tenant advisory lock and every other request a shared
one, so a role change or removal is never interleaved with a request it affects.

The signing method is explicit config, never inferred from the token: `JWT_VERIFIER=hs256`
accepts only HS256 tokens signed with `JWT_SECRET`; `JWT_VERIFIER=jwks` accepts only ES256 or
RS256 tokens signed by a key in `JWT_JWKS_URL` (fetched and cached by `jose`'s
`createRemoteJWKSet`), so an HS256 token is refused there and an ES256 token under `hs256`.
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
| `GET /v1/crm/pipelines` | `{ items: PipelineSummary[] }` with ordered stages |
| `GET /v1/crm/deals?[pipelineId&][contactId&]limit&(cursor|offset)` | page of deals, most recently updated first |
| `POST /v1/crm/deals` `{ contactId, pipelineId, stageId, title }` | 201 deal |
| `POST /v1/crm/deals/:id/stage` `{ pipelineId, stageId, expectedRevision }` | 200 deal; 409 `stale_revision` |
| `GET /v1/me` | `{ tenantId, userId, memberId, role, permissions }`, any member |
| `GET /v1/members` | `{ items: Member[] }`, owners only |
| `POST /v1/members` `{ email, role }` | 201 pending invite (no user yet); 409 `member_exists`; owners only |
| `POST /v1/members/:id/role` `{ role }` | 200 member; 409 `last_owner` when it would leave no owner; owners only |
| `DELETE /v1/members/:id` | 200 removed member; 409 `last_owner`; owners only |

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
`concurrent_update`, `split_identity`, `identity_mismatch`, `last_owner`, `member_exists`;
anything else is `conflict`),
`Internal` 500 with no internal detail, `Unavailable` 503 with `Retry-After: 1`. Each code has
one fixed `message`.

## Database pool and request limits

`main.ts` builds the runtime pool with `createRuntimePool` from `@zs/db`. A lost idle
connection (a restart, failover or network drop) is logged as `Database pool error <SQLSTATE>`
without the URL, at most 10 a minute, and the next request opens a new connection; the
process does not exit. A request waits at most `DATABASE_CONNECT_TIMEOUT_MS` for a connection;
when 50 requests already wait, the next is refused at once. Each `/v1` request has a deadline
(`REQUEST_TIMEOUT_MS`) that also ends when the caller disconnects: its transaction then sends
no further statement or `COMMIT` and rolls back, and the API answers 503 `Unavailable`. Each
transaction's statement and lock timeouts are capped at the time left before the deadline, so
Postgres cancels a statement still running when the deadline passes. A statement still
running just after the deadline, or when the caller disconnects, is abandoned: its connection is
closed rather than reused, and the statement ends within that same cap. The API and MCP send no
`pg_cancel_backend` (`createScopedDatabase`'s `cancel` stays `"none"`): behind Supavisor's
transaction pooler the backend that ran a statement may already serve another request. Nothing
is committed by a request that answers 503 before its `COMMIT`. A `COMMIT` abandoned at the
deadline (`DatabaseUnavailable("commit_unknown")`) may have applied; like any 503 write, it
replays its committed result when the caller retries with the same `Idempotency-Key`. The MCP server uses the same pool
settings (4 connections).
