# zs-business

Business service for the Zero Sum Business OS: CRM, booking, inbox, automations,
approvals and the owner dashboard. Mish (public, Apache-2.0) stays the front door and site
builder and calls this service over HTTP and MCP. No authoritative business records live in Mish.

Status: the shared action path, booking (F1) and CRM (F2) are implemented. M1 adds the
HTTP API (`apps/api`) and the MCP adapter (`packages/mcp`) over them. Requirements live in
`docs/requirements/booking.md` and `docs/requirements/crm.md`.
Plan: `/Users/zero-suminc./Inbox/plans/_unassigned/2026-10/2026-10-17-complete-product-assembly.md`.

## Hosting (M2b)

Pilot data only (the invented Halden & Rowe tenant). Everything is in US East.

| Piece | Production | Preview |
|---|---|---|
| Supabase project (org Zerosumsolutions-Projects, Micro, Postgres 17) | `zs-business`, ref `ubzyxrflvxymikpijnto` | `zs-business-preview`, ref `cmpnzcijdumzyddoubga` |
| API (Vercel `zs-business-api`, root `apps/api`) | https://api.zerosumsolutions.com | https://zs-business-api-preview.vercel.app |
| Dashboard (Vercel `zs-business-dashboard`, root `apps/dashboard`) | https://app.zerosumsolutions.com | https://zs-business-dashboard-preview.vercel.app (Vercel Authentication on) |
| Auth email (Supabase custom SMTP through Resend) | `no-reply@mail.zerosumsolutions.com` | same |

Each deploy uses only its own database: the preview API's `DATABASE_URL` names the preview
ref, and the preview dashboard's `ZS_API_URL` is the preview API. DNS is on Cloudflare
(`app`/`api` CNAMEs to Vercel, DNS only; Resend DKIM, SPF, MX and DMARC under `mail`).
Secrets live in ZS Vault (`zs_business_<prod|preview>_*`) and in Vercel env vars, never in
the repo. The runbook (roles, migrations, seed, tokens, deploy, checks) is in
`apps/api/README.md`, "Hosted deploy".

## Development

Use the pinned Node and pnpm versions through mise:

```sh
mise exec -- pnpm install
mise exec -- pnpm -r typecheck
mise exec -- pnpm -r test
mise exec -- pnpm --filter @zs/core test:booking
mise exec -- pnpm --filter @zs/core test:crm
```

`@zs/contracts` owns zod action types and stable error codes. `@zs/db` owns the
Drizzle schema, SQL migration runner (`migrate(pool)`), and transaction-scoped tenant
access. `@zs/core` exports `createDispatcher(handlers)`, `bookingHandlers` and
`crmHandlers`. The server composes them with `createDispatcher({ ...bookingHandlers, ...crmHandlers })`;
`createSession(deps, principal)` in `@zs/core` binds that dispatcher, the contracts
request schemas and the tenant-scoped reads to one verified principal for both edges.
Each principal must be a member of its tenant (`tenant_members`, roles `owner` and
`staff`); the session checks the member's role against the action or read before it runs,
and only owners invite, remove or change roles.
Baseline `test` excludes the booking and CRM folders; `test:booking` and `test:crm` run
them. The SQL seed/read contracts are B-28 and C-24 in the requirements.

`apps/api` (`@zs/api`) is the Hono HTTP API; see `apps/api/README.md` for routes, auth,
errors and the local demo seed. `packages/mcp` (`@zs/mcp`) exposes the same writes and
reads as MCP tools over stdio.
`apps/dashboard` (`@zs/dashboard`) is the owner's phone-first PWA over that API. Live mode
signs people in with a Supabase Auth email link and sends each person's own token; demo
mode (no `ZS_API_URL`) needs no sign-in. See `apps/dashboard/README.md`.

