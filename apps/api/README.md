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
| `ALLOWED_ORIGINS` | Comma-separated CORS origins, for example the dashboard dev server. |
| `PORT` | Listen port, default 8787. |
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

Then, on every request, in one transaction:

1. **Live session.** `auth_session_is_live(session_id, sub, now)` must find the row in
   `auth.sessions` for that user, not past `not_after`, with the user neither banned nor
   deleted. Otherwise 401 `Unauthorized`. Supabase deletes the row on sign-out, so a token
   is refused at once after sign-out, not at its `exp`. The function is SECURITY DEFINER,
   owned by the NOLOGIN role `zs_session_reader`, which alone may read three columns of
   `auth.sessions` and `auth.users`; the runtime role cannot read `auth.*`.
2. **Membership.** `tenant_members` must hold an active row for `sub` in the claimed tenant.
   Otherwise 403 `Forbidden`, answered like another tenant's row. A removed member is
   refused on the next request, including a replay of an earlier idempotency key: the
   check runs before the replay lookup.
3. **Role.** The member's role must allow the route. `owner` may do everything: members,
   billing, plan and publish. `staff` may use the calendar, customers and inbox drafts
   (`ROLE_PERMISSIONS` in `@zs/contracts`). Otherwise 403.

Member writes hold an exclusive per-tenant advisory lock and every other request a shared
one, so a role change or removal is never interleaved with a request it affects. Plain
Postgres has no `auth` schema: tests and `seed:demo` install a loopback-only stub
(`@zs/db/local-auth`); migrations only grant on it when it exists. On Supabase the role that
runs migrations needs `GRANT ... WITH GRANT OPTION` on `auth.sessions` and `auth.users`, or
the migration fails loudly.

The signing method is explicit config, never inferred from the token: `JWT_VERIFIER=hs256`
accepts only HS256 tokens signed with `JWT_SECRET`; `JWT_VERIFIER=jwks` accepts only ES256 or
RS256 tokens signed by a key in `JWT_JWKS_URL` (fetched and cached by `jose`'s
`createRemoteJWKSet`), so an HS256 token is refused there and an ES256 token under `hs256`.
`parseServerEnv` parses the `JWT_*` variables with `jwtEnvSchema` from `@zs/core` and `main.ts`
builds the verifier with `createVerifierFromConfig(env.jwt, clock)`.

The verifiers (`createHs256Verifier`, `createJwksVerifier`) and the steps above live in
`@zs/core` (`edge/auth.ts`, and `authenticate(deps, verifier, token)` in
`edge/authenticate.ts`), so the MCP server runs exactly the same checks on every tool call.
`src/auth.ts` re-exports them.

## Routes (`/v1`, JSON)

| Method and path | Result |
|---|---|
| `GET /healthz` | `{ ok: true }`, no auth |
| `GET /v1/booking/resources` | `{ items: ResourceSummary[] }` |
| `GET /v1/booking/slots?resourceId&from&to[&zone]` | free slots; `from`/`to` are UTC instants with milliseconds, at most 31 days |
| `GET /v1/booking/bookings?[resourceId&]limit&offset` | page of bookings |
| `POST /v1/booking/bookings` `{ resourceId, startsAt }` | 201 booking; 409 if the slot is taken |
| `GET /v1/crm/contacts?limit&offset` | page of contacts |
| `POST /v1/crm/contacts` `{ displayName?, email?, phone?, mode?, consent? }` | 201 created, 200 matched an existing contact |
| `GET /v1/crm/pipelines` | `{ items: PipelineSummary[] }` with ordered stages |
| `GET /v1/crm/deals?[pipelineId&]limit&offset` | page of deals |
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
`Internal` 500 with no internal detail. Each code has one fixed `message`.
