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
sed "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" apps/api/.env.example > apps/api/.env
set -a; . apps/api/.env; set +a

# 4. Seed the demo jeweler and print a 7-day dev JWT. It also runs migrations and makes sure
#    the unprivileged zs_runtime login exists. JWT_SECRET must match the API's.
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
| `JWT_SECRET` | HS256 secret for Supabase-style access tokens (32+ characters). The `.env.example` placeholder is refused. |
| `JWT_ISSUER` | Optional. When set, tokens must carry this `iss`. |
| `JWT_MAX_TTL_SECONDS` | Longest accepted token lifetime, default 3600. Local dev sets 604800 so the 7-day seed token works for seed and dashboard e2e; production keeps the default. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins, for example the dashboard dev server. |
| `PORT` | Listen port, default 8787. |
| `RUNTIME_DATABASE_URL` | Seed only, optional: runtime login URL; defaults to `DATABASE_URL` as `zs_runtime`. |

Only `src/main.ts` and the `src/scripts/*` entry points read the environment or the system
clock. Everything else gets them through `createApp(deps)`.

## Auth

`Authorization: Bearer <JWT>`, verified like a Supabase Auth access token: signature, `exp`,
`aud = authenticated`, `role = authenticated`, `iss` when `JWT_ISSUER` is set, and a lifetime
(`exp` minus `iat`, or minus now when `iat` is absent or later) of at most `JWT_MAX_TTL_SECONDS`.
`sub` is the actor and `app_metadata.tenant_id` is the tenant. HS256
uses `createHs256Verifier(secret, { clock })`; for asymmetric Supabase signing keys pass
`createJwksVerifier(createRemoteJWKSet(new URL(".../auth/v1/.well-known/jwks.json")), { clock })`.

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

Every `POST` needs an `Idempotency-Key` header (1-200 characters). Repeating a request with
the same key returns the stored result with the original status; reusing a key with a
different body, or on another endpoint, is 409 `idempotency_key_reused`. Keys are per tenant.
Target IDs derive from the tenant and the key.

Errors always use `apiErrorBodySchema` from `@zs/contracts`:
`{ "error": { "code", "message", "details" } }`. Codes and statuses: `ValidationFailed` 400,
`Unauthorized` 401, `Forbidden` 403 (another tenant's row or an unknown ID, answered alike),
`NotFound` 404, `Conflict` 409 (`details.reason`: `slot_unavailable`, `overlap`,
`stale_revision`, `id_in_use`, `idempotency_key_reused`, `binding_mismatch`,
`concurrent_update`, `split_identity`, `identity_mismatch`; anything else is `conflict`),
`Internal` 500 with no internal detail. Each code has one fixed `message`.
