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
| `JWT_MAX_TTL_SECONDS` | Longest accepted token lifetime (`exp` minus `iat`), default 3600. Local dev sets 604800 so the 7-day seed token works for seed and dashboard e2e; production keeps the default. |
| `JWT_CLOCK_SKEW_SECONDS` | How far a token's `iat` may lie ahead of the API's clock, 0 to 300, default 60. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins, for example the dashboard dev server. |
| `PORT` | Listen port, default 8787. |
| `RUNTIME_DATABASE_URL` | Seed only, optional: runtime login URL; defaults to `DATABASE_URL` as `zs_runtime`. |
| `DATABASE_CA_CERT` | PEM. When set, the pool verifies the server against it (`rejectUnauthorized`). Required whenever `DATABASE_URL` is not a loopback host (`127.0.0.1`, `::1`, `localhost`), so a hosted API never falls back to plain TCP; only a loopback database runs without TLS. A non-loopback URL, or any URL with a CA, must carry no query string, because pg lets URL ssl options (`sslmode=no-verify`, `ssl=false`, a `host` override) replace the config. Hosted: `supabase/hosted/supabase-root-2021-ca.crt`. |
| `DATABASE_POOL_MAX` | Pool size per process, 1 to 50, default 10. Vercel sets 3: each serverless instance has its own pool. |

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

## Hosted deploy

Projects, URLs and refs are listed in the root `README.md`, "Hosting". Every step is
owner-run from the repo root. Credentials reach the scripts only through the environment,
for example `zsvault run --env NAME=<vault id> -- <command>`, never argv or a file in the repo.
Hosted URLs use the Supavisor pooler `aws-0-us-east-1.pooler.supabase.com`, user
`<role>.<ref>`, database `postgres`, and no query string:
port 5432 (session mode) for roles, migrations, seed and backups; port 6543 (transaction
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
2. **Back up, dry-run, apply.** Take a `pg_dump -Fc` of `public`, `zs_internal` and
   `extensions` into `~/Backups/zs-business/`, then, with `ZS_TARGET_REF` and
   `MIGRATOR_DATABASE_URL` (zs_migrator, port 5432):
   ```sh
   mise exec -- pnpm --filter @zs/api db:hosted-migrate --dry-run
   mise exec -- pnpm --filter @zs/api db:hosted-migrate --apply --backup <dump> --receipt <file.json>
   ```
   `--apply` dry-runs first. It refuses a backup that is not a custom-format archive
   pg_restore can read end to end, that is older than two hours, that lacks the definition
   or data of any table now in `public` or `zs_internal`, or (for an upgrade) whose
   migration ledger differs from the database's; `pg_restore` comes from `PG_RESTORE` or
   `PATH`. It reserves the receipt file before anything commits (an existing file is
   refused), and the apply rolls back unless it runs exactly the migrations and checksums the
   dry run reported. The receipt holds migration names, checksums, the login's attributes and
   the backup's size, sha256 and creation time, never credentials. If the receipt cannot be
   written, the script prints it to stderr. A failed apply still leaves its receipt, with
   `result: "failed"` and `committed` read back from the ledger (`true`, `false` or
   `"unknown"`); use a new receipt name for the retry. `--migrations <dir>` points at another
   directory, for rehearsing an upgrade from a partial set. Receipts go outside the repo.
3. **Seed (fake data only).** `ZS_TARGET_REF`, `SERVICE_DATABASE_URL` (postgres, port 5432)
   and `RUNTIME_DATABASE_URL` (zs_runtime): `pnpm --filter @zs/api seed:hosted`. It does not
   migrate and prints ids and counts only.
4. **Tokens.** Until M2a auth lands, the dashboard calls the API with one static owner token
   (`ZS_API_TOKEN`), HS256, issuer `https://api.zerosumsolutions.com/pilot`, at most 30 days
   (the API's `JWT_MAX_TTL_SECONDS=2592000`). The mint script refuses to print to a
   terminal. Mint into a shell variable first, so a failed mint never
   writes an empty value, and use `pnpm -s` so no pnpm banner lands in it:
   ```sh
   T=$(JWT_SECRET=… JWT_ISSUER=… ZS_TOKEN_TENANT_ID=… ZS_TOKEN_SUBJECT=… ZS_TOKEN_TTL_SECONDS=2592000 \
     mise exec -- pnpm -s --filter @zs/api token:mint) && [ -n "$T" ] && \
     printf '%s' "$T" | zsvault edit <id> --yes --value-stdin; unset T
   ```
   For a new entry use `zsvault add <id> --type plain_secret --yes --value-stdin`.
   To rotate, mint a new token, set it as the dashboard's `ZS_API_TOKEN` for that target, and
   redeploy the dashboard. Rotating `JWT_SECRET` invalidates every token at once.
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
   `DATABASE_POOL_MAX=3`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_MAX_TTL_SECONDS=2592000`.
   Dashboard env per target: `ZS_API_URL`, `ZS_API_TOKEN`, `DASHBOARD_ACCESS_CODE`,
   `DASHBOARD_SESSION_SECRET`, `DASHBOARD_TRUST_PROXY=1`. Both set
   `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the pinned pnpm.
6. **Check.** `pnpm --filter @zs/api check:hosted` runs the negative checks against one
   project and its deploys and exits 1 on any failure: unprivileged runtime login, migrator
   refused at runtime, every SET ROLE / SET SESSION AUTHORIZATION escape refused, forced RLS
   and owner on every tenant table, two-tenant denial in SQL, over HTTP and through the
   dashboard proxy, 200 concurrent pooled transactions and 120 concurrent HTTP requests with
   no crossover, bad tokens 401, and the Data API reading nothing (only an explicit denial
   or an empty result passes; an outage fails). Write probes always roll back, and the
   temporary Auth user's deletion is checked too. Its header lists the
   environment it needs; `VERCEL_PROTECTION_BYPASS` passes Vercel Authentication on preview.

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
  instance counts on its own; the pilot access code must stay long and random.