Tests default to the dedicated local Postgres at
`postgres://postgres@127.0.0.1:55432/postgres`. `ZS_TEST_DATABASE_URL` accepts a
loopback host (`localhost`, `127.x.x.x`, or `::1`), an explicit port other than
5432/54322, and optional admin credentials. It requires `/postgres` and rejects URL
options. Run this task's tests on the default cluster only. The harness creates a
unique `zs_test_<uuid>` database and drops it after success or failure.

Migrations support PostgreSQL 15 and 16+ (some hosted Supabase projects still run 15).
CI also runs `pnpm -r test` against `postgres:15` on port 55433. Locally:
`docker run -d --rm --name zs-pg15 -p 127.0.0.1:55433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:15`,
then `ZS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres pnpm -r test`.

`@zs/db/testing` exports `createTwoTenantFixture` and `withTestDatabase`. The harness
provisions `zs_runtime` (LOGIN, member of `authenticated` only) and `zs_service`
(LOGIN, member of `service_role`) idempotently. Both use the test cluster's trust
authentication. `TestDatabase.pool` is administrative; `runtimePool` and
`servicePool` use separate credentials. Production adapters must supply separate
runtime and service LOGIN credentials. `createScopedDatabase` rejects privileged
runtime sessions; `RESET ROLE` cannot recover a privileged login.

Pass a trusted server context with actor, tenant, clock, config, database, approval
resolver, and `generateId: () => string`. Mint UUIDs at the server edge. For a create
action, pre-mint the target ID and include it in both the command and approval.
`resolveTarget` must verify the target's tenant, type, and ID from authoritative
state in the supplied transaction. For an existing target, it must load the owned
row. For a create, it must verify the parent or creation scope, confirm the ID is
unused in that scope, and return the pre-minted target. Echoing unverified input
does not establish ownership. The handler's insert constraint must also protect
against concurrent creates.

Every command requires an approval reference. `resolveApproval` must return the
full approved binding. The dispatcher verifies it and a unique tenant/approval-ID
index permits one committed action per approval; reuse with another key returns
`Conflict`. A replay of the original key returns its stored result. Caller-supplied
context is not trusted.

Register `ActionHandler<Config>` values with `createDispatcher<Config>(handlers)`
using your config type. Handlers return `{ result, event?: { type, payload } }`.
Without an event, the dispatcher uses the action type and emits the action ID,
target, and result. `mapError(error)` may return an `ActionError` for a domain
failure, or `undefined` to use shared mapping. SQL exclusion/unique violations
(`23P01`/`23505`) map to `Conflict` with `details.constraint` and
`details.postgresCode`. `@zs/contracts` exports `ActionError` and `ActionErrorCode`.
Write state through the supplied transaction and put external effects in outbox
consumers.

Idempotency lives in `actions`, with a unique `(tenant_id, idempotency_key)` and a
stored JSON result. Transaction locks serialize retries; JSON object key order
does not change payload identity. Actor, action type, target, and approval must
also match on replay. Scoped transactions default to a 5-second lock timeout and
15-second statement timeout, configurable through `createScopedDatabase(pool, limits)`.
State, action, and one outbox event commit together. Runtime grants permit reads;
the dispatcher writes history through `record_action_and_event`, a narrow
SECURITY DEFINER function whose owner obeys forced RLS. Privileged workers use
outbox `processed_at` for delivery progress and `seq` only to order the rows they can see.
`seq` is handed out at insert, not at commit, so a lower `seq` can commit after a higher
one: a worker must never keep a "highest seq seen" mark. It claims unprocessed rows (row
locks or leases, `FOR UPDATE SKIP LOCKED`), records per-row delivery state and provider
dedupe keys, and retries rows whose outcome is uncertain
(`packages/db/test/outbox-order.test.ts` shows the inverted commit). Administrative
migrations force RLS, revoke direct runtime history writes and tenant renames, and
fail on unsafe existing role attributes. Isolation tests discover every public
table with `tenant_id` through the catalog and seed scalar/default/FK fixtures;
unsupported fixture constraints fail the test rather than skip the table.
