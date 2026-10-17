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

Tests use only the dedicated local Postgres at
`postgres://postgres@127.0.0.1:55432/postgres`. `ZS_TEST_DATABASE_URL` may supply
credentials for that same endpoint; other hosts, ports, database names, and URL
options are rejected. Each suite creates a unique `zs_test_<uuid>` database and drops
it in teardown. `withTestDatabase` also cleans up when its callback throws. Helpers
are exported from `@zs/db/testing`, including `createTwoTenantFixture` with runtime
handles for A/B and a separate privileged service handle.

The dispatcher takes a trusted server context: actor, tenant, clock, config, database,
and approval resolver. Handlers resolve target ownership from authoritative state
inside the tenant transaction. Approval references resolve to the entire approved
binding. Every command requires a reference. The trusted resolver may lock or consume
an approval in this transaction; issuance and consumption policy belong to later
server adapters. Caller-supplied context is not trusted.
Handlers must write state through their supplied transaction and keep external side
effects in outbox consumers.

Idempotency lives in `actions`, with a unique `(tenant_id, idempotency_key)` and a
stored JSON result. Transaction locks serialize retries; JSON object key order does
not change payload identity. Actor, action type, target, and approval must also match
on replay. Scoped transactions default to a 5-second lock timeout and 15-second
statement timeout, configurable through `createScopedDatabase(pool, limits)`.
State, action, and one outbox event commit together. Runtime grants allow
history inserts and reads; privileged workers manage outbox delivery. SQL migrations
force RLS on every tenant table. Cluster roles are created idempotently and existing
unsafe role attributes fail migration instead of being changed.
