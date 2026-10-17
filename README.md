# zs-business

Business service for the Zero Sum Business OS: CRM, booking, inbox, automations,
approvals and the owner dashboard. Mish (public, Apache-2.0) stays the front door and site
builder and calls this service over HTTP and MCP. No authoritative business records live in Mish.

Status: empty. First work is a booking authority and a CRM transaction slice.
Plan: `/Users/zero-suminc./Inbox/plans/_unassigned/2026-10/2026-10-17-complete-product-assembly.md`.

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
access. `@zs/core` exports `createDispatcher(handlers)`; only tests register a handler.
Booking and CRM tests currently pass with no tests.

Tests default to the dedicated local Postgres at
`postgres://postgres@127.0.0.1:55432/postgres`. `ZS_TEST_DATABASE_URL` accepts a
loopback host (`localhost`, `127.x.x.x`, or `::1`), an explicit port other than
5432/54322, and optional admin credentials. It requires `/postgres` and rejects URL
options. Run this task's tests on the default cluster only. The harness creates a
unique `zs_test_<uuid>` database and drops it after success or failure.

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
outbox `seq` for ordering and `processed_at` for delivery progress. Administrative
migrations force RLS, revoke direct runtime history writes and tenant renames, and
fail on unsafe existing role attributes. Isolation tests discover every public
table with `tenant_id` through the catalog and seed scalar/default/FK fixtures;
unsupported fixture constraints fail the test rather than skip the table.
